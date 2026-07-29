/** Return a minimal, read-only public confirmation model. */
function getAppointmentAction_(opaqueToken) {
  const loaded = loadValidActionToken_(opaqueToken, '', new Date());
  if (String(loaded.token.ActionType || '') === 'RESCHEDULE') throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  return appointmentPublicModel_(loaded);
}

/** Return only login-routing metadata for a reschedule reference. */
function getRescheduleReference_(opaqueToken) {
  const loaded = loadValidActionToken_(opaqueToken, 'RESCHEDULE', new Date());
  return {
    actionType: 'RESCHEDULE', requiresLogin: true,
    expiresAt: String(loaded.token.ExpiresAt || ''),
  };
}

/** Load the authorized, current appointment after session validation. */
function getRescheduleOrder_(context, reference) {
  const loaded = loadValidActionToken_(reference, 'RESCHEDULE', new Date());
  requireAppointmentDepartment_(context, loaded.order);
  return appointmentRescheduleModel_(loaded.order);
}

function appointmentPublicModel_(loaded) {
  const actionType = String(loaded.token.ActionType || '');
  const model = {
    OrderID: String(loaded.order.OrderID || ''),
    appointmentDate: String(loaded.order.RequiredDate || ''),
    appointmentSequence: Number(loaded.order.AppointmentSequence || 0),
    actionType: actionType,
    requiresReason: actionType === 'NO_SHOW',
    expiresAt: String(loaded.token.ExpiresAt || ''),
  };
  if (actionType === 'NO_SHOW') model.noShowReasons = appointmentPublicNoShowReasons_();
  return model;
}

function appointmentPublicNoShowReasons_() {
  if (typeof getMasterData_ !== 'function') return [];
  const records = getMasterData_(['NO_SHOW_REASON']);
  return (records.NO_SHOW_REASON || []).filter(function (entry) {
    const active = entry && entry.Active;
    return active === true || String(active || '').toUpperCase() === 'TRUE';
  }).map(function (entry) {
    return { code: String(entry.Code || '').trim().toUpperCase(), label: String(entry.DisplayName || entry.Code || '').trim() };
  }).filter(function (entry) { return !!entry.code && !!entry.label; });
}

function appointmentRescheduleModel_(order) {
  return {
    OrderID: String(order.OrderID || ''), Department: String(order.Department || ''),
    RequiredDate: String(order.RequiredDate || ''), Version: Number(order.Version || 0),
    AppointmentSequence: Number(order.AppointmentSequence || 0), Status: String(order.Status || ''),
  };
}

/** Confirm collection through a scanner-safe POST. */
function confirmPatientReceived_(payload, requestId) {
  const token = normalizeReceivedPayload_(payload).token;
  if (!appointmentSettingEnabled_(['ALLOW_EMAIL_RECEIVED_ACTION', 'WITHOUT_LOGIN'].join('_'), true)) throw new ApiError_('ACCESS_DENIED', 'This appointment action requires staff login.');
  return runAppointmentMutation_('CONFIRM_PATIENT_RECEIVED', token, 'RECEIVED', requestId, null, function (loaded, now) {
    const order = loaded.order;
    const versionBefore = Number(order.Version || 0), versionAfter = versionBefore + 1;
    const responseStatus = 'PATIENT_RECEIVED';
    const status = appointmentSettingEnabled_('PATIENT_RECEIVED_AUTO_COMPLETE', true) ? 'COMPLETED' : responseStatus;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    trackAppointmentMutationOwnership_(loaded, versionAfter, changeSetId, 'SINGLE_USE', now, 'PUBLIC_ACTION');
    const updates = {
      Status: status, Version: versionAfter, UpdatedAt: now.toISOString(), UpdatedBy: 'PUBLIC_ACTION',
      LastChangeSetID: changeSetId, LastChangeType: 'CONFIRM_PATIENT_RECEIVED', LastChangeReason: '',
      LastChangedAt: now.toISOString(), LastChangedBy: 'PUBLIC_ACTION', AppointmentResponseStatus: responseStatus,
      AppointmentRespondedAt: now.toISOString(), AppointmentRespondedBy: 'PUBLIC_ACTION', PatientReceivedAt: now.toISOString(),
    };
    const updated = updateRecordByKey_('OrderHeaders', 'OrderID', order.OrderID, updates);
    if (!updated) throw new Error('Appointment order update failed.');
    appendAppointmentResponseLog_(loaded, {
      actionType: responseStatus, now: now, requestId: requestId, changeSetId: changeSetId,
      versionBefore: versionBefore, versionAfter: versionAfter, result: 'SUCCESS',
    });
    writeAppointmentChanges_(order, updated, ['Status', 'AppointmentResponseStatus', 'PatientReceivedAt'], null, requestId, changeSetId, versionAfter);
    writeAppointmentAudit_(null, requestId, order.OrderID, 'CONFIRM_PATIENT_RECEIVED', 'SUCCESS', { versionBefore: versionBefore, versionAfter: versionAfter });
    markActionTokenUsedLocked_(loaded.token, 'PUBLIC_ACTION', now);
    return {
      response: { OrderID: String(order.OrderID), Status: status, AppointmentResponseStatus: responseStatus, Version: versionAfter },
      emailTemplate: 'PATIENT_RECEIVED_CONFIRMATION',
      emailModel: appointmentEmailModel_(updated, null, now, versionAfter, { reason: '' }),
    };
  });
}

/** Record a no-show through POST after validating the canonical reason list. */
function submitPatientNoShow_(payload, requestId) {
  const input = normalizeNoShowPayload_(payload);
  if (!appointmentSettingEnabled_(['ALLOW_EMAIL_NO_SHOW_ACTION', 'WITHOUT_LOGIN'].join('_'), true)) throw new ApiError_('ACCESS_DENIED', 'This appointment action requires staff login.');
  return runAppointmentMutation_('SUBMIT_PATIENT_NO_SHOW', input.token, 'NO_SHOW', requestId, null, function (loaded, now) {
    const order = loaded.order;
    const versionBefore = Number(order.Version || 0), versionAfter = versionBefore + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    trackAppointmentMutationOwnership_(loaded, versionAfter, changeSetId, 'SINGLE_USE', now, 'PUBLIC_ACTION');
    const updates = {
      Status: 'PATIENT_NO_SHOW', Version: versionAfter, UpdatedAt: now.toISOString(), UpdatedBy: 'PUBLIC_ACTION',
      LastChangeSetID: changeSetId, LastChangeType: 'SUBMIT_PATIENT_NO_SHOW', LastChangeReason: input.reasonCode,
      LastChangedAt: now.toISOString(), LastChangedBy: 'PUBLIC_ACTION', AppointmentResponseStatus: 'PATIENT_NO_SHOW',
      AppointmentRespondedAt: now.toISOString(), AppointmentRespondedBy: 'PUBLIC_ACTION', NoShowReasonCode: input.reasonCode,
      NoShowReasonDetail: input.reasonDetail, NoShowRecordedAt: now.toISOString(), NoShowCount: Number(order.NoShowCount || 0) + 1,
    };
    const updated = updateRecordByKey_('OrderHeaders', 'OrderID', order.OrderID, updates);
    if (!updated) throw new Error('Appointment order update failed.');
    appendAppointmentResponseLog_(loaded, {
      actionType: 'PATIENT_NO_SHOW', now: now, requestId: requestId, changeSetId: changeSetId,
      versionBefore: versionBefore, versionAfter: versionAfter, reasonCode: input.reasonCode, reasonDetail: input.reasonDetail, result: 'SUCCESS',
    });
    writeAppointmentChanges_(order, updated, ['Status', 'NoShowReasonCode', 'NoShowReasonDetail', 'NoShowCount'], input.reasonCode, requestId, changeSetId, versionAfter);
    writeAppointmentAudit_(null, requestId, order.OrderID, 'SUBMIT_PATIENT_NO_SHOW', 'SUCCESS', { reasonCode: input.reasonCode, versionBefore: versionBefore, versionAfter: versionAfter });
    markActionTokenUsedLocked_(loaded.token, 'PUBLIC_ACTION', now);
    return {
      response: { OrderID: String(order.OrderID), Status: 'PATIENT_NO_SHOW', NoShowCount: updates.NoShowCount, Version: versionAfter },
      emailTemplate: 'PATIENT_NO_SHOW',
      emailModel: appointmentEmailModel_(updated, null, now, versionAfter, { reasonCode: input.reasonCode, reasonDetail: input.reasonDetail }),
    };
  });
}

/** Reschedule a current appointment after session and department authorization. */
function submitAppointmentReschedule_(context, payload, requestId) {
  const input = normalizeReschedulePayload_(payload);
  return runAppointmentMutation_('SUBMIT_APPOINTMENT_RESCHEDULE', input.reference, 'RESCHEDULE', requestId, context, function (loaded, now) {
    const order = loaded.order;
    requireAppointmentDepartment_(context, order);
    if (Number(order.Version || 0) !== input.expectedVersion) throw new ApiError_('ORDER_VERSION_CONFLICT', 'This order was changed. Reload it before rescheduling.');
    validateNewAppointmentDate_(input.newRequiredDate, String(order.RequiredDate || ''), context, now);
    const versionBefore = Number(order.Version || 0), versionAfter = versionBefore + 1;
    const sequenceBefore = Number(order.AppointmentSequence || 0), sequenceAfter = sequenceBefore + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    const actor = context.user;
    trackAppointmentMutationOwnership_(loaded, versionAfter, changeSetId, 'REVOKE_GROUP', now, String(actor.StaffID));
    const updates = {
      RequiredDate: input.newRequiredDate, LastRequiredDate: String(order.RequiredDate || ''),
      Status: 'APPOINTMENT_RESCHEDULED', AppointmentSequence: sequenceAfter, Version: versionAfter,
      UpdatedAt: now.toISOString(), UpdatedBy: String(actor.StaffID), LastChangeSetID: changeSetId,
      LastChangeType: 'SUBMIT_APPOINTMENT_RESCHEDULE', LastChangeReason: input.reason,
      LastChangedAt: now.toISOString(), LastChangedBy: String(actor.StaffID),
      LastRescheduledAt: now.toISOString(), LastRescheduledBy: String(actor.StaffID), LastRescheduleReason: input.reason,
      AppointmentResponseStatus: 'APPOINTMENT_RESCHEDULED', AppointmentRespondedAt: now.toISOString(), AppointmentRespondedBy: String(actor.StaffID),
    };
    const updated = updateRecordByKey_('OrderHeaders', 'OrderID', order.OrderID, updates);
    if (!updated) throw new Error('Appointment order update failed.');
    revokeAppointmentTokensLocked_(order.OrderID, sequenceBefore, loaded.token.TokenID, now);
    appendAppointmentResponseLog_(loaded, {
      actionType: 'APPOINTMENT_RESCHEDULED', now: now, requestId: requestId, changeSetId: changeSetId,
      versionBefore: versionBefore, versionAfter: versionAfter, reasonDetail: input.reason,
      oldRequiredDate: String(order.RequiredDate || ''), newRequiredDate: input.newRequiredDate,
      context: context, result: 'SUCCESS',
    });
    writeAppointmentChanges_(order, updated, ['RequiredDate', 'Status', 'AppointmentSequence'], input.reason, requestId, changeSetId, versionAfter, context);
    writeAppointmentAudit_(context, requestId, order.OrderID, 'SUBMIT_APPOINTMENT_RESCHEDULE', 'SUCCESS', { oldRequiredDate: order.RequiredDate, newRequiredDate: input.newRequiredDate, sequenceBefore: sequenceBefore, sequenceAfter: sequenceAfter });
    return {
      response: { OrderID: String(order.OrderID), RequiredDate: input.newRequiredDate, Status: 'APPOINTMENT_RESCHEDULED', AppointmentSequence: sequenceAfter, Version: versionAfter },
      emailTemplate: 'APPOINTMENT_RESCHEDULED',
      emailModel: appointmentEmailModel_(updated, context, now, versionAfter, { oldRequiredDate: order.RequiredDate, newRequiredDate: input.newRequiredDate, reason: input.reason }),
    };
  });
}

function runAppointmentMutation_(action, opaqueToken, actionType, requestId, context, mutate) {
  const id = String(requestId || '').trim();
  if (!id || id.length > 128) throw new ApiError_('VALIDATION_ERROR', 'A request ID is required.');
  const replay = findAppointmentRequestReplay_(action, id, opaqueToken);
  if (replay) {
    authorizeAppointmentReplay_(context, replay);
    return resumeAppointmentMutationReplay_(replay);
  }
  const lock = LockService.getScriptLock();
  let response, claimed = null, snapshot = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findAppointmentRequestReplay_(action, id, opaqueToken);
    if (lockedReplay) { authorizeAppointmentReplay_(context, lockedReplay); response = lockedReplay; }
    else {
      const loaded = loadValidActionToken_(opaqueToken, actionType, new Date());
      if (context) requireAppointmentDepartment_(context, loaded.order);
      beginAppointmentRequest_(action, id, loaded.order.OrderID, context, opaqueToken);
      const recovery = appointmentRecoverySnapshot_(loaded);
      loaded.recovery = recovery;
      let prepared = null;
      try {
        const result = mutate(loaded, new Date());
        prepared = prepareAppointmentEmailLocked_(result.emailTemplate, result.emailModel, context, result.response);
        result.response.emailLogId = prepared.emailLogId;
        result.response.emailPrepared = prepared.prepared;
        completeAppointmentRequest_(action, id, loaded.order.OrderID, context, opaqueToken, result.response);
        claimed = prepared.attempt ? claimPendingEmailAttemptLocked_(prepared.attempt.EmailLogID) : null;
        snapshot = prepared.snapshot;
        response = result.response;
      } catch (error) {
        recoverAppointmentFailureLocked_(action, id, context, opaqueToken, recovery, prepared, error);
        throw error;
      }
    }
  } finally {
    lock.releaseLock();
  }
  if (response && response.__appointmentReplay) return resumeAppointmentMutationReplay_(response);
  if (claimed && snapshot) response.email = deliverPendingEmailAttempt_(claimed, snapshot, { managed: true });
  invalidateAppointmentCacheSafe_(response && response.OrderID);
  return response;
}

function authorizeAppointmentReplay_(context, replay) {
  if (!context) return;
  const order = findOrderHeader_(replay.OrderID);
  if (!order) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireAppointmentDepartment_(context, order);
}

function appointmentRecoverySnapshot_(loaded) {
  const order = loaded.order || {};
  const fields = ['Status', 'Version', 'UpdatedAt', 'UpdatedBy', 'LastChangeSetID', 'LastChangeType', 'LastChangeReason', 'LastChangedAt', 'LastChangedBy', 'AppointmentResponseStatus', 'AppointmentRespondedAt', 'AppointmentRespondedBy', 'PatientReceivedAt', 'NoShowReasonCode', 'NoShowReasonDetail', 'NoShowRecordedAt', 'NoShowCount', 'RequiredDate', 'LastRequiredDate', 'AppointmentSequence', 'LastRescheduledAt', 'LastRescheduledBy', 'LastRescheduleReason'];
  const header = {};
  fields.forEach(function (field) { header[field] = order[field] == null ? '' : order[field]; });
  const tokens = readRecords_('ActionTokens', { predicate: function (row) { return String(row.OrderID || '') === String(order.OrderID || '') && Number(row.AppointmentSequence || 0) === Number(order.AppointmentSequence || 0); } }).map(function (row) {
    return { TokenID: row.TokenID, UsedAt: row.UsedAt || '', UsedBy: row.UsedBy || '', Status: row.Status || '' };
  });
  return { order: order, header: header, tokens: tokens, versionAfter: 0, changeSetId: '', expectedTokens: {} };
}

function trackAppointmentMutationOwnership_(loaded, versionAfter, changeSetId, mode, now, usedBy) {
  const recovery = loaded && loaded.recovery;
  if (!recovery) return;
  recovery.versionAfter = Number(versionAfter || 0);
  recovery.changeSetId = String(changeSetId || '');
  const timestamp = (now || new Date()).toISOString();
  (recovery.tokens || []).forEach(function (token) {
    let expected = { Status: token.Status, UsedAt: token.UsedAt, UsedBy: token.UsedBy };
    if (String(token.Status || '') === 'ACTIVE' && String(mode || '') === 'REVOKE_GROUP') {
      expected = { Status: String(token.TokenID) === String(loaded.token.TokenID) ? 'USED' : 'REVOKED', UsedAt: timestamp, UsedBy: 'SYSTEM' };
    } else if (String(token.TokenID) === String(loaded.token.TokenID) && String(mode || '') === 'SINGLE_USE') {
      expected = { Status: 'USED', UsedAt: timestamp, UsedBy: String(usedBy || '') };
    }
    recovery.expectedTokens[String(token.TokenID)] = expected;
  });
}

function recoverAppointmentFailureLocked_(action, requestId, context, opaqueToken, recovery, prepared, error) {
  const now = new Date().toISOString();
  if (prepared && prepared.emailLogId) {
    try {
      const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(prepared.emailLogId || ''); }, limit: 2 });
      if (attempts.length === 1 && ['PENDING', 'SENDING'].indexOf(String(attempts[0].Result || '')) >= 0) updateRecordByKey_('EmailLog', 'EmailLogID', attempts[0].EmailLogID, { Result: 'FAILED', ErrorMessage: 'EMAIL_PREPARATION_FAILED', SentAt: now });
    } catch (_ignored) {}
  }
  const restoration = restoreAppointmentStateLocked_(recovery);
  const rollbackResult = restoration.succeeded ? 'ROLLED_BACK' : 'ROLLBACK_FAILED';
  const beforeVersion = Number(recovery.versionAfter || Number(recovery.order.Version || 0) + 1);
  const afterVersion = restoration.succeeded ? Number(recovery.order.Version || 0) : Number(restoration.currentVersion || beforeVersion);
  try {
    appendRecords_('AppointmentResponseLog', [{ ResponseLogID: 'APTR-' + Utilities.getUuid(), OrderID: String(recovery.order.OrderID || ''), AppointmentSequence: Number(recovery.order.AppointmentSequence || 0), AppointmentDate: String(recovery.order.RequiredDate || ''), ActionType: action + '_ROLLBACK', ResponseAt: now, ResponseSource: context ? 'WEB' : 'PUBLIC_TOKEN', RespondedByStaffID: appointmentActorId_(context), RespondedByName: '', Department: String(recovery.order.Department || ''), ReasonCode: '', ReasonDetail: '', OldRequiredDate: '', NewRequiredDate: '', ActionTokenID: '', ChangeSetID: String(recovery.changeSetId || ''), OrderVersionBefore: beforeVersion, OrderVersionAfter: afterVersion, RequestID: requestId, Result: rollbackResult, ErrorMessage: restoration.detail }]);
  } catch (_ignored) {}
  try { writeChanges_([{ ChangeSetID: 'ROLLBACK-' + Utilities.getUuid(), OrderID: recovery.order.OrderID, ActionType: action + '_ROLLBACK', FieldName: 'ROLLBACK', FieldLabel: 'Rollback', OldValue: 'PARTIAL_MUTATION', NewValue: restoration.succeeded ? 'RESTORED' : restoration.detail, ChangeReason: '', OrderVersionBefore: beforeVersion, OrderVersionAfter: afterVersion, RequestID: requestId, Source: context ? 'WEB' : 'PUBLIC_TOKEN', Result: rollbackResult }]); } catch (_ignored) {}
  try { writeAppointmentAudit_(context, requestId, recovery.order.OrderID, action + '_ROLLBACK', rollbackResult, { error: 'TRANSACTION_FAILURE', restoration: restoration.detail }); } catch (_ignored) {}
  try { updateRecordByCompositeKey_('RequestLog', appointmentRequestKey_(action, requestId, recovery.order.OrderID, context), { Result: 'TRANSACTION_FAILURE', ResponseData: JSON.stringify({ tokenHash: sha256Hex_(opaqueToken), errorCode: 'TRANSACTION_FAILURE', rollbackResult: rollbackResult }) }); } catch (_ignored) {}
}

function restoreAppointmentStateLocked_(recovery) {
  const result = { succeeded: false, headerRestored: false, tokenRestorations: [], currentVersion: 0, detail: '' };
  const current = findOrderHeader_(recovery.order.OrderID);
  result.currentVersion = Number(current && current.Version || 0);
  const headerAlreadyOriginal = current && appointmentHeaderStateMatches_(current, recovery.header);
  const headerOwned = current && Number(current.Version || 0) === Number(recovery.versionAfter || 0) && String(current.LastChangeSetID || '') === String(recovery.changeSetId || '');
  if (!headerAlreadyOriginal && !headerOwned) {
    result.detail = 'Header ownership could not be proven.';
    return result;
  }
  const currentTokens = readRecords_('ActionTokens', { predicate: function (row) {
    return (recovery.tokens || []).some(function (token) { return String(token.TokenID) === String(row.TokenID); });
  } });
  const byId = {};
  currentTokens.forEach(function (row) { byId[String(row.TokenID)] = row; });
  const tokenOwnership = (recovery.tokens || []).every(function (token) {
    const row = byId[String(token.TokenID)], expected = recovery.expectedTokens[String(token.TokenID)] || token;
    return row && (appointmentTokenStateMatches_(row, token) || appointmentTokenStateMatches_(row, expected));
  });
  if (!tokenOwnership) {
    result.detail = 'Token ownership could not be proven.';
    return result;
  }
  if (headerAlreadyOriginal) result.headerRestored = true;
  else {
    try {
      const restoredHeader = updateRecordByKey_('OrderHeaders', 'OrderID', recovery.order.OrderID, recovery.header);
      result.headerRestored = Boolean(restoredHeader) && appointmentHeaderStateMatches_(restoredHeader, recovery.header);
    } catch (_ignored) { result.headerRestored = false; }
  }
  (recovery.tokens || []).forEach(function (token) {
    const row = byId[String(token.TokenID)];
    let restored = appointmentTokenStateMatches_(row, token);
    if (!restored) {
      try {
        const updated = updateRecordByKey_('ActionTokens', 'TokenID', token.TokenID, { UsedAt: token.UsedAt, UsedBy: token.UsedBy, Status: token.Status });
        restored = appointmentTokenStateMatches_(updated, token);
      } catch (_ignored) { restored = false; }
    }
    result.tokenRestorations.push({ TokenID: token.TokenID, restored: restored });
  });
  result.succeeded = result.headerRestored && result.tokenRestorations.every(function (entry) { return entry.restored; });
  result.currentVersion = result.succeeded ? Number(recovery.order.Version || 0) : Number((findOrderHeader_(recovery.order.OrderID) || {}).Version || result.currentVersion);
  result.detail = result.succeeded ? 'Owned header and token states were restored.' : 'One or more owned state restorations failed.';
  return result;
}

function appointmentHeaderStateMatches_(row, expected) {
  return Boolean(row) && Object.keys(expected || {}).every(function (field) {
    return String(row[field] == null ? '' : row[field]) === String(expected[field] == null ? '' : expected[field]);
  });
}

function appointmentTokenStateMatches_(row, expected) {
  return Boolean(row) && String(row.Status || '') === String(expected.Status || '') && String(row.UsedAt || '') === String(expected.UsedAt || '') && String(row.UsedBy || '') === String(expected.UsedBy || '');
}

function beginAppointmentRequest_(action, requestId, orderId, context, opaqueToken) {
  appendRecords_('RequestLog', [{
    RequestID: requestId, Action: action, OrderID: String(orderId || ''), StaffID: appointmentActorId_(context),
    CreatedAt: new Date().toISOString(), Result: 'TRANSACTION_FAILURE',
    ResponseData: JSON.stringify({ tokenHash: sha256Hex_(opaqueToken), errorCode: 'TRANSACTION_FAILURE' }),
  }]);
}

function completeAppointmentRequest_(action, requestId, orderId, context, opaqueToken, result) {
  updateRecordByCompositeKey_('RequestLog', appointmentRequestKey_(action, requestId, orderId, context), {
    Result: 'SUCCESS', ResponseData: JSON.stringify({ tokenHash: sha256Hex_(opaqueToken), result: result }),
  });
}

function appointmentRequestKey_(action, requestId, orderId, context) {
  return { Action: action, RequestID: requestId, OrderID: String(orderId || ''), StaffID: appointmentActorId_(context) };
}

function findAppointmentRequestReplay_(action, requestId, opaqueToken) {
  const rows = readRecords_('RequestLog', { predicate: function (row) {
    return String(row.Action || '') === String(action || '') && String(row.RequestID || '') === String(requestId || '');
  }, limit: 2 });
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ApiError_('REQUEST_REPLAY', 'This request cannot be replayed.');
  let stored = {};
  try { stored = JSON.parse(String(rows[0].ResponseData || '{}')); } catch (_ignored) {}
  if (String(stored.tokenHash || '') !== sha256Hex_(opaqueToken)) throw new ApiError_('REQUEST_REPLAY', 'This request cannot be replayed.');
  if (String(rows[0].Result || '') !== 'SUCCESS' || !stored.result) throw new ApiError_('REQUEST_REPLAY', 'The previous appointment request did not complete.');
  const result = stored.result;
  result.__appointmentReplay = true;
  return result;
}

function resumeAppointmentMutationReplay_(stored) {
  const result = Object.assign({}, stored);
  delete result.__appointmentReplay;
  const emailLogId = String(result.emailLogId || '');
  let claimed = null, snapshot = null, durableEmail = null;
  if (emailLogId) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const effective = findAppointmentEmailChainOutcome_(emailLogId);
      if (effective && String(effective.log.Result || '') === 'PENDING') {
        snapshot = effective.snapshot;
        claimed = claimPendingEmailAttemptLocked_(effective.log.EmailLogID);
      } else if (effective && ['SUCCESS', 'FAILED'].indexOf(String(effective.log.Result || '')) >= 0) {
        durableEmail = { result: String(effective.log.Result), sentAt: String(effective.log.SentAt || ''), errorMessage: String(effective.log.ErrorMessage || ''), emailLogId: String(effective.log.EmailLogID || '') };
      } else if (effective && String(effective.log.Result || '') === 'SENDING') {
        durableEmail = { result: 'UNCERTAIN', sentAt: String(effective.log.SentAt || ''), errorMessage: 'EMAIL_DELIVERY_UNCERTAIN', emailLogId: String(effective.log.EmailLogID || '') };
      }
    } finally { lock.releaseLock(); }
  }
  if (claimed && snapshot) result.email = deliverPendingEmailAttempt_(claimed, snapshot, { managed: true });
  else if (durableEmail) result.email = durableEmail;
  result.replayed = true;
  return result;
}

function findAppointmentEmailChainOutcome_(rootEmailLogId) {
  const root = String(rootEmailLogId || '');
  const snapshots = {};
  readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === 'EMAIL_SNAPSHOT'; } }).forEach(function (row) {
    try { snapshots[String(row.RequestID || '')] = JSON.parse(String(row.ResponseData || '{}')); } catch (_ignored) {}
  });
  const candidates = readRecords_('EmailLog').map(function (log) { return { log: log, snapshot: snapshots[String(log.EmailLogID || '')] || null }; }).filter(function (entry) {
    return String(entry.log.EmailLogID || '') === root || (entry.snapshot && String(entry.snapshot.rootEmailLogId || '') === root);
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

function appointmentEmailStateRank_(state) {
  const value = String(state || '');
  if (value === 'SUCCESS' || value === 'FAILED') return 3;
  if (value === 'SENDING') return 2;
  if (value === 'PENDING') return 1;
  return 0;
}

function prepareAppointmentEmailLocked_(templateName, model, context, response) {
  if (!templateName || !model) return { emailLogId: '', prepared: false, attempt: null, snapshot: null };
  const emailLogId = 'EML-APT-' + Utilities.getUuid();
  const reserved = createPendingEmailAttempt_(templateName, model, {
    emailLogId: emailLogId, rootEmailLogId: emailLogId, retryCount: 0,
    changeSetId: model.changeSetId || '', sentBy: appointmentActorId_(context), terminalLockHeld: true,
  });
  if (reserved.result || !reserved.attempt) return { emailLogId: String(reserved.result && reserved.result.emailLogId || ''), prepared: false, attempt: null, snapshot: null };
  return { emailLogId: emailLogId, prepared: true, attempt: reserved.attempt, snapshot: reserved.snapshot, response: response };
}

function appendAppointmentResponseLog_(loaded, value) {
  const context = value.context && value.context.user ? value.context.user : {};
  appendRecords_('AppointmentResponseLog', [{
    ResponseLogID: 'APTR-' + Utilities.getUuid(), OrderID: String(loaded.order.OrderID || ''),
    AppointmentSequence: Number(loaded.token.AppointmentSequence || 0), AppointmentDate: String(loaded.order.RequiredDate || ''),
    ActionType: String(value.actionType || ''), ResponseAt: value.now.toISOString(), ResponseSource: context.StaffID ? 'WEB' : 'PUBLIC_TOKEN',
    RespondedByStaffID: String(context.StaffID || ''), RespondedByName: String(context.FullName || ''), Department: String(loaded.order.Department || ''),
    ReasonCode: String(value.reasonCode || ''), ReasonDetail: String(value.reasonDetail || ''), OldRequiredDate: String(value.oldRequiredDate || ''),
    NewRequiredDate: String(value.newRequiredDate || ''), ActionTokenID: String(loaded.token.TokenID || ''), ChangeSetID: String(value.changeSetId || ''),
    OrderVersionBefore: Number(value.versionBefore || 0), OrderVersionAfter: Number(value.versionAfter || 0), RequestID: String(value.requestId || ''),
    Result: String(value.result || 'SUCCESS'), ErrorMessage: '',
  }]);
}

function writeAppointmentChanges_(before, after, fields, reason, requestId, changeSetId, versionAfter, context) {
  const actor = context && context.user ? context.user : {};
  writeChanges_(fields.filter(function (field) { return String(before[field] == null ? '' : before[field]) !== String(after[field] == null ? '' : after[field]); }).map(function (field) {
    return {
      ChangeSetID: changeSetId, OrderID: String(before.OrderID || ''), ChangedByStaffID: String(actor.StaffID || ''),
      ChangedByName: String(actor.FullName || 'Public appointment action'), Department: String(before.Department || ''),
      ChangedByRole: String(actor.Role || 'PUBLIC'), ActionType: String(after.LastChangeType || ''), FieldName: field, FieldLabel: field,
      OldValue: before[field], NewValue: after[field], ChangeReason: String(reason || ''), OrderVersionBefore: Number(before.Version || 0),
      OrderVersionAfter: Number(versionAfter || 0), RequestID: String(requestId || ''), Source: actor.StaffID ? 'WEB' : 'PUBLIC_TOKEN', Result: 'SUCCESS',
    };
  }));
}

function writeAppointmentAudit_(context, requestId, orderId, action, result, detail) {
  const actor = context && context.user ? context.user : {};
  writeAudit_({ StaffID: actor.StaffID || '', Role: actor.Role || 'PUBLIC', Department: actor.Department || '', Action: action, OrderID: orderId, RequestID: requestId, Result: result, Detail: JSON.stringify(detail || {}) });
}

function appointmentEmailModel_(header, context, now, version, extra) {
  const actor = context && context.user ? context.user : { StaffID: 'PUBLIC_ACTION', FullName: 'Public appointment action', Role: 'PUBLIC', Department: header.Department };
  return Object.assign({ header: header, items: getOrderItems_(header.OrderID), actor: actor, eventAt: now.toISOString(), orderVersion: version, changeSetId: header.LastChangeSetID }, extra || {});
}

function normalizeNoShowPayload_(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const allowed = ['token', 'Token', 'reasonCode', 'ReasonCode', 'reasonDetail', 'ReasonDetail'];
  if (Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) throw new ApiError_('VALIDATION_ERROR', 'Invalid no-show response.');
  const token = appointmentPayloadToken_(value, ['token', 'Token']);
  const reasonCode = String(value.reasonCode || value.ReasonCode || '').trim().toUpperCase();
  const reasonDetail = String(value.reasonDetail || value.ReasonDetail || '').trim();
  const codes = appointmentNoShowReasonCodes_();
  const errors = [];
  if (codes.indexOf(reasonCode) < 0) errors.push({ field: 'reasonCode', message: 'A valid no-show reason is required.' });
  if (reasonCode === 'OTHER' && !reasonDetail) errors.push({ field: 'reasonDetail', message: 'Reason detail is required for OTHER.' });
  if (reasonDetail.length > 1000) errors.push({ field: 'reasonDetail', message: 'Reason detail is too long.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid no-show response.', errors);
  return { token: token, reasonCode: reasonCode, reasonDetail: reasonDetail };
}

function normalizeReceivedPayload_(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const allowed = ['token', 'Token'];
  if (Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) throw new ApiError_('VALIDATION_ERROR', 'Invalid received confirmation.');
  if (typeof value.token === 'string' && typeof value.Token === 'string' && value.token.trim() !== value.Token.trim()) throw new ApiError_('VALIDATION_ERROR', 'Invalid received confirmation.');
  return { token: appointmentPayloadToken_(value, allowed) };
}

function appointmentNoShowReasonCodes_() {
  if (typeof getMasterData_ === 'function') return appointmentPublicNoShowReasons_().map(function (entry) { return entry.code; });
  return ['UNREACHABLE', 'PATIENT_UNAVAILABLE', 'TREATED_ELSEWHERE', 'REFUSED_MEDICATION', 'DECEASED', 'UNKNOWN', 'OTHER'];
}

function normalizeReschedulePayload_(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const allowed = ['reference', 'Reference', 'expectedVersion', 'newRequiredDate', 'NewRequiredDate', 'reason', 'Reason'];
  if (Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) throw new ApiError_('VALIDATION_ERROR', 'Invalid reschedule request.');
  const reference = appointmentPayloadToken_(value, ['reference', 'Reference']);
  const expectedVersion = Number(value.expectedVersion);
  const newRequiredDate = String(value.newRequiredDate || value.NewRequiredDate || '').trim();
  const reason = String(value.reason || value.Reason || '').trim();
  const errors = [];
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) errors.push({ field: 'expectedVersion', message: 'Expected version is required.' });
  if (!isValidAppointmentDate_(newRequiredDate)) errors.push({ field: 'newRequiredDate', message: 'A valid appointment date is required.' });
  if (!reason || reason.length > 1000) errors.push({ field: 'reason', message: 'A reschedule reason is required.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid reschedule request.', errors);
  return { reference: reference, expectedVersion: expectedVersion, newRequiredDate: newRequiredDate, reason: reason };
}

function validateNewAppointmentDate_(newDate, oldDate, context, now) {
  const errors = [];
  if (!isValidAppointmentDate_(newDate)) errors.push({ field: 'newRequiredDate', message: 'A valid appointment date is required.' });
  if (newDate === oldDate) errors.push({ field: 'newRequiredDate', message: 'The new appointment date must be different.' });
  const role = context && context.user ? String(context.user.Role || '').toUpperCase() : '';
  if (role !== 'ADMIN' && newDate < appointmentLocalDate_(now)) errors.push({ field: 'newRequiredDate', message: 'The new appointment date cannot be in the past.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid reschedule request.', errors);
}

function isValidAppointmentDate_(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function appointmentLocalDate_(now) {
  return Utilities.formatDate(now || new Date(), String(getSetting_('TIMEZONE', 'Asia/Bangkok')), 'yyyy-MM-dd');
}

function requireAppointmentDepartment_(context, order) {
  const user = context && context.user;
  if (!user || String(user.Department || '') !== String(order && order.Department || '')) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return order;
}

function appointmentPayloadToken_(payload, names) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  let token = '';
  names.forEach(function (name) { if (!token && typeof value[name] === 'string') token = value[name].trim(); });
  return normalizeOpaqueAppointmentToken_(token);
}

function appointmentActorId_(context) { return context && context.user ? String(context.user.StaffID || '') : 'PUBLIC_ACTION'; }
function appointmentSettingEnabled_(key, fallback) { return String(getSetting_(key, fallback ? 'TRUE' : 'FALSE')).trim().toUpperCase() === 'TRUE'; }
function invalidateAppointmentCacheSafe_(orderId) {
  try {
    const order = findOrderHeader_(orderId);
    if (order) invalidateDashboardCache_(String(order.Department || ''));
  } catch (_ignored) {}
}
