const APPOINTMENT_ACTION_TYPES_ = Object.freeze(['RECEIVED', 'NO_SHOW', 'RESCHEDULE']);
const ACTIVE_ACTION_TOKEN_STATUS_ = 'ACTIVE';
const ACTION_TOKEN_BYTES_ = 32;

/** Create one 256-bit opaque token per appointment action and persist hashes only. */
function createAppointmentActionTokenGroup_(order, reminderLogId, groupId, now) {
  const header = order && typeof order === 'object' ? order : {};
  const createdAt = (now || new Date()).toISOString();
  const lifetime = appointmentTokenLifetimeHours_();
  const expiresAt = new Date(new Date(createdAt).getTime() + lifetime * 60 * 60 * 1000).toISOString();
  const prepared = APPOINTMENT_ACTION_TYPES_.map(function (actionType) {
    const rawToken = Utilities.base64EncodeWebSafe(randomBytes_(ACTION_TOKEN_BYTES_)).replace(/=+$/, '');
    const tokenId = 'ATK-' + Utilities.getUuid();
    const requestId = 'APPOINTMENT-' + tokenId;
    return {
      rawToken: rawToken,
      row: {
        TokenID: tokenId,
        TokenHash: sha256Hex_(rawToken),
        OrderID: String(header.OrderID || ''),
        AppointmentSequence: Number(header.AppointmentSequence || 0),
        ActionType: actionType,
        Department: String(header.Department || ''),
        CreatedAt: createdAt,
        ExpiresAt: expiresAt,
        UsedAt: '',
        UsedBy: '',
        Status: ACTIVE_ACTION_TOKEN_STATUS_,
        ReminderLogID: String(reminderLogId || ''),
        RequestID: requestId,
      },
    };
  });
  appendRecords_('ActionTokens', prepared.map(function (entry) { return entry.row; }));
  const byType = {};
  prepared.forEach(function (entry) { byType[entry.row.ActionType] = entry; });
  return {
    groupId: String(groupId || ''),
    expiresAt: expiresAt,
    actionLinks: appointmentActionLinks_(byType),
  };
}

function appointmentTokenLifetimeHours_() {
  const configured = Number(getSetting_('APPOINTMENT_ACTION_TOKEN_HOURS', '168'));
  return Number.isFinite(configured) && configured >= 1 && configured <= 24 * 90 ? configured : 168;
}

function appointmentActionLinks_(byType) {
  const baseUrl = appointmentFrontendBaseUrl_();
  const received = byType.RECEIVED;
  const noShow = byType.NO_SHOW;
  const reschedule = byType.RESCHEDULE;
  return {
    received: baseUrl + '/appointment-action.html?action=received&token=' + encodeURIComponent(received.rawToken) + '&requestId=' + encodeURIComponent(received.row.RequestID),
    noShow: baseUrl + '/appointment-action.html?action=no-show&token=' + encodeURIComponent(noShow.rawToken) + '&requestId=' + encodeURIComponent(noShow.row.RequestID),
    reschedule: baseUrl + '/login.html?next=reschedule&reference=' + encodeURIComponent(reschedule.rawToken) + '&requestId=' + encodeURIComponent(reschedule.row.RequestID),
  };
}

function appointmentFrontendBaseUrl_() {
  const value = String(PropertiesService.getScriptProperties().getProperty('FRONTEND_BASE_URL') || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(value)) throw new Error('Frontend base URL is unavailable.');
  return value;
}

/** Validate a public appointment token without changing any row. */
function loadValidActionToken_(opaqueToken, expectedActionType, now) {
  const raw = normalizeOpaqueAppointmentToken_(opaqueToken);
  const rows = readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.TokenHash || '') === sha256Hex_(raw);
  }, limit: 2 });
  if (rows.length !== 1) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  const token = rows[0];
  const action = String(expectedActionType || '').toUpperCase();
  if (action && String(token.ActionType || '') !== action) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  const status = String(token.Status || '');
  if (status === 'USED' || status === 'REVOKED') throw new ApiError_('TOKEN_REPLAY', 'This appointment link has already been used.');
  const expiry = new Date(token.ExpiresAt).getTime();
  if (!isFinite(expiry)) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  if (status === 'EXPIRED' || expiry <= (now || new Date()).getTime()) throw new ApiError_('ACTION_TOKEN_EXPIRED', 'This appointment link has expired.');
  if (status !== ACTIVE_ACTION_TOKEN_STATUS_) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  const order = findOrderHeader_(token.OrderID);
  if (!order || Number(order.AppointmentSequence || 0) !== Number(token.AppointmentSequence || 0) || String(order.Department || '') !== String(token.Department || '')) {
    throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  }
  if (!isAppointmentActionAllowed_(token.ActionType, order.Status)) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is no longer available.');
  return { token: token, order: order };
}

function normalizeOpaqueAppointmentToken_(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError_('INVALID_ACTION_TOKEN', 'This appointment link is invalid.');
  return token;
}

function isAppointmentActionAllowed_(actionType, status) {
  const current = String(status || '');
  const allowed = {
    RECEIVED: ['NOTIFIED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED'],
    NO_SHOW: ['NOTIFIED', 'APPOINTMENT_RESCHEDULED'],
    RESCHEDULE: ['NOTIFIED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED'],
  };
  return (allowed[String(actionType || '')] || []).indexOf(current) >= 0;
}

function markActionTokenUsedLocked_(token, usedBy, now) {
  return updateRecordByKey_('ActionTokens', 'TokenID', token.TokenID, {
    UsedAt: (now || new Date()).toISOString(), UsedBy: String(usedBy || ''), Status: 'USED',
  });
}

function revokeAppointmentTokensLocked_(orderId, appointmentSequence, usedTokenId, now) {
  const active = readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '') &&
      Number(row.AppointmentSequence || 0) === Number(appointmentSequence || 0) &&
      String(row.Status || '') === ACTIVE_ACTION_TOKEN_STATUS_;
  } });
  active.forEach(function (token) {
    updateRecordByKey_('ActionTokens', 'TokenID', token.TokenID, {
      UsedAt: (now || new Date()).toISOString(), UsedBy: 'SYSTEM', Status: String(token.TokenID) === String(usedTokenId || '') ? 'USED' : 'REVOKED',
    });
  });
  return active.length;
}

function revokeReminderTokensLocked_(reminderLogId, now) {
  const active = readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.ReminderLogID || '') === String(reminderLogId || '') && String(row.Status || '') === ACTIVE_ACTION_TOKEN_STATUS_;
  } });
  active.forEach(function (token) {
    updateRecordByKey_('ActionTokens', 'TokenID', token.TokenID, { UsedAt: (now || new Date()).toISOString(), UsedBy: 'SYSTEM', Status: 'REVOKED' });
  });
  return active.length;
}

function captureActiveOrderTokensLocked_(orderId) {
  return readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '') && String(row.Status || '') === ACTIVE_ACTION_TOKEN_STATUS_;
  } }).map(function (row) {
    return { TokenID: row.TokenID, Status: row.Status || '', UsedAt: row.UsedAt || '', UsedBy: row.UsedBy || '', CancellationRequestID: row.CancellationRequestID || '', CancellationPreviousStatus: row.CancellationPreviousStatus || '' };
  });
}

/** Cancellation invalidates every still-active appointment action for the order. */
function revokeActiveOrderTokensLocked_(orderId, usedBy, now, cancellationRequestId) {
  const timestamp = (now || new Date()).toISOString();
  const active = captureActiveOrderTokensLocked_(orderId);
  active.forEach(function (token) {
    const updated = updateRecordByKey_('ActionTokens', 'TokenID', token.TokenID, {
      Status: 'REVOKED', UsedAt: timestamp, UsedBy: String(usedBy || ''),
      CancellationRequestID: String(cancellationRequestId || ''), CancellationPreviousStatus: String(token.Status || ''),
    });
    if (!updated || String(updated.Status || '') !== 'REVOKED') throw new Error('Action token revocation failed.');
  });
  return active.map(function (token) {
    return {
      TokenID: token.TokenID, Status: 'REVOKED', UsedAt: timestamp, UsedBy: String(usedBy || ''),
      CancellationRequestID: String(cancellationRequestId || ''), CancellationPreviousStatus: String(token.Status || ''),
    };
  });
}

function captureCancellationTokensLocked_(orderId, cancellationRequestId) {
  return readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '')
      && String(row.CancellationRequestID || '') === String(cancellationRequestId || '');
  } }).map(function (row) {
    return {
      TokenID: row.TokenID, Status: row.Status || '', UsedAt: row.UsedAt || '', UsedBy: row.UsedBy || '',
      CancellationRequestID: row.CancellationRequestID || '', CancellationPreviousStatus: row.CancellationPreviousStatus || '',
    };
  });
}

function restoreRejectedCancelTokensLocked_(orderId, cancellationRequestId, now) {
  const timestamp = (now || new Date()).getTime();
  return readRecords_('ActionTokens', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '')
      && String(row.CancellationRequestID || '') === String(cancellationRequestId || '')
      && String(row.Status || '') === 'REVOKED'
      && String(row.CancellationPreviousStatus || '') === 'ACTIVE';
  } }).map(function (row) {
    const expires = new Date(row.ExpiresAt).getTime();
    const status = !isFinite(expires) || expires <= timestamp ? 'EXPIRED' : 'ACTIVE';
    const updates = { Status: status, UsedAt: '', UsedBy: '' };
    const restored = updateRecordByKey_('ActionTokens', 'TokenID', row.TokenID, updates);
    if (!restored || String(restored.Status || '') !== status) throw new Error('Cancellation token restoration failed.');
    return Object.assign({ TokenID: row.TokenID }, updates, {
      CancellationRequestID: row.CancellationRequestID || '',
      CancellationPreviousStatus: row.CancellationPreviousStatus || '',
    });
  });
}

/** Mark expired tokens explicitly; the action validator itself remains read-only. */
function expireActionTokens() {
  const lock = LockService.getScriptLock();
  const now = new Date();
  let expired = 0;
  lock.waitLock(30000);
  try {
    const rows = readRecords_('ActionTokens', { predicate: function (row) {
      return String(row.Status || '') === ACTIVE_ACTION_TOKEN_STATUS_ && new Date(row.ExpiresAt).getTime() <= now.getTime();
    } });
    rows.forEach(function (row) {
      if (updateRecordByKey_('ActionTokens', 'TokenID', row.TokenID, { Status: 'EXPIRED' })) expired += 1;
    });
    if (expired) writeAudit_({ StaffID: 'SYSTEM', Role: 'SYSTEM', Action: 'EXPIRE_ACTION_TOKENS', Result: 'SUCCESS', Detail: JSON.stringify({ expired: expired }) });
  } finally {
    lock.releaseLock();
  }
  return { expired: expired };
}
