const APPOINTMENT_REMINDER_TYPE_ = 'APPOINTMENT_DUE';

/** Daily entry point. One persisted tuple owns each order appointment cycle. */
function processAppointmentDueReminders() {
  if (!appointmentSettingEnabled_('APPOINTMENT_REMINDER_ENABLED', true)) return { sent: 0, failed: 0, skipped: 0, disabled: true };
  const now = new Date();
  const today = appointmentLocalDate_(now);
  const due = readRecords_('OrderHeaders', { predicate: function (order) {
    return String(order.RequiredDate || '') === today && isAppointmentReminderEligible_(order);
  } });
  const summary = { sent: 0, failed: 0, skipped: 0 };
  due.forEach(function (order) {
    const outcome = processOneAppointmentReminder_(order, now);
    if (outcome === 'SUCCESS') summary.sent += 1;
    else if (outcome === 'FAILED' || outcome === 'UNCERTAIN') summary.failed += 1;
    else summary.skipped += 1;
  });
  return summary;
}

function processOneAppointmentReminder_(candidate, now) {
  const lock = LockService.getScriptLock();
  let plan = null;
  lock.waitLock(30000);
  try {
    const order = findOrderHeader_(candidate.OrderID);
    if (!order || String(order.RequiredDate || '') !== appointmentLocalDate_(now) || !isAppointmentReminderEligible_(order)) return 'SKIPPED';
    if (findAppointmentReminderTuple_(order.OrderID, order.AppointmentSequence, APPOINTMENT_REMINDER_TYPE_)) return 'SKIPPED';
    const reminder = {
      ReminderLogID: 'APRM-' + Utilities.getUuid(), OrderID: String(order.OrderID), AppointmentSequence: Number(order.AppointmentSequence || 0),
      AppointmentDate: String(order.RequiredDate || ''), ReminderType: APPOINTMENT_REMINDER_TYPE_, Recipient: '', CC: '', SentAt: '',
      Result: 'PENDING', ErrorMessage: '', ActionTokenGroupID: 'ATG-' + Utilities.getUuid(), RetryCount: 0,
    };
    appendRecords_('AppointmentReminderLog', [reminder]);
    plan = prepareReminderAttemptLocked_(reminder, order, now, 0);
    if (!plan) return 'FAILED';
  } finally { lock.releaseLock(); }
  return deliverAppointmentReminderPlan_(plan, now);
}

/** Reserve a non-secret attempt before minting one-send-only action material. */
function prepareReminderAttemptLocked_(reminder, order, now, attemptNumber) {
  const rootId = appointmentReminderEmailRootId_(reminder.ReminderLogID);
  const rootExists = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === rootId; }, limit: 1 }).length > 0;
  const emailLogId = rootExists ? 'EML-REM-ATTEMPT-' + Utilities.getUuid() : rootId;
  const model = appointmentReminderEventModel_(reminder, order, now);
  const safeSnapshot = makeEmailSnapshot_('APPOINTMENT_DUE', model, rootId);
  let reserved;
  try {
    reserved = createPendingEmailAttempt_('APPOINTMENT_DUE', model, {
      emailLogId: emailLogId, rootEmailLogId: rootId, changeSetId: reminder.ReminderLogID,
      sentBy: 'SYSTEM', retryCount: Number(attemptNumber), terminalLockHeld: true,
    });
  } catch (_error) {
    return failReminderPrepLocked_(reminder, order, now, attemptNumber, emailLogId, safeSnapshot, 'EMAIL_PREPARATION_FAILED');
  }
  if (reserved.result || !reserved.attempt) {
    return failReminderPrepLocked_(reminder, order, now, attemptNumber, emailLogId, reserved.snapshot || safeSnapshot, 'EMAIL_PREPARATION_FAILED');
  }
  let tokenGroup;
  try {
    revokeReminderTokensLocked_(reminder.ReminderLogID, now);
    tokenGroup = createAppointmentActionTokenGroup_(order, reminder.ReminderLogID, reminder.ActionTokenGroupID, now);
    const updated = updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, {
      Result: 'PREPARED', ErrorMessage: '', RetryCount: Number(attemptNumber),
    });
    if (!updated) throw new Error('Reminder attempt update failed.');
    const claimed = claimPendingEmailAttemptLocked_(emailLogId);
    if (String(claimed.Result || '') !== 'SENDING') throw new Error('Reminder attempt claim failed.');
    return {
      reminder: Object.assign({}, reminder, { Result: 'PREPARED', RetryCount: Number(attemptNumber) }),
      order: order, attempt: claimed, snapshot: reserved.snapshot,
      renderModel: Object.assign({}, model, { actionLinks: tokenGroup.actionLinks }),
    };
  } catch (_error) {
    return failReminderPrepLocked_(reminder, order, now, attemptNumber, emailLogId, reserved.snapshot || safeSnapshot, 'EMAIL_PREPARATION_FAILED');
  }
}

function appointmentReminderEventModel_(reminder, order, now) {
  return {
    header: order, items: getOrderItems_(order.OrderID),
    actor: { StaffID: 'SYSTEM', FullName: 'Appointment reminder', Role: 'SYSTEM', Department: order.Department },
    eventAt: (now || new Date()).toISOString(), orderVersion: Number(order.Version || 0),
    changeSetId: String(reminder.ReminderLogID || ''), appointmentActions: ['RECEIVED', 'NO_SHOW', 'RESCHEDULE'],
  };
}

/** Best-effort twice because a transient sheet error must still consume a durable attempt. */
function failReminderPrepLocked_(reminder, order, now, attemptNumber, emailLogId, snapshot, errorCode) {
  const timestamp = (now || new Date()).toISOString();
  const failure = String(errorCode || 'EMAIL_PREPARATION_FAILED');
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const rows = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(emailLogId || ''); }, limit: 2 });
      if (!rows.length) {
        appendRecords_('EmailLog', [{
          EmailLogID: String(emailLogId), OrderID: String(order.OrderID || ''), ChangeSetID: String(reminder.ReminderLogID || ''),
          EmailType: APPOINTMENT_REMINDER_TYPE_, Recipient: '', CC: '', Subject: '', SentAt: timestamp,
          SentBy: 'SYSTEM', Result: 'FAILED', ErrorMessage: failure, RetryCount: Number(attemptNumber),
        }]);
      } else if (rows.length === 1 && String(rows[0].Result || '') === 'PENDING') {
        updateRecordByKey_('EmailLog', 'EmailLogID', emailLogId, { Result: 'FAILED', ErrorMessage: failure, SentAt: timestamp, RetryCount: Number(attemptNumber) });
      }
      const snapshots = readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === 'EMAIL_SNAPSHOT' && String(row.RequestID || '') === String(emailLogId || ''); }, limit: 1 });
      if (!snapshots.length && snapshot) persistEmailSnapshot_({ EmailLogID: emailLogId, OrderID: order.OrderID, SentBy: 'SYSTEM' }, snapshot);
      break;
    } catch (_ignored) {}
  }
  try { revokeReminderTokensLocked_(reminder.ReminderLogID, now); } catch (_ignored) {}
  try {
    updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, {
      Result: 'FAILED', ErrorMessage: failure, SentAt: timestamp, RetryCount: Number(attemptNumber),
    });
  } catch (_ignored) {}
  return null;
}

function deliverAppointmentReminderPlan_(plan, now) {
  const outcome = deliverPendingEmailAttempt_(plan.attempt, plan.snapshot, { managed: true }, plan.renderModel);
  return reconcileReminderDelivery_(plan.reminder, plan.order, outcome, now);
}

/** Reconcile after terminalization under a fresh lock so a prior UNCERTAIN write cannot win. */
function reconcileReminderDelivery_(preparedReminder, preparedOrder, outcome, now) {
  const lock = LockService.getScriptLock();
  let state = 'UNCERTAIN';
  lock.waitLock(30000);
  try {
    const rows = readRecords_('AppointmentReminderLog', { predicate: function (row) {
      return String(row.ReminderLogID || '') === String(preparedReminder.ReminderLogID || '');
    }, limit: 2 });
    if (rows.length !== 1) return state;
    const reminder = rows[0];
    const latest = findLatestReminderEmailAttempt_(reminder);
    let effective = outcome || {};
    if (latest && ['SUCCESS', 'FAILED'].indexOf(String(latest.log.Result || '')) >= 0) {
      effective = { result: String(latest.log.Result), sentAt: latest.log.SentAt, errorMessage: latest.log.ErrorMessage, emailLogId: latest.log.EmailLogID };
    } else if (!latest || String(latest.log.Result || '') === 'SENDING') {
      effective = { result: 'UNCERTAIN', sentAt: latest && latest.log.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: latest && latest.log.EmailLogID || '' };
    }
    updateAppointmentReminderOutcome_(reminder, effective, now);
    state = String(effective.result || 'UNCERTAIN');
    if (state === 'SUCCESS') {
      const order = findOrderHeader_(preparedOrder.OrderID);
      if (appointmentReminderStillEligible_(reminder, order)) recordReminderSuccessLocked_(order, now);
    }
  } finally { lock.releaseLock(); }
  return state === 'SUCCESS' ? 'SUCCESS' : (state === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED');
}

function findAppointmentReminderTuple_(orderId, appointmentSequence, reminderType) {
  const rows = readRecords_('AppointmentReminderLog', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '') && Number(row.AppointmentSequence || 0) === Number(appointmentSequence || 0) && String(row.ReminderType || '') === String(reminderType || '');
  }, limit: 2 });
  if (rows.length > 1) throw new Error('Appointment reminder tuple is not unique.');
  return rows.length ? rows[0] : null;
}

function isAppointmentReminderEligible_(order) {
  return ['NOTIFIED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED'].indexOf(String(order && order.Status || '')) >= 0;
}

function appointmentReminderEmailRootId_(reminderLogId) { return 'EML-REM-' + String(reminderLogId || ''); }

function updateAppointmentReminderOutcome_(reminder, outcome, now) {
  const result = String(outcome && outcome.result || 'FAILED');
  const attempts = outcome && outcome.emailLogId ? readRecords_('EmailLog', { predicate: function (row) {
    return String(row.EmailLogID || '') === String(outcome.emailLogId || '');
  }, limit: 1 }) : [];
  const email = attempts.length ? attempts[0] : {};
  updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, {
    Recipient: String(email.Recipient || reminder.Recipient || ''), CC: String(email.CC || reminder.CC || ''),
    SentAt: String(outcome && outcome.sentAt || (now || new Date()).toISOString()), Result: result,
    ErrorMessage: String(outcome && outcome.errorMessage || ''),
    RetryCount: Number(email.RetryCount == null ? reminder.RetryCount || 0 : email.RetryCount),
  });
}

function recordReminderSuccessLocked_(preparedOrder, now) {
  const current = findOrderHeader_(preparedOrder.OrderID);
  if (!current || Number(current.AppointmentSequence || 0) !== Number(preparedOrder.AppointmentSequence || 0) || String(current.RequiredDate || '') !== String(preparedOrder.RequiredDate || '')) return;
  if (Number(current.LastAppointmentReminderSequence || 0) === Number(current.AppointmentSequence || 0) && current.LastAppointmentReminderAt) return;
  updateRecordByKey_('OrderHeaders', 'OrderID', current.OrderID, {
    LastAppointmentReminderAt: (now || new Date()).toISOString(), LastAppointmentReminderSequence: Number(current.AppointmentSequence || 0),
  });
}

/** Retry only failed attempts. Each retry receives a new token group and in-memory links. */
function retryFailedAppointmentReminders() {
  const summary = { sent: 0, failed: 0, skipped: 0, uncertain: 0 };
  reconcileUnfinishedReminders_(summary);
  const limit = appointmentReminderRetryLimit_();
  const failed = readRecords_('AppointmentReminderLog', { predicate: function (row) {
    return String(row.Result || '') === 'FAILED' && Number(row.RetryCount || 0) < limit;
  } });
  failed.forEach(function (candidate) {
    const outcome = retryOneAppointmentReminder_(candidate, limit);
    if (outcome === 'SUCCESS') summary.sent += 1;
    else if (outcome === 'FAILED') summary.failed += 1;
    else if (outcome === 'UNCERTAIN') summary.uncertain += 1;
    else summary.skipped += 1;
  });
  return summary;
}

function retryOneAppointmentReminder_(candidate, limit) {
  const lock = LockService.getScriptLock();
  let plan = null;
  lock.waitLock(30000);
  try {
    const rows = readRecords_('AppointmentReminderLog', { predicate: function (row) { return String(row.ReminderLogID || '') === String(candidate.ReminderLogID || ''); }, limit: 2 });
    if (rows.length !== 1) return 'SKIPPED';
    const reminder = rows[0];
    if (String(reminder.Result || '') !== 'FAILED') return 'SKIPPED';
    const latest = findLatestReminderEmailAttempt_(reminder);
    const consumed = Math.max(Number(reminder.RetryCount || 0), latest ? Number(latest.log.RetryCount || 0) : 0);
    if (consumed >= limit) return 'SKIPPED';
    if (latest && String(latest.log.Result || '') === 'SENDING') return 'UNCERTAIN';
    if (latest && String(latest.log.Result || '') !== 'FAILED') return 'SKIPPED';
    const order = findOrderHeader_(reminder.OrderID);
    if (!appointmentReminderStillEligible_(reminder, order)) {
      updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, { Result: 'SKIPPED_STALE', ErrorMessage: 'REMINDER_NO_LONGER_ELIGIBLE' });
      revokeReminderTokensLocked_(reminder.ReminderLogID, new Date());
      return 'SKIPPED';
    }
    plan = prepareReminderAttemptLocked_(reminder, order, new Date(), consumed + 1);
    if (!plan) return 'FAILED';
  } finally { lock.releaseLock(); }
  return deliverAppointmentReminderPlan_(plan, new Date());
}

function appointmentReminderStillEligible_(reminder, order) {
  return Boolean(order) && Number(order.AppointmentSequence || 0) === Number(reminder.AppointmentSequence || 0) &&
    String(order.RequiredDate || '') === String(reminder.AppointmentDate || '') && isAppointmentReminderEligible_(order);
}

function findLatestReminderEmailAttempt_(reminder) {
  const rootId = appointmentReminderEmailRootId_(reminder.ReminderLogID);
  const candidates = [];
  readRecords_('EmailLog', { predicate: function (row) {
    return String(row.OrderID || '') === String(reminder.OrderID || '') && String(row.EmailType || '') === APPOINTMENT_REMINDER_TYPE_;
  } }).forEach(function (log) {
    let snapshot = null;
    try { snapshot = loadEmailSnapshot_(log.EmailLogID); } catch (_ignored) {}
    if (String(log.ChangeSetID || '') === String(reminder.ReminderLogID || '') || (snapshot && String(snapshot.rootEmailLogId || '') === rootId)) candidates.push({ log: log, snapshot: snapshot });
  });
  candidates.sort(function (left, right) {
    const retry = Number(right.log.RetryCount || 0) - Number(left.log.RetryCount || 0);
    if (retry) return retry;
    const rank = appointmentEmailStateRank_(right.log.Result) - appointmentEmailStateRank_(left.log.Result);
    if (rank) return rank;
    return String(right.log.SentAt || '').localeCompare(String(left.log.SentAt || ''));
  });
  return candidates.length ? candidates[0] : null;
}

/** Re-read each chain under lock before making any unfinished state terminal. */
function reconcileUnfinishedReminders_(summary) {
  const unfinished = readRecords_('AppointmentReminderLog', { predicate: function (row) {
    return needsReminderReconcile_(row.Result);
  } });
  unfinished.forEach(function (candidate) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const rows = readRecords_('AppointmentReminderLog', { predicate: function (row) { return String(row.ReminderLogID || '') === String(candidate.ReminderLogID || ''); }, limit: 2 });
      if (rows.length !== 1 || !needsReminderReconcile_(rows[0].Result)) return;
      const reminder = rows[0];
      const latest = findLatestReminderEmailAttempt_(reminder);
      if (!latest) {
        const order = findOrderHeader_(reminder.OrderID) || { OrderID: reminder.OrderID };
        const attemptNumber = Number(reminder.RetryCount || 0);
        failReminderPrepLocked_(reminder, order, new Date(), attemptNumber, appointmentReminderEmailRootId_(reminder.ReminderLogID), makeEmailSnapshot_(APPOINTMENT_REMINDER_TYPE_, appointmentReminderEventModel_(reminder, order, new Date()), appointmentReminderEmailRootId_(reminder.ReminderLogID)), 'EMAIL_PREPARATION_INTERRUPTED');
        summary.failed += 1;
        return;
      }
      const state = String(latest.log.Result || '');
      if (state === 'SUCCESS' || state === 'FAILED') {
        updateAppointmentReminderOutcome_(reminder, { result: state, sentAt: latest.log.SentAt, errorMessage: latest.log.ErrorMessage, emailLogId: latest.log.EmailLogID }, new Date());
        if (state === 'SUCCESS') {
          const order = findOrderHeader_(reminder.OrderID);
          if (appointmentReminderStillEligible_(reminder, order)) recordReminderSuccessLocked_(order, new Date());
        } else summary.failed += 1;
        return;
      }
      if (state === 'PENDING') {
        const order = findOrderHeader_(reminder.OrderID);
        if (!appointmentReminderStillEligible_(reminder, order)) {
          updateRecordByKey_('EmailLog', 'EmailLogID', latest.log.EmailLogID, { Result: 'FAILED', ErrorMessage: 'EMAIL_CANCELLED_STALE', SentAt: new Date().toISOString() });
          updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, { Result: 'SKIPPED_STALE', ErrorMessage: 'REMINDER_NO_LONGER_ELIGIBLE', RetryCount: Number(latest.log.RetryCount || reminder.RetryCount || 0) });
          revokeReminderTokensLocked_(reminder.ReminderLogID, new Date());
          summary.skipped += 1;
        } else {
          updateRecordByKey_('EmailLog', 'EmailLogID', latest.log.EmailLogID, { Result: 'FAILED', ErrorMessage: 'EMAIL_PREPARATION_INTERRUPTED', SentAt: new Date().toISOString() });
          updateRecordByKey_('AppointmentReminderLog', 'ReminderLogID', reminder.ReminderLogID, { Result: 'FAILED', ErrorMessage: 'EMAIL_PREPARATION_INTERRUPTED', RetryCount: Number(latest.log.RetryCount || reminder.RetryCount || 0) });
          revokeReminderTokensLocked_(reminder.ReminderLogID, new Date());
          summary.failed += 1;
        }
        return;
      }
      if (state === 'SENDING') {
        updateAppointmentReminderOutcome_(reminder, { result: 'UNCERTAIN', sentAt: latest.log.SentAt, errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: latest.log.EmailLogID }, new Date());
        summary.uncertain += 1;
      }
    } finally { lock.releaseLock(); }
  });
}

function needsReminderReconcile_(result) {
  return ['PENDING', 'PREPARED', 'RETRYING', 'SENDING', 'UNCERTAIN'].indexOf(String(result || '')) >= 0;
}

function appointmentReminderRetryLimit_() {
  const configured = Number(getSetting_('APPOINTMENT_REMINDER_RETRY_LIMIT', '3'));
  return Number.isInteger(configured) && configured >= 0 && configured <= 10 ? configured : 3;
}
