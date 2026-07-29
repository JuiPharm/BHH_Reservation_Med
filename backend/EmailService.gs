/** New-order confirmation delivery. Delivery is independent of the order transaction. */
function sendNewOrderEmail_(context, header, items) {
  const user = context && context.user ? context.user : {};
  return sendTemplatedEmail_('NEW_ORDER', {
    header: header || {}, items: Array.isArray(items) ? items : [], actor: user,
    eventAt: header && header.CreatedAt, orderVersion: header && header.Version,
  }, { to: String(user.Email || '').trim() });
}

function escapeOrderEmailHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
  });
}

/** Build only the sections defined for the selected notification type. */
function buildOrderEmailTemplate_(templateName, model) {
  const name = String(templateName || '').trim().toUpperCase();
  const value = model && typeof model === 'object' ? model : {};
  const header = value.header && typeof value.header === 'object' ? value.header : {};
  const items = Array.isArray(value.items) ? value.items : [];
  const actor = value.actor && typeof value.actor === 'object' ? value.actor : {};
  const orderId = emailText_(header.OrderID);
  const titleByTemplate = {
    NEW_ORDER: '[คำสั่งจองยาใหม่] Order ID: ',
    ORDER_PLACED: '[ดำเนินการสั่งซื้อยาแล้ว] Order ID: ',
    ORDER_UPDATE: '[อัปเดตการจองยา] Order ID: ',
    CANCELLATION: '[ยกเลิกการจองยา] Order ID: ',
    MEDICATION_RECEIVED: '[ได้รับยาแล้ว] Order ID: ',
    APPOINTMENT_DUE: '[แจ้งเตือนวันนัดรับยา] Order ID: ',
    APPOINTMENT_RESCHEDULED: '[แจ้งเลื่อนวันนัดรับยา] Order ID: ',
    PATIENT_RECEIVED_CONFIRMATION: '[คนไข้รับยาเรียบร้อย] Order ID: ',
    PATIENT_NO_SHOW: '[คนไข้ไม่มารับยา] Order ID: ',
  };
  if (!titleByTemplate[name]) throw new Error('Unsupported email template.');

  let fields = [];
  if (name === 'NEW_ORDER') {
    fields = [['รหัสคำขอ', orderId], ['วันที่สร้าง', emailText_(header.CreatedAt)], ['หน่วยงาน', emailText_(header.Department)], ['ผู้ขอเบิก', emailText_(header.CreatedByName)], ['HN', maskEmailHn_(header.HN)], ['คนไข้', maskEmailPatient_(header.PatientName)], ['วันที่ต้องการยา', emailText_(header.RequiredDate)], ['จำนวนรายการ', String(items.length || header.ItemCount || 0)], ['สถานะ', emailText_(header.Status)]];
  } else if (name === 'ORDER_PLACED') {
    fields = [['รหัสคำขอ', orderId], ['หน่วยงาน', emailText_(header.Department)], ['HN', maskEmailHn_(header.HN)], ['คนไข้', maskEmailPatient_(header.PatientName)], ['วันที่สั่งซื้อ', emailText_(header.UpdatedAt)], ['ผู้ทำรายการ', emailText_(header.UpdatedBy)], ['สถานะ', 'สั่งซื้อแล้ว (ORDERED)']];
  } else if (name === 'ORDER_UPDATE') {
    fields = [['แก้ไขโดย', emailText_(value.changedBy || actor.FullName || actor.StaffID)], ['แก้ไขเมื่อ', emailText_(value.changedAt || value.eventAt || header.UpdatedAt)], ['เหตุผล', emailText_(value.changeReason)], ['เวอร์ชัน', emailText_(header.Version)]];
  } else if (name === 'CANCELLATION') {
    fields = [['รหัสคำขอ', orderId], ['หน่วยงาน', emailText_(header.Department)], ['HN', maskEmailHn_(header.HN)], ['คนไข้', maskEmailPatient_(header.PatientName)], ['สถานะเดิม', emailText_(value.previousStatus)], ['สถานะใหม่', emailText_(header.Status)], ['เหตุผลที่ยกเลิก', emailText_(value.cancelReason || header.CancelReason)], ['ผู้ยกเลิก', emailText_(value.cancelledBy || header.CancelledBy)], ['วันที่ยกเลิก', emailText_(value.cancelledAt || header.CancelledAt)]];
  } else if (name === 'MEDICATION_RECEIVED') {
    fields = [['รหัสคำขอ', orderId], ['สถานะปัจจุบัน', emailText_(header.Status)]];
  } else if (name === 'APPOINTMENT_DUE') {
    fields = [['หน่วยงาน', emailText_(header.Department)], ['HN', maskEmailHn_(header.HN)], ['คนไข้', maskEmailPatient_(header.PatientName)], ['วันที่นัดรับยา', emailText_(header.RequiredDate)], ['จำนวนรายการ', String(items.length || header.ItemCount || 0)], ['สถานะปัจจุบัน', emailText_(header.Status)]];
  } else if (name === 'APPOINTMENT_RESCHEDULED') {
    fields = [['วันที่นัดเดิม', emailText_(value.oldRequiredDate || header.LastRequiredDate)], ['วันที่นัดใหม่', emailText_(value.newRequiredDate || header.RequiredDate)], ['เลื่อนโดย', emailText_(value.changedBy || actor.FullName || actor.StaffID)], ['เหตุผล', emailText_(value.reason)], ['การแจ้งเตือน', 'จะมีการแจ้งเตือนใหม่ในวันนัดใหม่']];
  } else if (name === 'PATIENT_RECEIVED_CONFIRMATION') {
    fields = [['รหัสคำขอ', orderId], ['หน่วยงาน', emailText_(header.Department)], ['วันที่นัดรับยา', emailText_(header.RequiredDate)], ['การตอบกลับ', 'คนไข้รับยาเรียบร้อย'], ['บันทึกเมื่อ', emailText_(value.eventAt || header.PatientReceivedAt)]];
  } else if (name === 'PATIENT_NO_SHOW') {
    fields = [['รหัสคำขอ', orderId], ['หน่วยงาน', emailText_(header.Department)], ['วันที่นัดรับยา', emailText_(header.RequiredDate)], ['การตอบกลับ', 'คนไข้ไม่มารับยา'], ['รหัสเหตุผล', emailText_(value.reasonCode || header.NoShowReasonCode)], ['รายละเอียด', emailText_(value.reasonDetail || header.NoShowReasonDetail)], ['บันทึกเมื่อ', emailText_(value.eventAt || header.NoShowRecordedAt)]];
  }

  const changed = name === 'ORDER_UPDATE' && Array.isArray(value.changes) ? value.changes : [];
  const changedLines = changed.map(function (change) {
    const itemPrefix = emailText_(change.itemId || change.OrderItemID);
    const field = emailText_(change.field || change.FieldName);
    const label = itemPrefix ? itemPrefix + ' ' + field : field;
    return label + ': ' + maskEmailChangeValue_(field, change.oldValue == null ? change.OldValue : change.oldValue) + ' → ' + maskEmailChangeValue_(field, change.newValue == null ? change.NewValue : change.newValue);
  });
  const rendersItems = name === 'NEW_ORDER' || name === 'MEDICATION_RECEIVED' || name === 'ORDER_PLACED';
  const itemLines = rendersItems ? items.map(function (item) {
    const itemName = emailText_(item.GenericName || item.MedicationName);
    if (name === 'NEW_ORDER' || name === 'ORDER_PLACED') return itemName + '; จำนวนที่ขอ: ' + emailText_(item.RequestedQuantity) + ' ' + emailText_(item.Unit);
    const status = emailText_(item.ItemStatus || item.Status);
    const received = emailText_(item.ReceivedQuantity) + ' ' + emailText_(item.ReceivedUnit || item.Unit);
    return itemName + ' — สถานะ: ' + status + (name === 'MEDICATION_RECEIVED' ? '; รับมาแล้ว: ' + received : '');
  }) : [];
  const appointmentLinks = name === 'APPOINTMENT_DUE' ? [
    ['คนไข้รับยาเรียบร้อย', emailText_(value.actionLinks && value.actionLinks.received)],
    ['คนไข้ไม่มารับยา', emailText_(value.actionLinks && value.actionLinks.noShow)],
    ['คนไข้เลื่อนนัด', emailText_(value.actionLinks && value.actionLinks.reschedule)],
  ] : [];
  if (appointmentLinks.some(function (entry) { return !isHttpsActionUrl_(entry[1]); })) throw new Error('Invalid appointment action URL.');

  const plain = fields.map(function (field) { return field[0] + ': ' + field[1]; }).concat(changedLines, itemLines, appointmentLinks.map(function (entry) { return entry[0] + ': ' + entry[1]; })).join('\n');
  const html = '<p>' + fields.map(function (field) { return '<strong>' + escapeOrderEmailHtml_(field[0]) + ':</strong> ' + escapeOrderEmailHtml_(field[1]); }).join('<br>') + '</p>' +
    (changedLines.length ? '<ul>' + changedLines.map(function (line) { return '<li>' + escapeOrderEmailHtml_(line) + '</li>'; }).join('') + '</ul>' : '') +
    (itemLines.length ? '<ul>' + itemLines.map(function (line) { return '<li>' + escapeOrderEmailHtml_(line) + '</li>'; }).join('') + '</ul>' : '') +
    (appointmentLinks.length ? '<p>' + appointmentLinks.map(function (entry) {
      const label = escapeOrderEmailHtml_(entry[0]);
      return '<a href="' + escapeOrderEmailHtml_(entry[1]) + '" role="button" aria-label="' + label + '" style="display:inline-block;background:#0b5fff;color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;font-weight:600;margin:4px">' + label + '</a>';
    }).join(' ') + '</p>' : '');
  return { templateName: name, subject: titleByTemplate[name] + orderId, body: plain, htmlBody: html };
}

/** Reserve a durable attempt and snapshot before crossing the external mail boundary. */
function createPendingEmailAttempt_(templateName, model, deliveryMeta) {
  const value = model && typeof model === 'object' ? model : {};
  const meta = deliveryMeta && typeof deliveryMeta === 'object' ? deliveryMeta : {};
  const header = value.header && typeof value.header === 'object' ? value.header : {};
  const actor = value.actor && typeof value.actor === 'object' ? value.actor : {};
  const attemptId = emailText_(meta.emailLogId) || 'EML-' + Utilities.getUuid();
  const rootId = emailText_(meta.rootEmailLogId || value.rootEmailLogId) || attemptId;
  const snapshot = makeEmailSnapshot_(templateName, value, rootId);
  snapshot.rootEmailLogId = rootId;
  snapshot.attemptEmailLogId = attemptId;
  const attempt = {
    EmailLogID: attemptId, OrderID: emailText_(header.OrderID), ChangeSetID: emailText_(meta.changeSetId || value.changeSetId),
    EmailType: emailText_(templateName).toUpperCase(), Recipient: '', CC: '', Subject: '', SentAt: new Date().toISOString(),
    SentBy: emailText_(meta.sentBy || actor.StaffID), Result: 'PENDING', ErrorMessage: '', RetryCount: Number(meta.retryCount || 0),
  };
  try {
    appendRecords_('EmailLog', [attempt]);
  } catch (error) {
    writeEmailAuditSafe_(value, 'EMAIL_LOG', attempt.OrderID, safeEmailError_(error));
    return { attempt: null, snapshot: snapshot, result: { result: 'FAILED', sentAt: attempt.SentAt, errorMessage: 'EMAIL_LOG_WRITE_FAILED', emailLogId: '' } };
  }
  try {
    persistEmailSnapshot_(attempt, snapshot);
  } catch (error) {
    const outcome = { result: 'FAILED', errorMessage: 'EMAIL_SNAPSHOT_WRITE_FAILED', recipient: { to: '', cc: '' }, template: null };
    const terminal = meta.terminalLockHeld ? recordTerminalEmailOutcomeLocked_(attempt, snapshot, outcome) : recordTerminalEmailOutcome_(attempt, snapshot, outcome);
    writeEmailAuditSafe_(value, 'EMAIL_SNAPSHOT', attempt.OrderID, safeEmailError_(error));
    return { attempt: attempt, snapshot: snapshot, result: terminal };
  }
  return { attempt: attempt, snapshot: snapshot, result: null };
}

function persistEmailSnapshot_(attempt, snapshot) {
  appendRecords_('RequestLog', [{ RequestID: String(attempt.EmailLogID), Action: 'EMAIL_SNAPSHOT', OrderID: String(attempt.OrderID || ''), StaffID: String(attempt.SentBy || ''), CreatedAt: new Date().toISOString(), Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) }]);
}

function makeEmailSnapshot_(templateName, model, rootEmailLogId) {
  const value = model && typeof model === 'object' ? model : {};
  if (value.schemaVersion && value.event && value.header) {
    const exact = cloneEmailValue_(value);
    exact.rootEmailLogId = emailText_(rootEmailLogId || exact.rootEmailLogId);
    exact.templateName = emailText_(templateName || exact.templateName).toUpperCase();
    return sanitizeAppointmentEmailSnapshot_(exact);
  }
  const header = cloneEmailValue_(value.header && typeof value.header === 'object' ? value.header : {});
  const items = cloneEmailValue_(Array.isArray(value.items) ? value.items : []);
  const changes = cloneEmailValue_(Array.isArray(value.changes) ? value.changes : []);
  const actor = cloneEmailValue_(value.actor && typeof value.actor === 'object' ? value.actor : {});
  const occurredAt = emailText_(value.eventAt || value.changedAt || value.cancelledAt || header.UpdatedAt || header.CreatedAt) || new Date().toISOString();
  const orderVersion = Number(value.orderVersion == null ? header.Version : value.orderVersion);
  return sanitizeAppointmentEmailSnapshot_({
    schemaVersion: 1, rootEmailLogId: String(rootEmailLogId || ''), templateName: emailText_(templateName).toUpperCase(),
    header: header, items: items, actor: actor, changes: changes,
    event: { actor: actor, occurredAt: occurredAt, orderVersion: isFinite(orderVersion) ? orderVersion : 0, changes: changes, items: items },
    actionLinks: cloneEmailValue_(value.actionLinks || {}), previousStatus: value.previousStatus, cancelReason: value.cancelReason,
    cancelledBy: value.cancelledBy, cancelledAt: value.cancelledAt, changedBy: value.changedBy, changedAt: value.changedAt,
    changeReason: value.changeReason, oldRequiredDate: value.oldRequiredDate, newRequiredDate: value.newRequiredDate, reason: value.reason,
    reasonCode: value.reasonCode, reasonDetail: value.reasonDetail,
  });
}

/** Appointment snapshots persist descriptors only; opaque links exist only in the delivery call stack. */
function sanitizeAppointmentEmailSnapshot_(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (emailText_(value.templateName).toUpperCase() === 'APPOINTMENT_DUE') {
    delete value.actionLinks;
    value.appointmentActions = ['RECEIVED', 'NO_SHOW', 'RESCHEDULE'];
  }
  return value;
}

function cloneEmailValue_(value) {
  try { return JSON.parse(JSON.stringify(value == null ? null : value)); } catch (_ignored) { return value; }
}

function loadEmailSnapshot_(emailLogId) {
  const rows = readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === 'EMAIL_SNAPSHOT' && String(row.RequestID || '') === String(emailLogId || '') && String(row.Result || '') === 'SUCCESS'; }, limit: 1 });
  if (!rows.length) throw new Error('Email snapshot is unavailable.');
  try {
    const snapshot = JSON.parse(String(rows[0].ResponseData || ''));
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.templateName || !snapshot.header) throw new Error('invalid');
    return snapshot;
  } catch (_ignored) { throw new Error('Email snapshot is invalid.'); }
}

function emailAttemptChainKey_(emailLog, snapshot) {
  const log = emailLog && typeof emailLog === 'object' ? emailLog : {};
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const root = emailText_(value.rootEmailLogId);
  if (root) return 'ROOT:' + root;
  const changeSet = emailText_(log.ChangeSetID);
  if (changeSet) return ['CHANGESET', changeSet, emailText_(log.OrderID), emailText_(log.EmailType).toUpperCase()].join(':');
  return 'ROOT:' + emailText_(log.EmailLogID);
}

/** Claim a prepared attempt while the caller holds the script lock. */
function claimPendingEmailAttemptLocked_(emailLogId) {
  const rows = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(emailLogId || ''); }, limit: 2 });
  if (rows.length !== 1) throw new Error('Email attempt identity is invalid.');
  const attempt = rows[0], state = String(attempt.Result || '');
  if (state !== 'PENDING') return attempt;
  const claimed = updateRecordByKey_('EmailLog', 'EmailLogID', attempt.EmailLogID, { Result: 'SENDING', SentAt: new Date().toISOString(), ErrorMessage: '' });
  if (!claimed) throw new Error('Email attempt claim failed.');
  return Object.assign({}, attempt, claimed, { Result: 'SENDING' });
}

function claimPendingEmailAttempt_(emailLogId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return claimPendingEmailAttemptLocked_(emailLogId); }
  finally { lock.releaseLock(); }
}

/**
 * Return delivery ownership only to the caller that performs the durable
 * PENDING-to-SENDING transition. A racing replay that observes SENDING must
 * reconcile instead of crossing the external mail boundary again.
 */
function claimPostCommitAttempt_(emailLogId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = readRecords_('EmailLog', { predicate: function (row) {
      return String(row.EmailLogID || '') === String(emailLogId || '');
    }, limit: 2 });
    if (rows.length !== 1) throw new Error('Email attempt identity is invalid.');
    const current = rows[0];
    if (String(current.Result || '') !== 'PENDING') return { owned: false, attempt: current };
    const claimed = updateRecordByKey_('EmailLog', 'EmailLogID', current.EmailLogID, {
      Result: 'SENDING', SentAt: new Date().toISOString(), ErrorMessage: '',
    });
    if (!claimed) throw new Error('Email attempt claim failed.');
    return { owned: true, attempt: Object.assign({}, current, claimed, { Result: 'SENDING' }) };
  } finally {
    lock.releaseLock();
  }
}

/** Send a claimed attempt unlocked, then durably record its terminal delivery outcome. */
function deliverPendingEmailAttempt_(attempt, snapshot, recipients, renderModel) {
  const log = attempt && typeof attempt === 'object' ? attempt : {};
  const model = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const deliveryModel = renderModel && typeof renderModel === 'object' ? renderModel : model;
  if (String(log.Result || '') !== 'SENDING') return { result: 'UNCERTAIN', sentAt: log.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(log.EmailLogID || '') };
  let result = 'SUCCESS', errorMessage = '', template = null, recipient = { to: '', cc: '' }, resolverFailure = false;
  try {
    template = buildOrderEmailTemplate_(log.EmailType || model.templateName, deliveryModel);
    try {
      recipient = recipients && recipients.managed ? resolveTrustedEmailRecipients_(model.header, log.EmailType || model.templateName) : emailRecipients_(recipients);
      if (!recipient.to) throw new Error('Email recipient is unavailable.');
    } catch (resolverError) {
      resolverFailure = true;
      throw resolverError;
    }
    MailApp.sendEmail({ to: recipient.to, cc: recipient.cc || undefined, subject: template.subject, body: template.body, htmlBody: template.htmlBody });
  } catch (error) {
    result = 'FAILED';
    errorMessage = safeEmailError_(error);
  }
  const terminal = recordTerminalEmailOutcome_(log, model, { result: result, errorMessage: errorMessage, recipient: recipient, template: template });
  if (resolverFailure) writeEmailAuditSafe_(model, 'EMAIL_RECIPIENT_RESOLUTION', log.OrderID, errorMessage);
  return terminal;
}

function recordTerminalEmailOutcome_(attempt, snapshot, outcome) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return recordTerminalEmailOutcomeLocked_(attempt, snapshot, outcome); }
  finally { lock.releaseLock(); }
}

/** Terminal EmailLog writes and fallback receipts share the reconciliation lock. */
function recordTerminalEmailOutcomeLocked_(attempt, snapshot, outcome) {
  let currentRows;
  try {
    currentRows = readRecords_('EmailLog', { predicate: function (row) {
      return String(row.EmailLogID || '') === String(attempt.EmailLogID || '');
    }, limit: 2 });
  } catch (_ignored) {
    return { result: 'UNCERTAIN', sentAt: '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(attempt.EmailLogID || '') };
  }
  if (currentRows.length !== 1) {
    return { result: 'UNCERTAIN', sentAt: '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(attempt.EmailLogID || '') };
  }
  const current = currentRows[0];
  const currentState = String(current.Result || '');
  if (['SUCCESS', 'FAILED', 'SKIPPED_DISABLED', 'UNCERTAIN'].indexOf(currentState) >= 0) {
    return {
      result: currentState,
      sentAt: String(current.SentAt || ''),
      errorMessage: String(current.ErrorMessage || ''),
      emailLogId: String(current.EmailLogID || ''),
    };
  }
  const attemptState = String(attempt.Result || '');
  const nextState = String(outcome && outcome.result || 'FAILED');
  const transitionAllowed = (currentState === 'SENDING' && attemptState === 'SENDING')
    || (currentState === 'PENDING' && attemptState === 'PENDING' && ['FAILED', 'SKIPPED_DISABLED'].indexOf(nextState) >= 0);
  if (!transitionAllowed) {
    return { result: 'UNCERTAIN', sentAt: String(current.SentAt || ''), errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(current.EmailLogID || '') };
  }
  const now = new Date().toISOString();
  const updates = {
    Recipient: outcome.recipient && outcome.recipient.to || String(attempt.Recipient || ''),
    CC: outcome.recipient && outcome.recipient.cc || String(attempt.CC || ''),
    Subject: outcome.template ? outcome.template.subject : String(attempt.Subject || ''),
    SentAt: now, Result: String(outcome.result || 'FAILED'), ErrorMessage: String(outcome.errorMessage || ''),
  };
  try {
    const updated = updateRecordByKey_('EmailLog', 'EmailLogID', attempt.EmailLogID, updates);
    if (!updated) throw new Error('Email attempt was not found.');
    return { result: updates.Result, sentAt: now, errorMessage: updates.ErrorMessage, emailLogId: String(attempt.EmailLogID || '') };
  } catch (updateError) {
    const receipt = Object.assign({}, attempt, updates, { EmailLogID: 'EML-' + Utilities.getUuid() });
    try {
      appendRecords_('EmailLog', [receipt]);
      persistEmailSnapshot_(receipt, snapshot);
      writeEmailAuditSafe_(snapshot, 'EMAIL_LOG', attempt.OrderID, 'EMAIL_LOG_UPDATE_RECOVERED');
      return { result: updates.Result, sentAt: now, errorMessage: updates.ErrorMessage, emailLogId: receipt.EmailLogID, rootEmailLogId: snapshot.rootEmailLogId };
    } catch (appendError) {
      writeEmailAuditSafe_(snapshot, 'EMAIL_LOG', attempt.OrderID, safeEmailError_(appendError));
      return { result: 'UNCERTAIN', sentAt: now, errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(attempt.EmailLogID || '') };
    }
  }
}

/** Reserve, snapshot, deliver, and terminalize one independent notification attempt. */
function sendTemplatedEmail_(templateName, model, recipients, deliveryMeta) {
  const reserved = createPendingEmailAttempt_(templateName, model, deliveryMeta);
  if (reserved.result) return reserved.result;
  const claimed = claimPendingEmailAttempt_(reserved.attempt.EmailLogID);
  if (String(claimed.Result || '') !== 'SENDING') return { result: 'UNCERTAIN', sentAt: claimed.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(claimed.EmailLogID || '') };
  return deliverPendingEmailAttempt_(claimed, reserved.snapshot, recipients, model);
}

/** Retry from an exact stored snapshot; managed recipients are resolved afresh. */
function retryEmailDelivery_(emailLog, snapshot) {
  const log = emailLog && typeof emailLog === 'object' ? emailLog : {};
  if (String(log.Result || '') !== 'FAILED') throw new Error('Only failed email delivery can be retried.');
  const original = snapshot && snapshot.schemaVersion ? snapshot : makeEmailSnapshot_(log.EmailType, snapshot || {}, log.EmailLogID);
  if (typeof assertLatestEmailChainAttempt_ === 'function') assertLatestEmailChainAttempt_(log, original);
  if (typeof findOrderHeader_ === 'function' && typeof assertEmailRetryCompatible_ === 'function') {
    const header = findOrderHeader_(log.OrderID);
    if (!header) throw new Error('Retry order is unavailable.');
    assertEmailRetryCompatible_(log, original, header);
  }
  const rootId = emailText_(original.rootEmailLogId) || emailText_(log.EmailLogID);
  const reserved = createPendingEmailAttempt_(log.EmailType, original, { retryCount: Number(log.RetryCount || 0) + 1, changeSetId: log.ChangeSetID, sentBy: original.event && original.event.actor ? original.event.actor.StaffID : '', rootEmailLogId: rootId });
  if (reserved.result) return reserved.result;
  const claimed = claimPendingEmailAttempt_(reserved.attempt.EmailLogID);
  if (String(claimed.Result || '') !== 'SENDING') return { result: 'UNCERTAIN', sentAt: claimed.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(claimed.EmailLogID || '') };
  return deliverPendingEmailAttempt_(claimed, reserved.snapshot, { managed: true });
}

/** Resolve only persisted managed recipients and keep resolver errors inside a durable attempt. */
function sendOrderNotificationSafe_(templateName, model) {
  return sendTemplatedEmail_(templateName, model, { managed: true });
}

function makePostCommitNotificationJob_(templateName, model, deliveryMode) {
  const emailLogId = 'EML-' + Utilities.getUuid();
  return {
    schemaVersion: 1,
    status: 'PENDING',
    emailLogId: emailLogId,
    templateName: emailText_(templateName).toUpperCase(),
    deliveryMode: deliveryMode === 'SKIP' ? 'SKIP' : 'SEND',
    snapshot: makeEmailSnapshot_(templateName, model, emailLogId),
    outcome: null,
  };
}

/**
 * Reconcile one job whose descriptor was committed with the business RequestLog.
 * A pre-existing SENDING row is never delivered again.
 */
function deliverPostCommitNotificationJob_(job) {
  const value = job && typeof job === 'object' ? job : {};
  const emailLogId = emailText_(value.emailLogId);
  if (!emailLogId || !value.snapshot || !value.templateName) throw new Error('Post-commit notification job is invalid.');
  const reserved = reservePostCommitAttempt_(value);
  if (reserved.result) return reserved.result;
  const attempt = reserved.attempt;
  const state = String(attempt.Result || '');
  if (['SUCCESS', 'FAILED', 'SKIPPED_DISABLED'].indexOf(state) >= 0) {
    return { result: state, sentAt: attempt.SentAt || '', errorMessage: attempt.ErrorMessage || '', emailLogId: String(attempt.EmailLogID || '') };
  }
  if (state === 'SENDING') return { result: 'UNCERTAIN', sentAt: attempt.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: emailLogId };
  if (state !== 'PENDING') throw new Error('Post-commit notification state is invalid.');
  if (value.deliveryMode === 'SKIP') {
    return recordTerminalEmailOutcome_(attempt, value.snapshot, {
      result: 'SKIPPED_DISABLED', errorMessage: value.policyError || 'Notification setting is disabled.',
      recipient: { to: '', cc: '' }, template: null,
    });
  }
  const claim = claimPostCommitAttempt_(emailLogId);
  if (!claim.owned) {
    const observed = claim.attempt || {};
    const observedState = String(observed.Result || '');
    if (['SUCCESS', 'FAILED', 'SKIPPED_DISABLED'].indexOf(observedState) >= 0) {
      return { result: observedState, sentAt: observed.SentAt || '', errorMessage: observed.ErrorMessage || '', emailLogId: String(observed.EmailLogID || '') };
    }
    return { result: 'UNCERTAIN', sentAt: observed.SentAt || '', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: emailLogId };
  }
  return deliverPendingEmailAttempt_(claim.attempt, value.snapshot, { managed: true });
}

function reservePostCommitAttempt_(value) {
  const emailLogId = emailText_(value && value.emailLogId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = readRecords_('EmailLog', { predicate: function (row) {
      return String(row.EmailLogID || '') === emailLogId;
    }, limit: 2 });
    if (rows.length > 1) throw new Error('Post-commit notification identity is ambiguous.');
    if (rows.length === 1) return { attempt: rows[0], snapshot: value.snapshot, result: null };
    return createPendingEmailAttempt_(value.templateName, value.snapshot, {
      emailLogId: emailLogId,
      rootEmailLogId: emailLogId,
      changeSetId: value.snapshot.header && value.snapshot.header.LastChangeSetID,
      sentBy: value.snapshot.event && value.snapshot.event.actor && value.snapshot.event.actor.StaffID,
      terminalLockHeld: true,
    });
  } finally {
    lock.releaseLock();
  }
}

function inspectPostCommitNotificationJob_(job) {
  try {
    const rows = readRecords_('EmailLog', { predicate: function (row) {
      return String(row.EmailLogID || '') === String(job && job.emailLogId || '');
    }, limit: 2 });
    if (rows.length !== 1) return { result: 'PENDING', errorMessage: 'EMAIL_PREPARATION_PENDING', emailLogId: String(job && job.emailLogId || '') };
    const state = String(rows[0].Result || '');
    if (state === 'SENDING') return { result: 'UNCERTAIN', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(rows[0].EmailLogID || '') };
    if (['SUCCESS', 'FAILED', 'SKIPPED_DISABLED'].indexOf(state) >= 0) return { result: state, errorMessage: String(rows[0].ErrorMessage || ''), emailLogId: String(rows[0].EmailLogID || '') };
    return { result: 'PENDING', errorMessage: 'EMAIL_PREPARATION_PENDING', emailLogId: String(rows[0].EmailLogID || '') };
  } catch (_ignored) {
    return { result: 'PENDING', errorMessage: 'EMAIL_RECONCILIATION_PENDING', emailLogId: String(job && job.emailLogId || '') };
  }
}

function resolveTrustedEmailRecipients_(header, templateName) {
  const value = header && typeof header === 'object' ? header : {};
  const name = emailText_(templateName).toUpperCase();
  const staffId = emailText_(value.CreatedByStaffID);
  const department = emailText_(value.Department);
  const users = staffId ? readRecords_('Users', { predicate: function (entry) { return String(entry.StaffID || '') === staffId && isManagedRecordActive_(entry); }, limit: 1 }) : [];
  const departments = department ? readRecords_('Departments', { predicate: function (entry) { return String(entry.DepartmentCode || '') === department && isManagedRecordActive_(entry); }, limit: 1 }) : [];
  let to = '';
  if (name === 'APPOINTMENT_DUE' || name === 'PATIENT_NO_SHOW') {
    if (!departments.length) throw new Error('Managed department recipient is unavailable.');
    to = emailText_(departments[0].DepartmentEmail);
  } else if (staffId) {
    if (!users.length) throw new Error('Managed requester recipient is unavailable.');
    to = emailText_(users[0].Email);
  } else {
    to = emailText_(value.RequesterEmail);
  }
  const cc = departments.length ? emailText_(departments[0].CCEmail) : '';
  return emailRecipients_({ to: to, cc: cc });
}

function isManagedRecordActive_(entry) { return emailText_(entry && entry.Active).toUpperCase() === 'TRUE'; }

/** Persist a skipped notification and its exact snapshot without invoking MailApp. */
function recordSkippedEmailAttempt_(templateName, model, result, errorMessage) {
  const reserved = createPendingEmailAttempt_(templateName, model, {});
  if (reserved.result) return reserved.result;
  return recordTerminalEmailOutcome_(reserved.attempt, reserved.snapshot, { result: result, errorMessage: errorMessage, recipient: { to: '', cc: '' }, template: null });
}

function writeEmailAuditSafe_(model, action, orderId, detail) {
  const actor = model && model.event && model.event.actor ? model.event.actor : (model && model.actor ? model.actor : {});
  const header = model && model.header ? model.header : {};
  try { writeAudit_({ StaffID: emailText_(actor.StaffID), Role: emailText_(actor.Role), Department: emailText_(actor.Department || header.Department), Action: action, OrderID: emailText_(orderId), Result: 'FAILURE', Detail: emailText_(detail) }); } catch (_ignored) {}
}

function emailRecipients_(recipients) {
  const value = typeof recipients === 'string' ? { to: recipients } : (recipients && typeof recipients === 'object' ? recipients : {});
  const to = emailText_(value.to || value.Recipient);
  const cc = emailText_(value.cc || value.CC);
  if ((to && !isSingleEmail_(to)) || (cc && !isSingleEmail_(cc))) throw new Error('Invalid email recipient.');
  return { to: to, cc: cc };
}

function isSingleEmail_(value) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value); }
function emailText_(value) { return String(value == null ? '' : value).trim(); }
function safeEmailError_(_error) { return 'EMAIL_DELIVERY_FAILED'; }
function isHttpsActionUrl_(value) {
  const text = String(value || '');
  const match = /^https:\/\/([^\/?#]+)(?:[\/?#][^\s<>]*)?$/i.exec(text);
  if (!match || /[@\s]/.test(match[1])) return false;
  const hostPort = match[1].split(':');
  const host = hostPort[0];
  if (!host || host.charAt(0) === '.' || host.charAt(host.length - 1) === '.' || host.indexOf('..') >= 0 || !/^[A-Za-z0-9.-]+$/.test(host)) return false;
  if (hostPort.length > 2 || (hostPort.length === 2 && (!/^\d{1,5}$/.test(hostPort[1]) || Number(hostPort[1]) > 65535))) return false;
  return true;
}
function maskEmailHn_(value) { const text = emailText_(value); return /^07-\d{2}-\d{6}$/.test(text) ? '07-**-***' + text.slice(-3) : '***'; }
function maskEmailPatient_(value) { const name = emailText_(value); return name ? name.split(/\s+/).map(function (part) { return part.charAt(0) + new Array(Math.max(2, part.length)).join('*'); }).join(' ') : '***'; }
function maskEmailChangeValue_(field, value) { return String(field || '') === 'HN' ? maskEmailHn_(value) : (String(field || '') === 'PatientName' ? maskEmailPatient_(value) : emailText_(value)); }

function enqueueEmailNotification_(templateName, model, recipients) {
  const queueId = 'Q-' + Utilities.getUuid();
  const attempt = {
    QueueID: queueId,
    TemplateName: String(templateName || '').toUpperCase(),
    ModelJSON: JSON.stringify({ model: model, recipients: recipients }),
    Status: 'PENDING',
    CreatedAt: new Date().toISOString(),
    ProcessedAt: '',
    RetryCount: 0,
    ErrorMessage: ''
  };
  appendRecords_('NotificationQueue', [attempt]);
  return queueId;
}

function processNotificationQueue_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const queue = readRecords_('NotificationQueue', { predicate: function(row) {
      return String(row.Status) === 'PENDING' && Number(row.RetryCount || 0) < 3;
    }, limit: 5 });
    
    if (!queue.length) return;
    
    queue.forEach(function(job) {
      try {
        const data = JSON.parse(job.ModelJSON);
        sendTemplatedEmail_(job.TemplateName, data.model, data.recipients);
        updateRecordByKey_('NotificationQueue', 'QueueID', job.QueueID, { Status: 'SUCCESS', ProcessedAt: new Date().toISOString() });
      } catch (e) {
        updateRecordByKey_('NotificationQueue', 'QueueID', job.QueueID, { 
          RetryCount: Number(job.RetryCount || 0) + 1,
          ErrorMessage: String(e.message || e).substring(0, 200),
          Status: Number(job.RetryCount || 0) >= 2 ? 'FAILED' : 'PENDING'
        });
      }
    });
  } catch (e) {
    // Ignore global errors to allow next trigger to run
  } finally {
    lock.releaseLock();
  }
}
