/**
 * Medication Reservation System — single-file Google Apps Script bundle.
 * Generated from the backend/*.gs sources. Do not add appsscript.json here.
 * Source files: 25
 */

/**
 * Bundled from backend/Code.gs
 */
/**
 * Explicit, operator-only initialization. This function is never routed from
 * doGet/doPost; run it once after Script Properties are configured.
 */
function setupApplication() {
  const properties = PropertiesService.getScriptProperties();
  const configuration = validateSetupConfiguration_(properties.getProperties());
  if (!configuration.valid) return { initialized: false, healthy: false, configurationErrors: configuration.errors };
  properties.setProperty('FRONTEND_BASE_URL', configuration.normalized.FRONTEND_BASE_URL);
  const health = initializeDatabase();
  const reminderTrigger = setupAppointmentReminderTrigger();
  return { initialized: true, healthy: Boolean(health && health.healthy), health: health, reminderTrigger: reminderTrigger };
}

function doPost(event) {
  let requestId = '';
  try {
    const request = parsePostRequest_(event);
    requestId = request.requestId;
    const metadata = {};
    return jsonResponse_(apiSuccess_(routeApiRequest_(request, metadata), requestId, '', metadata));
  } catch (error) {
    return jsonResponse_(apiFailure_(error, requestId));
  }
}

function doGet(event) {
  let requestId = '';
  try {
    // GET is intentionally routed only through the closed, non-mutating preview registry.
    const request = parseGetRequest_(event);
    requestId = request.requestId;
    const metadata = {};
    return jsonResponse_(apiSuccess_(routeApiRequest_(request, metadata), requestId, '', metadata));
  } catch (error) {
    return jsonResponse_(apiFailure_(error, requestId));
  }
}

/**
 * Bundled from backend/ActionTokenService.gs
 */
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

/**
 * Bundled from backend/ApiRouter.gs
 */
/** API registry is the single authorization boundary for every non-public action. */
const API_ACTIONS_ = Object.freeze({
  LOGIN: Object.freeze({ auth: false, mutates: true, handler: 'login_' }),
  LOGOUT: Object.freeze({ auth: true, mutates: true, handler: 'logout_' }),
  GET_MASTER_DATA: Object.freeze({ auth: true, mutates: false, handler: 'getMasterData_' }),
  GET_STAFF_DASHBOARD: Object.freeze({ auth: true, mutates: false, handler: 'getStaffDashboard_' }),
  CREATE_ORDER: Object.freeze({ auth: true, mutates: true, handler: 'createOrder_' }),
  LIST_DEPARTMENT_ORDERS: Object.freeze({ auth: true, mutates: false, handler: 'listDepartmentOrders_' }),
  GET_ORDER_DETAIL: Object.freeze({ auth: true, mutates: false, handler: 'getOrderDetail_' }),
  UPDATE_ORDER: Object.freeze({ auth: true, mutates: true, handler: 'updateOrderByStaff_' }),
  CANCEL_ORDER: Object.freeze({ auth: true, mutates: true, handler: 'cancelOrderByStaff_' }),
  GET_ORDER_CHANGE_LOG: Object.freeze({ auth: true, mutates: false, handler: 'getOrderChangeLog_' }),
  GET_APPOINTMENT_HISTORY: Object.freeze({ auth: true, mutates: false, handler: 'getAppointmentHistory_' }),
  GET_ADMIN_DASHBOARD: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: false, handler: 'getAdminDashboard_' }),
  LIST_ALL_ORDERS: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: false, handler: 'listAllOrders_' }),
  UPDATE_RECEIVED_ITEMS: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'updateReceivedItems_' }),
  DECIDE_CANCELLATION: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'decideCancellationByAdmin_' }),
  SEND_ORDER_EMAIL: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'sendOrderEmail_' }),
  RESEND_FAILED_EMAIL: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'resendFailedEmail_' }),
  CONFIRM_PATIENT_RECEIVED: Object.freeze({ auth: false, mutates: true, handler: 'confirmPatientReceived_' }),
  SUBMIT_PATIENT_NO_SHOW: Object.freeze({ auth: false, mutates: true, handler: 'submitPatientNoShow_' }),
  GET_RESCHEDULE_ORDER: Object.freeze({ auth: true, mutates: false, handler: 'getRescheduleOrder_' }),
  SUBMIT_APPOINTMENT_RESCHEDULE: Object.freeze({ auth: true, mutates: true, handler: 'submitAppointmentReschedule_' }),
  GET_DATABASE_HEALTH: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: false, handler: 'getDatabaseHealth' }),
});

const GET_ACTIONS_ = Object.freeze({
  GET_APPOINTMENT_ACTION: Object.freeze({ auth: false, mutates: false, handler: 'getAppointmentAction_' }),
  GET_RESCHEDULE_REFERENCE: Object.freeze({ auth: false, mutates: false, handler: 'getRescheduleReference_' }),
});

function routeApiRequest_(request, responseMetadata) {
  const actions = request.method === 'GET' ? GET_ACTIONS_ : API_ACTIONS_;
  const action = actions[request.action];
  if (!action) throw new ApiError_('UNKNOWN_ACTION', 'Unsupported action.');
  if (request.method === 'GET' && action.mutates) throw new ApiError_('METHOD_NOT_ALLOWED', 'Unsupported action.');
  let context = null;
  if (action.auth) {
    context = requireSession_(request.sessionToken, { touch: true });
    if (action.roles) requireRole_(context, action.roles);
    if (responseMetadata && typeof responseMetadata === 'object') responseMetadata.sessionExpiresAt = String(context.expiresAt || '');
  }
  return invokeApiAction_(request.action, action, context, request);
}

function invokeApiAction_(actionName, action, context, request) {
  if (actionName === 'LOGIN') return login_(request.payload, request.requestId);
  if (actionName === 'LOGOUT') return logout_(context);
  if (actionName === 'GET_MASTER_DATA') return getMasterData_(request.payload.types);
  if (actionName === 'GET_DATABASE_HEALTH') return getDatabaseHealth();
  if (actionName === 'GET_ORDER_DETAIL') return getOrderDetail_(context, requireOrderId_(request.payload));
  if (actionName === 'GET_ORDER_CHANGE_LOG') return getOrderChangeLog_(context, requireOrderId_(request.payload));
  if (actionName === 'GET_APPOINTMENT_HISTORY') return getAppointmentHistory_(context, requireOrderId_(request.payload));
  if (actionName === 'RESEND_FAILED_EMAIL') return resendFailedEmail_(context, request.payload && request.payload.EmailLogID, request.requestId);
  if (actionName === 'GET_APPOINTMENT_ACTION') return getAppointmentAction_(requireAppointmentToken_(request.payload, 'token'));
  if (actionName === 'GET_RESCHEDULE_REFERENCE') return getRescheduleReference_(requireAppointmentToken_(request.payload, 'reference'));
  if (actionName === 'CONFIRM_PATIENT_RECEIVED') return confirmPatientReceived_(request.payload, request.requestId);
  if (actionName === 'SUBMIT_PATIENT_NO_SHOW') return submitPatientNoShow_(request.payload, request.requestId);
  if (actionName === 'GET_RESCHEDULE_ORDER') return getRescheduleOrder_(context, requireAppointmentToken_(request.payload, 'reference'));
  const handler = resolveApiHandler_(action.handler);
  return handler(context, request.payload, request.requestId, request);
}

function requireAppointmentToken_(payload, field) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload[field] : '';
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > 256) throw new ApiError_('VALIDATION_ERROR', 'Invalid appointment link.', [{ field: field, message: 'Appointment token is required.' }]);
  return token;
}

function requireOrderId_(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.OrderID : null;
  const orderId = typeof value === 'string' ? value.trim() : '';
  if (!orderId || orderId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(orderId)) throw new ApiError_('VALIDATION_ERROR', 'Invalid order ID.', [{ field: 'OrderID', message: 'OrderID is required.' }]);
  return orderId;
}

function resolveApiHandler_(name) {
  try {
    switch (name) {
      case 'getStaffDashboard_': return getStaffDashboard_;
      case 'createOrder_': return createOrder_;
      case 'listDepartmentOrders_': return listDepartmentOrders_;
      case 'getOrderDetail_': return getOrderDetail_;
      case 'updateOrderByStaff_': return updateOrderByStaff_;
      case 'cancelOrderByStaff_': return cancelOrderByStaff_;
      case 'getOrderChangeLog_': return getOrderChangeLog_;
      case 'getAppointmentHistory_': return getAppointmentHistory_;
      case 'getAdminDashboard_': return getAdminDashboard_;
      case 'listAllOrders_': return listAllOrders_;
      case 'updateReceivedItems_': return updateReceivedItems_;
      case 'decideCancellationByAdmin_': return decideCancellationByAdmin_;
      case 'sendOrderEmail_': return sendOrderEmail_;
      case 'resendFailedEmail_': return resendFailedEmail_;
      case 'confirmPatientReceived_': return confirmPatientReceived_;
      case 'submitPatientNoShow_': return submitPatientNoShow_;
      case 'getRescheduleOrder_': return getRescheduleOrder_;
      case 'submitAppointmentReschedule_': return submitAppointmentReschedule_;
      case 'getAppointmentAction_': return getAppointmentAction_;
      case 'getRescheduleReference_': return getRescheduleReference_;
      default: throw new ApiError_('UNKNOWN_ACTION', 'Unsupported action.');
    }
  } catch (_ignored) {
    throw new ApiError_('NOT_IMPLEMENTED', 'This action is not available.');
  }
}

/**
 * Bundled from backend/AppointmentService.gs
 */
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

/**
 * Bundled from backend/AuditService.gs
 */
/** Append immutable audit records; callers supply only business-safe values. */
function writeAudit_(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const now = new Date().toISOString();
  return appendRecords_('AuditLog', [{
    AuditID: String(value.AuditID || ('AUD-' + Utilities.getUuid())),
    Timestamp: value.Timestamp || now,
    StaffID: String(value.StaffID || ''),
    Role: String(value.Role || ''),
    Department: String(value.Department || ''),
    Action: String(value.Action || ''),
    OrderID: String(value.OrderID || ''),
    OrderItemID: String(value.OrderItemID || ''),
    RequestID: String(value.RequestID || ''),
    OldValue: value.OldValue == null ? '' : JSON.stringify(value.OldValue),
    NewValue: value.NewValue == null ? '' : JSON.stringify(value.NewValue),
    Result: String(value.Result || 'SUCCESS'),
    Detail: String(value.Detail || ''),
  }]);
}

/**
 * Bundled from backend/AuthorizationService.gs
 */
function requireRole_(context, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  const role = context && context.user ? String(context.user.Role || '').toUpperCase() : '';
  if (allowed.map(function (value) { return String(value).toUpperCase(); }).indexOf(role) < 0) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return context;
}

function requireOrderAccess_(context, order) {
  const user = context && context.user;
  const role = user ? String(user.Role || '').toUpperCase() : '';
  const requestedDepartment = order ? String(order.Department || '') : '';
  if (!user || !order || (role !== 'ADMIN' && String(user.Department || '') !== requestedDepartment)) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return order;
}

/**
 * Bundled from backend/AuthService.gs
 */
/**
 * LOGIN is exempt from business-mutation idempotent replay: a raw session
 * token is returned once and cannot be safely persisted for replay.
 */
function login_(payload, requestId) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const pin = typeof payload.pin === 'string' ? payload.pin : '';
  const user = findUserByStaffId_(staffId);
  const activeUser = userIsActive_(user) ? user : null;
  assertLoginAttemptAllowed_(activeUser, requestId);
  // PIN verification is intentionally outside every Apps Script lock.
  const hashMatches = verifyPinHash_(pin, activeUser ? activeUser.PINHash : loginDummyPinHash_());
  const verified = Boolean(activeUser) && hashMatches;
  const outcome = recordLoginAttempt_(activeUser, verified, requestId);
  if (outcome.throttled) throw loginThrottleError_(outcome.retryAfterSeconds);
  if (!verified) throw new ApiError_('INVALID_CREDENTIALS', 'Invalid staff ID or PIN.');
  const created = createSession_(staffId);
  const identity = trustedIdentity_(user);
  delete identity.PINHash;
  return { sessionToken: created.rawToken, expiresAt: created.expiresAt, user: identity, requestId: requestId };
}

function assertLoginAttemptAllowed_(user, requestId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const globalState = readGlobalLoginThrottleState_();
    const identityState = user ? loginThrottleStateFromUser_(user) : null;
    const retryAfter = user ? loginRetryAfterSeconds_(identityState, now) : loginRetryAfterSeconds_(globalState, now);
    if (retryAfter > 0) {
      writeLoginAuditSafe_(user, requestId, 'THROTTLED', { retryAfterSeconds: retryAfter });
      throw loginThrottleError_(retryAfter);
    }
  } catch (error) {
    if (error && error.name === 'ApiError') throw error;
    throw loginThrottleError_(60);
  } finally {
    lock.releaseLock();
  }
}

function recordLoginAttempt_(user, verified, requestId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const globalState = readGlobalLoginThrottleState_();
    const identityState = user ? loginThrottleStateFromUser_(findUserByStaffId_(user.StaffID) || user) : null;
    const concurrentRetry = user ? loginRetryAfterSeconds_(identityState, now) : loginRetryAfterSeconds_(globalState, now);
    if (concurrentRetry > 0) {
      writeLoginAuditSafe_(user, requestId, 'THROTTLED', { retryAfterSeconds: concurrentRetry });
      return { throttled: true, retryAfterSeconds: concurrentRetry };
    }
    if (verified) {
      if (user) updateRecordByKey_('Users', 'StaffID', user.StaffID, {
        FailedLoginWindowStartedAt: '', FailedLoginCount: 0, LoginLockedUntil: '', LastFailedLoginAt: '',
      });
      writeLoginAuditSafe_(user, requestId, 'SUCCESS', {});
      return { throttled: false, retryAfterSeconds: 0 };
    }

    let nextGlobal = globalState;
    if (user) {
      const nextIdentity = incrementLoginThrottleState_(identityState, loginIdentityFailureLimit_(), now);
      updateRecordByKey_('Users', 'StaffID', user.StaffID, {
        FailedLoginWindowStartedAt: nextIdentity.windowStartedAt,
        FailedLoginCount: nextIdentity.failureCount,
        LoginLockedUntil: nextIdentity.lockedUntil,
        LastFailedLoginAt: nextIdentity.lastFailureAt,
      });
    } else {
      nextGlobal = incrementLoginThrottleState_(globalState, loginGlobalFailureLimit_(), now);
      writeGlobalLoginThrottleState_(nextGlobal, now);
    }
    writeLoginAuditSafe_(user, requestId, 'FAILURE', {
      identityKnown: Boolean(user),
      globalFailureCount: nextGlobal.failureCount,
    });
    return { throttled: false, retryAfterSeconds: 0 };
  } catch (error) {
    if (error && error.name === 'ApiError') throw error;
    throw loginThrottleError_(60);
  } finally {
    lock.releaseLock();
  }
}

function readGlobalLoginThrottleState_() {
  const rows = readRecords_('Settings', { predicate: function (row) {
    return String(row.Key || '') === 'LOGIN_GLOBAL_THROTTLE_STATE';
  }, limit: 1 });
  if (!rows.length || !String(rows[0].Value || '').trim()) return emptyLoginThrottleState_();
  try {
    const parsed = JSON.parse(String(rows[0].Value));
    return normalizeLoginThrottleState_(parsed);
  } catch (_ignored) {
    throw new Error('Global login throttle state is invalid.');
  }
}

function writeGlobalLoginThrottleState_(state, now) {
  const value = JSON.stringify(normalizeLoginThrottleState_(state));
  const updated = updateRecordByKey_('Settings', 'Key', 'LOGIN_GLOBAL_THROTTLE_STATE', {
    Value: value, UpdatedAt: (now || new Date()).toISOString(), UpdatedBy: 'SYSTEM',
  });
  if (!updated) {
    appendRecords_('Settings', [{
      Key: 'LOGIN_GLOBAL_THROTTLE_STATE', Value: value,
      Description: 'Runtime global login throttle state; operator managed through recovery helpers only',
      UpdatedAt: (now || new Date()).toISOString(), UpdatedBy: 'SYSTEM',
    }]);
  }
}

function loginThrottleStateFromUser_(user) {
  return normalizeLoginThrottleState_({
    windowStartedAt: user && user.FailedLoginWindowStartedAt,
    failureCount: user && user.FailedLoginCount,
    lockedUntil: user && user.LoginLockedUntil,
    lastFailureAt: user && user.LastFailedLoginAt,
  });
}

function emptyLoginThrottleState_() {
  return { windowStartedAt: '', failureCount: 0, lockedUntil: '', lastFailureAt: '' };
}

function normalizeLoginThrottleState_(value) {
  const state = value && typeof value === 'object' ? value : {};
  const count = Number(state.failureCount || 0);
  return {
    windowStartedAt: String(state.windowStartedAt || ''),
    failureCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    lockedUntil: String(state.lockedUntil || ''),
    lastFailureAt: String(state.lastFailureAt || ''),
  };
}

function incrementLoginThrottleState_(state, limit, now) {
  const current = normalizeLoginThrottleState_(state);
  const windowMs = loginFailureWindowMinutes_() * 60 * 1000;
  const started = new Date(current.windowStartedAt).getTime();
  const reset = !isFinite(started) || now.getTime() - started >= windowMs;
  const failureCount = (reset ? 0 : current.failureCount) + 1;
  return {
    windowStartedAt: reset ? now.toISOString() : current.windowStartedAt,
    failureCount: failureCount,
    lockedUntil: failureCount >= limit ? new Date(now.getTime() + loginLockoutMinutes_() * 60 * 1000).toISOString() : '',
    lastFailureAt: now.toISOString(),
  };
}

function loginRetryAfterSeconds_(state, now) {
  if (!state) return 0;
  const until = new Date(state.lockedUntil).getTime();
  return isFinite(until) && until > now.getTime() ? Math.max(1, Math.ceil((until - now.getTime()) / 1000)) : 0;
}

function boundedLoginSetting_(key, fallback, minimum, maximum) {
  const value = Number(getSetting_(key, String(fallback)));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? Math.floor(value) : fallback;
}

function loginIdentityFailureLimit_() { return boundedLoginSetting_('LOGIN_IDENTITY_FAILURE_LIMIT', 5, 2, 20); }
function loginGlobalFailureLimit_() { return boundedLoginSetting_('LOGIN_GLOBAL_FAILURE_LIMIT', 50, 10, 1000); }
function loginFailureWindowMinutes_() { return boundedLoginSetting_('LOGIN_FAILURE_WINDOW_MINUTES', 15, 1, 1440); }
function loginLockoutMinutes_() { return boundedLoginSetting_('LOGIN_LOCKOUT_MINUTES', 15, 1, 1440); }

function loginDummyPinHash_() {
  return ['HMAC-SHA256$v2$', new Array(23).join('A'), '$', new Array(44).join('A')].join('');
}

function loginThrottleError_(retryAfterSeconds) {
  const error = new ApiError_('LOGIN_THROTTLED', 'Invalid staff ID or PIN.');
  error.retryAfterSeconds = Math.max(1, Math.min(86400, Math.ceil(Number(retryAfterSeconds) || 60)));
  return error;
}

function writeLoginAuditSafe_(user, requestId, result, detail) {
  try {
    writeAudit_({
      StaffID: user ? String(user.StaffID || '') : '',
      Role: user ? String(user.Role || '') : '',
      Department: user ? String(user.Department || '') : '',
      Action: 'LOGIN', RequestID: String(requestId || ''), Result: result,
      Detail: JSON.stringify(detail || {}),
    });
  } catch (_ignored) {}
}

/** Operator-only recovery helper. This function is intentionally not an API action. */
function unlockLoginIdentity(staffId) {
  const normalized = String(staffId || '').trim();
  if (!normalized) throw new Error('StaffID is required.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const user = findUserByStaffId_(normalized);
    if (!user) return { unlocked: false };
    const updated = updateRecordByKey_('Users', 'StaffID', normalized, {
      FailedLoginWindowStartedAt: '', FailedLoginCount: 0, LoginLockedUntil: '', LastFailedLoginAt: '',
    });
    if (!updated) throw new Error('Login identity could not be unlocked.');
    try {
      writeAudit_({ StaffID: normalized, Role: 'SYSTEM', Department: String(user.Department || ''), Action: 'UNLOCK_LOGIN_IDENTITY', Result: 'SUCCESS', Detail: 'Operator recovery helper' });
    } catch (_ignored) {}
    return { unlocked: true };
  } finally {
    lock.releaseLock();
  }
}

/** Operator-only recovery helper for a global denial-of-service lockout. */
function unlockGlobalLoginThrottle() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeGlobalLoginThrottleState_(emptyLoginThrottleState_(), new Date());
    try { writeAudit_({ StaffID: 'SYSTEM', Role: 'SYSTEM', Action: 'UNLOCK_GLOBAL_LOGIN_THROTTLE', Result: 'SUCCESS', Detail: 'Operator recovery helper' }); } catch (_ignored) {}
    return { unlocked: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bundled from backend/ChangeLogService.gs
 */
/** Append immutable change entries in a single batch. */
function writeChanges_(entries) {
  const changes = Array.isArray(entries) ? entries : [];
  if (!changes.length) return { startRow: null, rowCount: 0 };
  const now = new Date().toISOString();
  return appendRecords_('OrderChangeLog', changes.map(function (entry) {
    entry = entry || {};
    return {
      ChangeLogID: String(entry.ChangeLogID || ('CHG-' + Utilities.getUuid())),
      ChangeSetID: String(entry.ChangeSetID || ''),
      OrderID: String(entry.OrderID || ''),
      OrderItemID: String(entry.OrderItemID || ''),
      ChangedAt: entry.ChangedAt || now,
      ChangedByStaffID: String(entry.ChangedByStaffID || ''),
      ChangedByName: String(entry.ChangedByName || ''),
      Department: String(entry.Department || ''),
      ChangedByRole: String(entry.ChangedByRole || ''),
      ActionType: String(entry.ActionType || ''),
      FieldName: String(entry.FieldName || ''),
      FieldLabel: String(entry.FieldLabel || ''),
      OldValue: entry.OldValue == null ? '' : JSON.stringify(entry.OldValue),
      NewValue: entry.NewValue == null ? '' : JSON.stringify(entry.NewValue),
      ChangeReason: String(entry.ChangeReason || ''),
      OrderVersionBefore: entry.OrderVersionBefore == null ? '' : entry.OrderVersionBefore,
      OrderVersionAfter: entry.OrderVersionAfter == null ? '' : entry.OrderVersionAfter,
      RequestID: String(entry.RequestID || ''),
      Source: String(entry.Source || 'WEB'),
      Result: String(entry.Result || 'SUCCESS'),
    };
  }));
}

/**
 * Bundled from backend/ConfigService.gs
 */
const SETTINGS_CACHE_KEY_ = 'MEDICATION_RESERVATION_SETTINGS_V1';
const SETTINGS_CACHE_SECONDS_ = 300;

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SETTINGS_CACHE_KEY_);
  if (cached) return JSON.parse(cached);
  const settings = readRecords_('Settings').reduce(function (result, record) {
    const key = String(record.Key || '').trim();
    if (key) result[key] = String(record.Value == null ? '' : record.Value);
    return result;
  }, {});
  cache.put(SETTINGS_CACHE_KEY_, JSON.stringify(settings), SETTINGS_CACHE_SECONDS_);
  return settings;
}

function getSetting_(key, fallbackValue) {
  const settings = getSettings_();
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallbackValue;
}

function clearConfigurationCaches_() {
  const cache = CacheService.getScriptCache();
  cache.remove(SETTINGS_CACHE_KEY_);
  cache.remove(MASTER_DATA_CACHE_KEY_);
}

/**
 * Bundled from backend/EmailService.gs
 */
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
    NEW_ORDER: '[New Medication Reservation] Order ID: ',
    ORDER_UPDATE: '[Medication Reservation Updated] Order ID: ',
    CANCELLATION: '[Medication Reservation Cancelled] Order ID: ',
    MEDICATION_RECEIVED: '[Medication Received] Order ID: ',
    APPOINTMENT_DUE: '[แจ้งเตือนวันนัดรับยา] Order ID: ',
    APPOINTMENT_RESCHEDULED: '[แจ้งเลื่อนวันนัดรับยา] Order ID: ',
    PATIENT_RECEIVED_CONFIRMATION: '[Patient Received Medication] Order ID: ',
    PATIENT_NO_SHOW: '[Patient No-show] Order ID: ',
  };
  if (!titleByTemplate[name]) throw new Error('Unsupported email template.');

  let fields = [];
  if (name === 'NEW_ORDER') {
    fields = [['Order ID', orderId], ['Created at', emailText_(header.CreatedAt)], ['Department', emailText_(header.Department)], ['Requester', emailText_(header.CreatedByName)], ['HN', maskEmailHn_(header.HN)], ['Patient', maskEmailPatient_(header.PatientName)], ['Required date', emailText_(header.RequiredDate)], ['Item count', String(items.length || header.ItemCount || 0)], ['Status', emailText_(header.Status)]];
  } else if (name === 'ORDER_UPDATE') {
    fields = [['Changed by', emailText_(value.changedBy || actor.FullName || actor.StaffID)], ['Changed at', emailText_(value.changedAt || value.eventAt || header.UpdatedAt)], ['Change reason', emailText_(value.changeReason)], ['Version', emailText_(header.Version)]];
  } else if (name === 'CANCELLATION') {
    fields = [['Order ID', orderId], ['Department', emailText_(header.Department)], ['HN', maskEmailHn_(header.HN)], ['Patient', maskEmailPatient_(header.PatientName)], ['Previous status', emailText_(value.previousStatus)], ['New status', emailText_(header.Status)], ['Cancel reason', emailText_(value.cancelReason || header.CancelReason)], ['Cancelled by', emailText_(value.cancelledBy || header.CancelledBy)], ['Cancelled at', emailText_(value.cancelledAt || header.CancelledAt)]];
  } else if (name === 'MEDICATION_RECEIVED') {
    fields = [['Order ID', orderId], ['Current status', emailText_(header.Status)]];
  } else if (name === 'APPOINTMENT_DUE') {
    fields = [['Department', emailText_(header.Department)], ['HN', maskEmailHn_(header.HN)], ['Patient', maskEmailPatient_(header.PatientName)], ['Required date', emailText_(header.RequiredDate)], ['Item count', String(items.length || header.ItemCount || 0)], ['Current status', emailText_(header.Status)]];
  } else if (name === 'APPOINTMENT_RESCHEDULED') {
    fields = [['Old required date', emailText_(value.oldRequiredDate || header.LastRequiredDate)], ['New required date', emailText_(value.newRequiredDate || header.RequiredDate)], ['Changed by', emailText_(value.changedBy || actor.FullName || actor.StaffID)], ['Reason', emailText_(value.reason)], ['Reminder', 'A new reminder will be sent on the new appointment date.']];
  } else if (name === 'PATIENT_RECEIVED_CONFIRMATION') {
    fields = [['Order ID', orderId], ['Department', emailText_(header.Department)], ['Appointment date', emailText_(header.RequiredDate)], ['Response', 'PATIENT_RECEIVED'], ['Recorded at', emailText_(value.eventAt || header.PatientReceivedAt)]];
  } else if (name === 'PATIENT_NO_SHOW') {
    fields = [['Order ID', orderId], ['Department', emailText_(header.Department)], ['Appointment date', emailText_(header.RequiredDate)], ['Response', 'PATIENT_NO_SHOW'], ['Reason code', emailText_(value.reasonCode || header.NoShowReasonCode)], ['Reason detail', emailText_(value.reasonDetail || header.NoShowReasonDetail)], ['Recorded at', emailText_(value.eventAt || header.NoShowRecordedAt)]];
  }

  const changed = name === 'ORDER_UPDATE' && Array.isArray(value.changes) ? value.changes : [];
  const changedLines = changed.map(function (change) {
    const itemPrefix = emailText_(change.itemId || change.OrderItemID);
    const field = emailText_(change.field || change.FieldName);
    const label = itemPrefix ? itemPrefix + ' ' + field : field;
    return label + ': ' + maskEmailChangeValue_(field, change.oldValue == null ? change.OldValue : change.oldValue) + ' → ' + maskEmailChangeValue_(field, change.newValue == null ? change.NewValue : change.newValue);
  });
  const rendersItems = name === 'NEW_ORDER' || name === 'MEDICATION_RECEIVED';
  const itemLines = rendersItems ? items.map(function (item) {
    const itemName = emailText_(item.GenericName || item.MedicationName);
    if (name === 'NEW_ORDER') return itemName + '; Requested: ' + emailText_(item.RequestedQuantity) + ' ' + emailText_(item.Unit);
    const status = emailText_(item.ItemStatus || item.Status);
    const received = emailText_(item.ReceivedQuantity) + ' ' + emailText_(item.ReceivedUnit || item.Unit);
    return itemName + ' — Item status: ' + status + (name === 'MEDICATION_RECEIVED' ? '; Received: ' + received : '');
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

/**
 * Bundled from backend/MasterDataService.gs
 */
const MASTER_DATA_CACHE_KEY_ = 'MEDICATION_RESERVATION_' + 'MASTER_DATA_V1';
const MASTER_DATA_CACHE_SECONDS_ = 300;

function getMasterData_(types) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MASTER_DATA_CACHE_KEY_);
  const allData = cached ? JSON.parse(cached) : loadActiveMasterData_();
  if (!cached) cache.put(MASTER_DATA_CACHE_KEY_, JSON.stringify(allData), MASTER_DATA_CACHE_SECONDS_);
  const requestedTypes = types == null ? Object.keys(allData) : (Array.isArray(types) ? types : [types]);
  return requestedTypes.reduce(function (result, type) {
    const name = String(type || '').trim();
    if (name) result[name] = allData[name] ? allData[name].slice() : [];
    return result;
  }, {});
}

function loadActiveMasterData_() {
  return readRecords_('MasterData').reduce(function (result, record) {
    const type = String(record.Type || '').trim();
    const code = String(record.Code || '').trim();
    const active = String(record.Active).toUpperCase() !== 'FALSE';
    if (!type || !code || !active) return result;
    if (!result[type]) result[type] = [];
    result[type].push({ Code: code, DisplayName: String(record.DisplayName || code), SortOrder: record.SortOrder, Active: true });
    return result;
  }, {});
}

/**
 * Bundled from backend/OrderIdService.gs
 */
/** Allocate order and item identifiers while the caller owns the script lock. */
function generateOrderIds_(itemCount, now) {
  const count = Number(itemCount);
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new ApiError_('VALIDATION_ERROR', 'Invalid medication items.');
  const generatedAt = now instanceof Date ? now : new Date();
  if (!isFinite(generatedAt.getTime())) throw new ApiError_('VALIDATION_ERROR', 'Invalid creation time.');
  const prefix = String(getSetting_('ORDER_PREFIX', 'MED') || 'MED').trim() || 'MED';
  const datePart = Utilities.formatDate(generatedAt, Session.getScriptTimeZone(), 'yyyyMMdd');
  const expression = new RegExp('^' + escapeOrderIdPart_(prefix) + '-' + datePart + '-(\\d{4})$');
  const sequence = readRecords_('OrderHeaders').reduce(function (maximum, record) {
    const match = String(record.OrderID || '').match(expression);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  if (sequence > 9999) throw new ApiError_('ORDER_ID_EXHAUSTED', 'Unable to allocate an order ID.');
  const orderId = prefix + '-' + datePart + '-' + ('0000' + sequence).slice(-4);
  return {
    orderId: orderId,
    itemIds: Array.from({ length: count }, function (_unused, index) {
      return orderId + '-' + ('00' + (index + 1)).slice(-2);
    }),
  };
}

function escapeOrderIdPart_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bundled from backend/OrderItemService.gs
 */
function buildOrderItems_(orderId, itemIds, payloadItems, context, now) {
  return payloadItems.map(function (item, index) {
    return {
      OrderItemID: itemIds[index],
      OrderID: orderId,
      ItemNo: index + 1,
      GenericName: cleanOrderText_(item.GenericName),
      BrandName: cleanOrderText_(item.BrandName),
      Strength: cleanOrderText_(item.Strength),
      DosageForm: cleanOrderText_(item.DosageForm).toUpperCase(),
      RequestedQuantity: Number(item.RequestedQuantity),
      Unit: cleanOrderText_(item.Unit).toUpperCase(),
      Prescriber: cleanOrderText_(item.Prescriber),
      ItemStatus: 'SUBMITTED',
      CreatedAt: now.toISOString(),
      CreatedBy: String(context.user.StaffID),
      UpdatedAt: now.toISOString(),
      UpdatedBy: String(context.user.StaffID),
      Active: 'TRUE',
    };
  });
}

function getOrderItems_(orderId) {
  return readRecords_('OrderItems', {
    predicate: function (item) { return String(item.OrderID || '') === String(orderId); },
  }).sort(function (left, right) { return Number(left.ItemNo) - Number(right.ItemNo); });
}

/**
 * Bundled from backend/OrderService.gs
 */
const MAX_ORDER_PAGE_SIZE_ = 100;
const MAX_ORDER_ITEM_COUNT_ = 99;
const STAFF_DASHBOARD_FILTER_FIELDS_ = Object.freeze(['Status']);
const STAFF_DASHBOARD_SORT_FIELDS_ = Object.freeze({ ORDERID: 'OrderID', CREATEDAT: 'CreatedAt', REQUIREDDATE: 'RequiredDate' });
const ORDER_TEXT_LIMITS_ = Object.freeze({
  RequesterPhone: 32, PatientName: 200, WardClinic: 64, GenericName: 200, BrandName: 200, Strength: 64, DosageForm: 64, Unit: 64, Prescriber: 200,
});

function createOrder_(context, payload, requestId) {
  payload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const clientRequestId = String(requestId || '').trim();
  if (!clientRequestId) throw new ApiError_('VALIDATION_ERROR', 'A client request ID is required.');
  if (payload.ClientRequestID && String(payload.ClientRequestID).trim() !== clientRequestId) throw new ApiError_('VALIDATION_ERROR', 'Client request ID does not match the request.');
  validateCreateOrderPayload_(payload);

  const preLockReplay = findCreateRequestOutcome_(context.user.StaffID, clientRequestId);
  if (preLockReplay) {
    if (preLockReplay.entry) finalizePostCommitNoticeSafe_(context, preLockReplay.entry);
    return replayCreateRequestOutcome_(preLockReplay);
  }
  assertNoIncompleteCreate_(context.user.StaffID, clientRequestId);

  const lock = LockService.getScriptLock();
  let headerAppend = null;
  let itemAppend = null;
  let requestAppend = null;
  let ids = null;
  let header = null;
  let items = null;
  let attempted = { header: false, items: false, request: false };
  let result = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findCreateRequestOutcome_(context.user.StaffID, clientRequestId);
    if (lockedReplay) return replayCreateRequestOutcome_(lockedReplay);
    assertNoIncompleteCreate_(context.user.StaffID, clientRequestId);
    const now = new Date();
    ids = generateOrderIds_(payload.Items.length, now);
    header = buildOrderHeader_(ids.orderId, context, payload, clientRequestId, now);
    items = buildOrderItems_(ids.orderId, ids.itemIds, payload.Items, context, now);
    attempted.header = true;
    headerAppend = appendRecords_('OrderHeaders', [header]);
    attempted.items = true;
    itemAppend = appendRecords_('OrderItems', items);
    result = { OrderID: ids.orderId, ItemCount: items.length, Status: 'SUBMITTED', replayed: false };
    const notification = makePostCommitNotificationJob_('NEW_ORDER', {
      header: header, items: items, actor: context.user,
      eventAt: header.CreatedAt, orderVersion: header.Version,
    }, 'SEND');
    attempted.request = true;
    requestAppend = appendRecords_('RequestLog', [{
      RequestID: clientRequestId, Action: 'CREATE_ORDER', OrderID: ids.orderId, StaffID: String(context.user.StaffID), CreatedAt: now.toISOString(), Result: 'SUCCESS', ResponseData: JSON.stringify(Object.assign({}, result, { postCommitNotification: notification })),
    }]);
    writeAudit_(orderAuditEntry_(context, clientRequestId, ids.orderId, 'CREATE_ORDER', 'SUCCESS', ''));
  } catch (error) {
    const rollback = rollbackCreateAppendRanges_(context, headerAppend, itemAppend, requestAppend, ids, clientRequestId, attempted);
    try {
      writeAudit_(orderAuditEntry_(context, clientRequestId, ids ? ids.orderId : '', 'CREATE_ORDER', 'TRANSACTION_FAILURE', rollback.detail));
    } catch (_auditError) {}
    throw error;
  } finally {
    lock.releaseLock();
  }

  finalizePostCommitByIdentitySafe_(context, 'CREATE_ORDER', clientRequestId, ids.orderId);
  return result;
}

function buildOrderHeader_(orderId, context, payload, clientRequestId, now) {
  const user = context.user;
  return {
    OrderID: orderId, ClientRequestID: clientRequestId, CreatedAt: now.toISOString(), CreatedByStaffID: String(user.StaffID), CreatedByName: String(user.FullName || ''), Department: String(user.Department || ''),
    RequesterEmail: String(user.Email || '').trim(), RequesterPhone: cleanOrderText_(payload.RequesterPhone), HN: cleanOrderText_(payload.HN), PatientName: cleanOrderText_(payload.PatientName), WardClinic: cleanOrderText_(payload.WardClinic),
    RequiredDate: cleanOrderText_(payload.RequiredDate), Priority: cleanOrderText_(payload.Priority).toUpperCase(), Status: 'SUBMITTED', ItemCount: payload.Items.length, Version: 1, CreatedSource: 'WEB', UpdatedAt: now.toISOString(), UpdatedBy: String(user.StaffID), AppointmentSequence: 0, NoShowCount: 0, NotificationStatus: 'PENDING',
  };
}

function findCreateRequestOutcome_(staffId, clientRequestId) {
  const records = readRecords_('RequestLog', { predicate: function (record) {
    return String(record.Action || '') === 'CREATE_ORDER' && String(record.StaffID || '') === String(staffId) && String(record.RequestID || '') === String(clientRequestId);
  }, limit: 1 });
  if (!records.length) return null;
  let response = {};
  try { response = JSON.parse(String(records[0].ResponseData || '{}')); } catch (_ignored) {}
  return { result: String(records[0].Result || ''), OrderID: String(records[0].OrderID || response.OrderID || ''), ItemCount: Number(response.ItemCount || 0), Status: String(response.Status || 'SUBMITTED'), response: response, entry: records[0] };
}

function replayCreateRequestOutcome_(outcome) {
  if (outcome.result === 'SUCCESS') return { OrderID: outcome.OrderID, ItemCount: outcome.ItemCount, Status: outcome.Status, replayed: true };
  throw new ApiError_('REQUEST_REPLAY', 'The previous order request did not complete.', [{ field: 'requestId', message: 'Retry with a new request ID after support review.' }]);
}

function assertNoIncompleteCreate_(staffId, clientRequestId) {
  const headers = readRecords_('OrderHeaders', { predicate: function (record) {
    return String(record.CreatedByStaffID || '') === String(staffId) && String(record.ClientRequestID || '') === String(clientRequestId);
  }, limit: 1 });
  if (headers.length) throw new ApiError_('REQUEST_REPLAY', 'The previous order request did not complete.', [{ field: 'requestId', message: 'Retry with a new request ID after support review.' }]);
}

/** Verify every affected range, make replay terminal, then delete only items/header. */
function rollbackCreateAppendRanges_(context, headerAppend, itemAppend, requestAppend, ids, clientRequestId, attempted) {
  const plans = [
    rollbackPlan_('OrderHeaders', headerAppend, 'OrderID', [String(ids && ids.orderId || '')], attempted.header),
    rollbackPlan_('OrderItems', itemAppend, 'OrderItemID', ids ? ids.itemIds : [], attempted.items),
    requestRollbackPlan_(requestAppend, context, clientRequestId, ids ? ids.orderId : '', attempted.request),
  ];
  const requestPlan = plans[2];
  if (plans.some(function (plan) { return !plan.ok; })) {
    try {
      if (requestPlan.ok) markRequestLogTransactionFailure_(requestPlan, ids ? ids.orderId : '');
      else ensureFailedCreateRequest_(context, clientRequestId, ids ? ids.orderId : '');
    } catch (_requestError) {
      ensureFailedCreateRequest_(context, clientRequestId, ids ? ids.orderId : '');
    }
    return { rolledBack: false, detail: 'Rollback ownership could not be proven for every append range.' };
  }
  try {
    markRequestLogTransactionFailure_(requestPlan, ids ? ids.orderId : '');
  } catch (_requestError) {
    return { rolledBack: false, detail: 'Could not make the request replay-safe before rollback.' };
  }
  try {
    // A terminal RequestLog record stays in place; remove dependents only after full proof.
    [plans[1], plans[0]].forEach(function (plan) { if (plan.appended) plan.sheet.deleteRows(plan.startRow, plan.rowCount); });
    return { rolledBack: true, detail: 'Created rows were rolled back after a transaction failure.' };
  } catch (_rollbackError) {
    return { rolledBack: false, detail: 'Rollback failed after ownership verification.' };
  }
}

function requestRollbackPlan_(appendResult, context, clientRequestId, orderId, attempted) {
  if (!attempted || !appendResult || appendResult.rowCount !== 1 || !appendResult.startRow) return { ok: false };
  try {
    const sheet = getSheetOrThrow_('RequestLog');
    const headers = getHeaderMap_(sheet);
    const record = readRecordAtRow_(sheet, appendResult.startRow, headers);
    const owned = String(record.Action || '') === 'CREATE_ORDER' && String(record.StaffID || '') === String(context.user.StaffID) && String(record.RequestID || '') === String(clientRequestId) && String(record.OrderID || '') === String(orderId);
    return owned ? { ok: true, sheet: sheet, headers: headers, row: appendResult.startRow } : { ok: false };
  } catch (_verificationError) {
    return { ok: false };
  }
}

function markRequestLogTransactionFailure_(plan, orderId) {
  const response = JSON.stringify({ errorCode: 'TRANSACTION_FAILURE', message: 'Order creation did not complete.', OrderID: String(orderId || '') });
  const resultColumn = plan.headers.Result;
  const responseColumn = plan.headers.ResponseData;
  if (!resultColumn || responseColumn !== resultColumn + 1) throw new Error('Request log columns are unavailable.');
  plan.sheet.getRange(plan.row, resultColumn, 1, 2).setValues([['TRANSACTION_FAILURE', response]]);
}

function ensureFailedCreateRequest_(context, clientRequestId, orderId) {
  try {
    appendRecords_('RequestLog', [{
      RequestID: String(clientRequestId), Action: 'CREATE_ORDER', OrderID: String(orderId || ''), StaffID: String(context.user.StaffID), CreatedAt: new Date().toISOString(), Result: 'TRANSACTION_FAILURE',
      ResponseData: JSON.stringify({ errorCode: 'TRANSACTION_FAILURE', message: 'Order creation did not complete.', OrderID: String(orderId || '') }),
    }]);
  } catch (_requestLogError) {}
}

function rollbackPlan_(sheetName, appendResult, keyName, expectedIds, attempted) {
  if (!attempted) return { ok: true, appended: false };
  if (!appendResult || !appendResult.startRow || !appendResult.rowCount || expectedIds.length !== appendResult.rowCount) return { ok: false };
  try {
    const sheet = getSheetOrThrow_(sheetName);
    const keyColumn = getHeaderMap_(sheet)[keyName];
    if (!keyColumn || sheet.getLastRow() !== appendResult.startRow + appendResult.rowCount - 1) return { ok: false };
    const actualIds = sheet.getRange(appendResult.startRow, keyColumn, appendResult.rowCount, 1).getDisplayValues().map(function (row) { return row[0]; });
    if (actualIds.join('\u001f') !== expectedIds.map(String).join('\u001f')) return { ok: false };
    return { ok: true, appended: true, sheet: sheet, startRow: appendResult.startRow, rowCount: appendResult.rowCount };
  } catch (_verificationError) {
    return { ok: false };
  }
}

function listDepartmentOrders_(context, query) {
  const dashboardQuery = normalizeStaffDashboardQuery_(query);
  const matching = readRecords_('OrderHeaders', { predicate: function (record) {
    if (String(record.Department || '') !== String(context.user.Department || '')) return false;
    if (dashboardQuery.status && String(record.Status || '').toUpperCase() !== dashboardQuery.status) return false;
    return !dashboardQuery.search || String(record.OrderID || '').toUpperCase().indexOf(dashboardQuery.search) >= 0;
  } });
  sortStaffDashboardOrders_(matching, dashboardQuery.sortField, dashboardQuery.sortDirection);
  const pageSize = dashboardQuery.pageSize;
  const page = dashboardQuery.page;
  const start = (page - 1) * pageSize;
  return { page: page, pageSize: pageSize, total: matching.length, orders: matching.slice(start, start + pageSize).map(orderSummary_) };
}

function normalizeStaffDashboardQuery_(query) {
  const input = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const filters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters) ? input.filters : {};
  const status = Object.prototype.hasOwnProperty.call(filters, STAFF_DASHBOARD_FILTER_FIELDS_[0]) ? cleanOrderText_(filters.Status).toUpperCase() : '';
  const search = cleanOrderText_(input.search).toUpperCase();
  const sortMatch = /^([A-Za-z]+):(asc|desc)$/i.exec(cleanOrderText_(input.sort));
  const sortField = sortMatch && STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] ? STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] : 'CreatedAt';
  const sortDirection = sortMatch && STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] && sortMatch[2].toLowerCase() === 'asc' ? 1 : -1;
  return {
    status: status, search: search, sortField: sortField, sortDirection: sortDirection,
    page: positiveInteger_(input.page, 1), pageSize: Math.min(MAX_ORDER_PAGE_SIZE_, positiveInteger_(input.pageSize == null ? input.limit : input.pageSize, 25)),
  };
}

function sortStaffDashboardOrders_(orders, field, direction) {
  orders.sort(function (left, right) {
    const primary = String(left[field] || '').localeCompare(String(right[field] || ''));
    if (primary) return primary * direction;
    return String(left.OrderID || '').localeCompare(String(right.OrderID || '')) * direction;
  });
}

function getOrderDetail_(context, orderId) {
  const order = findOrderHeader_(orderId);
  if (!order) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireOrderAccess_(context, order);
  return { order: orderDetail_(order), items: getOrderItems_(order.OrderID) };
}

function getStaffDashboard_(context, query) {
  const department = String(context.user.Department || '');
  const orders = readRecords_('OrderHeaders', { predicate: function (record) { return String(record.Department || '') === department; } });
  const counts = orders.reduce(function (result, order) { const status = String(order.Status || 'UNKNOWN'); result[status] = (result[status] || 0) + 1; return result; }, {});
  const list = listDepartmentOrders_(context, query);
  return { department: department, totalOrders: list.total, statusCounts: counts, page: list.page, pageSize: list.pageSize, total: list.total, recentOrders: list.orders };
}

const ADMIN_RECEIVE_ENVELOPE_FIELDS_ = Object.freeze(['OrderID', 'expectedVersion', 'Items']);
const ADMIN_RECEIVE_ITEM_FIELDS_ = Object.freeze(['OrderItemID', 'ItemStatus', 'ReceivedDate', 'ReceivedQuantity', 'ReceivedUnit', 'AdminNote']);

/** An ADMIN-only, all-department list with server-side filters and pagination. */
function listAllOrders_(context, query) {
  requireAdminOrderContext_(context);
  query = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const department = cleanOrderText_(query.department || query.Department).toUpperCase();
  const status = cleanOrderText_(query.status || query.Status).toUpperCase();
  const search = cleanOrderText_(query.orderId || query.OrderID || query.search).toUpperCase();
  const pageSize = Math.min(MAX_ORDER_PAGE_SIZE_, positiveInteger_(query.pageSize == null ? query.limit : query.pageSize, 25));
  const page = positiveInteger_(query.page, 1);
  const matches = readRecords_('OrderHeaders', { predicate: function (order) {
    return (!department || String(order.Department || '').toUpperCase() === department) && (!status || String(order.Status || '').toUpperCase() === status) && (!search || String(order.OrderID || '').toUpperCase().indexOf(search) >= 0);
  } });
  const start = (page - 1) * pageSize;
  return { page: page, pageSize: pageSize, total: matches.length, orders: matches.slice(start, start + pageSize).map(adminOrderSummary_) };
}

function getAdminDashboard_(context, query) {
  requireAdminOrderContext_(context);
  const listed = listAllOrders_(context, query);
  const filters = query && typeof query === 'object' ? query : {};
  const department = cleanOrderText_(filters.department || filters.Department).toUpperCase();
  const orders = readRecords_('OrderHeaders', { predicate: function (order) { return !department || String(order.Department || '').toUpperCase() === department; } });
  const statusCounts = orders.reduce(function (counts, order) { const status = String(order.Status || 'UNKNOWN'); counts[status] = (counts[status] || 0) + 1; return counts; }, {});
  return { department: department || 'ALL', totalOrders: orders.length, statusCounts: statusCounts, recentOrders: listed.orders };
}

/** Version-protected receiving write. Mail is deliberately performed after unlock. */
function updateReceivedItems_(context, payload, requestId) {
  requireAdminOrderContext_(context);
  const input = normalizeAdminReceivePayload_(payload, requestId);
  const initial = findOrderHeader_(input.OrderID);
  if (!initial) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  const replay = findStaffMutationReplay_('UPDATE_RECEIVED_ITEMS', context.user.StaffID, input.requestId);
  if (replay) return replayReceivedUpdateRequest_(context, replay, true);
  const lock = LockService.getScriptLock();
  let result = null;
  let emailModel = null;
  let preparedEmail = null;
  let replayPlan = null;
  let recovery = null;
  lock.waitLock(30000);
  try {
    receivedWrite: {
    const lockedReplay = findStaffMutationReplay_('UPDATE_RECEIVED_ITEMS', context.user.StaffID, input.requestId);
    if (lockedReplay) replayPlan = replayReceivedUpdateRequestLocked_(context, lockedReplay, true);
    if (lockedReplay) break receivedWrite;
    const current = findOrderHeader_(input.OrderID);
    if (!current) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    assertExpectedOrderVersion_(current, input.expectedVersion);
    const currentItems = getOrderItems_(input.OrderID);
    const plan = buildAdminReceivingPlan_(currentItems, input.Items, context);
    if (!plan.changes.length) throw new ApiError_('VALIDATION_ERROR', 'No receiving changes were supplied.');
    const status = deriveReceivingStatus_(plan.finalItems);
    if (!status) throw new ApiError_('VALIDATION_ERROR', 'Medication item status is invalid.');
    if (!canAdminReceiveOrderTransition_(current.Status, status)) throw new ApiError_('INVALID_STATUS_TRANSITION', 'This order cannot be reopened or received in its current status.');
    const now = new Date().toISOString();
    const versionAfter = Number(current.Version) + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    const headerUpdates = { Status: status, Version: versionAfter, UpdatedAt: now, UpdatedBy: String(context.user.StaffID), LastChangeSetID: changeSetId, LastChangeType: 'UPDATE_RECEIVED_ITEMS', LastChangedAt: now, LastChangedBy: String(context.user.StaffID), LastChangeReason: '' };
    if (String(current.Status || '') !== status) plan.changes.push({ scope: 'order', itemId: '', field: 'Status', oldValue: current.Status, newValue: status });
    recovery = { orderId: input.OrderID, current: current, currentItems: currentItems, versionAfter: versionAfter, changeSetId: changeSetId, newItemIds: [], changes: plan.changes, historyWritten: false, action: 'UPDATE_RECEIVED_ITEMS' };
    beginStaffMutationRequest_(context, input.requestId, 'UPDATE_RECEIVED_ITEMS', input.OrderID);
    try {
      batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', plan.itemUpdates);
      updateRecordByKey_('OrderHeaders', 'OrderID', input.OrderID, headerUpdates);
      writeChanges_(staffMutationChangeRows_(plan.changes, context, current, versionAfter, changeSetId, input.requestId, 'UPDATE_RECEIVED_ITEMS', ''));
      recovery.historyWritten = true;
      result = { OrderID: input.OrderID, Version: versionAfter, Status: status, ChangeSetID: changeSetId, replayed: false };
      emailModel = { header: Object.assign({}, current, headerUpdates), items: plan.finalItems, actor: context.user, changeSetId: changeSetId, changes: plan.changes, eventAt: now, orderVersion: versionAfter };
      if (status === 'RECEIVED') {
        try { preparedEmail = prepareReceivedEmailLocked_(context, input.requestId, result, emailModel); }
        catch (preparationError) { preparedEmail = { preparationError: true, error: preparationError, finalizerRequestId: receivedNotificationRequestId_(input.requestId), response: { OrderID: input.OrderID } }; }
        if (preparedEmail.preparationError) {
          recordReceivePrepFailureLocked_(context, preparedEmail, result);
          result.NotificationPreparation = 'FAILED';
        }
      }
      writeAudit_(orderAuditEntry_(context, input.requestId, input.OrderID, 'UPDATE_RECEIVED_ITEMS', 'SUCCESS', JSON.stringify({ items: plan.itemUpdates.length, status: status })));
      completeStaffMutationRequest_(context, input.requestId, 'UPDATE_RECEIVED_ITEMS', input.OrderID, result);
    } catch (error) {
      let cleanupError = null;
      try { abortPreparedEmailLocked_(context, preparedEmail); } catch (abortError) { cleanupError = abortError; }
      recoverStaffMutationFailure_(context, input.requestId, 'UPDATE_RECEIVED_ITEMS', recovery, cleanupError || error);
      throw cleanupError || error;
    }
    }
  } finally { lock.releaseLock(); }
  if (replayPlan) return finishReceivedDelivery_(context, replayPlan);
  invalidateDashboardCache_(currentDepartmentForCache_(emailModel));
  if (preparedEmail && !preparedEmail.preparationError) {
    return deliverReceivedFinalizer_(context, 'FINALIZE_RECEIVED_EMAIL', preparedEmail.finalizerRequestId, result.OrderID, false);
  }
  return result;
}

/** Admin-triggered delivery with a durable, replay-reconcilable finalization plan. */
function sendOrderEmail_(context, payload, requestId) {
  requireAdminOrderContext_(context);
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (Object.keys(input).some(function (field) { return ['OrderID', 'expectedVersion'].indexOf(field) < 0; })) throw new ApiError_('VALIDATION_ERROR', 'Unsupported email fields.');
  const orderId = cleanOrderText_(input.OrderID), expectedVersion = Number(input.expectedVersion), id = String(requestId || '').trim();
  if (!orderId || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !id) throw new ApiError_('VALIDATION_ERROR', 'Order ID, expected version, and request ID are required.');
  const replay = findStaffMutationReplay_('SEND_ORDER_EMAIL', context.user.StaffID, id);
  if (replay) return resumePreparedEmailRequest_(context, replay, true);

  const lock = LockService.getScriptLock();
  let reserved, claimed = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('SEND_ORDER_EMAIL', context.user.StaffID, id);
    if (lockedReplay) return reconcileEmailRequestLocked_(context, lockedReplay, true);
    const header = findOrderHeader_(orderId);
    if (!header) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    assertExpectedOrderVersion_(header, expectedVersion);
    if (String(header.Status || '') !== 'RECEIVED') throw new ApiError_('INVALID_STATUS_TRANSITION', 'Only a received order can be notified.');
    assertNoEmailInFlightLocked_(orderId);
    const attemptId = 'EML-' + Utilities.getUuid(), finalizeChangeSetId = 'CHGSET-' + Utilities.getUuid();
    const response = pendingEmailResponse_(orderId, attemptId, expectedVersion, finalizeChangeSetId, 'MEDICATION_RECEIVED', { OriginalLastChangeSetID: String(header.LastChangeSetID || ''), replayed: false });
    const model = { header: header, items: getOrderItems_(orderId), actor: context.user, eventAt: new Date().toISOString(), orderVersion: Number(header.Version), changes: [], templateName: 'MEDICATION_RECEIVED' };
    response.PreparedSnapshot = makeEmailSnapshot_('MEDICATION_RECEIVED', model, attemptId);
    response.PreparationPhase = 'REQUESTED';
    appendPendingEmailRequest_(context, id, 'SEND_ORDER_EMAIL', orderId, response);
    reserved = ensureExplicitEmailPreparedLocked_(context, { Action: 'SEND_ORDER_EMAIL', RequestID: id, OrderID: orderId }, response);
    claimed = claimPendingEmailAttemptLocked_(reserved.attempt.EmailLogID);
  } finally { lock.releaseLock(); }
  if (claimed) deliverPendingEmailAttempt_(claimed, reserved.snapshot, { managed: true });
  return reconcileEmailRequestByIdentity_(context, 'SEND_ORDER_EMAIL', id, orderId, false);
}

function resendFailedEmail_(context, emailLogId, requestId) {
  requireAdminOrderContext_(context);
  const logId = typeof emailLogId === 'object' && emailLogId ? cleanOrderText_(emailLogId.EmailLogID) : cleanOrderText_(emailLogId);
  const id = String(requestId || '').trim();
  if (!logId || !id) throw new ApiError_('VALIDATION_ERROR', 'Email log ID and request ID are required.');
  const replay = findStaffMutationReplay_('RESEND_FAILED_EMAIL', context.user.StaffID, id);
  if (replay) return resumePreparedEmailRequest_(context, replay, true);

  const lock = LockService.getScriptLock();
  let reserved, claimed = null, orderId;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('RESEND_FAILED_EMAIL', context.user.StaffID, id);
    if (lockedReplay) return reconcileEmailRequestLocked_(context, lockedReplay, true);
    const rows = readRecords_('EmailLog', { predicate: function (entry) { return String(entry.EmailLogID || '') === logId; }, limit: 1 });
    if (!rows.length || String(rows[0].Result || '') !== 'FAILED') throw new ApiError_('VALIDATION_ERROR', 'Only a failed email can be retried.');
    const sourceLog = rows[0], originalSnapshot = loadEmailSnapshot_(sourceLog.EmailLogID);
    assertNoEmailInFlightLocked_(sourceLog.OrderID);
    assertLatestEmailChainAttempt_(sourceLog, originalSnapshot);
    const header = findOrderHeader_(sourceLog.OrderID);
    if (!header) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    assertEmailRetryCompatible_(sourceLog, originalSnapshot, header);
    orderId = String(header.OrderID);
    const attemptId = 'EML-' + Utilities.getUuid(), finalizeChangeSetId = 'CHGSET-' + Utilities.getUuid();
    const expectedVersion = Number(originalSnapshot.event && originalSnapshot.event.orderVersion || originalSnapshot.header.Version || header.Version);
    const response = pendingEmailResponse_(orderId, attemptId, expectedVersion, finalizeChangeSetId, sourceLog.EmailType, { OriginalLastChangeSetID: String(header.LastChangeSetID || ''), RetriedEmailLogID: logId, replayed: false });
    response.PreparedSnapshot = makeEmailSnapshot_(sourceLog.EmailType, originalSnapshot, originalSnapshot.rootEmailLogId || sourceLog.EmailLogID);
    response.PreparedSnapshot.attemptEmailLogId = attemptId;
    response.PreparationPhase = 'REQUESTED';
    response.RetryCount = Number(sourceLog.RetryCount || 0) + 1;
    response.SourceChangeSetID = String(sourceLog.ChangeSetID || '');
    appendPendingEmailRequest_(context, id, 'RESEND_FAILED_EMAIL', orderId, response);
    reserved = ensureExplicitEmailPreparedLocked_(context, { Action: 'RESEND_FAILED_EMAIL', RequestID: id, OrderID: orderId }, response);
    claimed = claimPendingEmailAttemptLocked_(reserved.attempt.EmailLogID);
  } finally { lock.releaseLock(); }
  if (claimed) deliverPendingEmailAttempt_(claimed, reserved.snapshot, { managed: true });
  return reconcileEmailRequestByIdentity_(context, 'RESEND_FAILED_EMAIL', id, orderId, false);
}

function receivedNotificationRequestId_(businessRequestId) { return 'RECEIVED_EMAIL:' + String(businessRequestId || ''); }

/** Only one delivery may be unresolved for an order, even after a browser reload changes requestId. */
function assertNoEmailInFlightLocked_(orderId) {
  const attempts = readRecords_('EmailLog', { predicate: function (row) {
    return String(row.OrderID || '') === String(orderId || '') && ['PENDING', 'SENDING', 'UNCERTAIN'].indexOf(String(row.Result || '')) >= 0;
  } });
  if (!attempts.length) return;
  const hasUncertain = attempts.some(function (row) { return ['SENDING', 'UNCERTAIN'].indexOf(String(row.Result || '')) >= 0; });
  const active = attempts[attempts.length - 1];
  const code = hasUncertain ? 'EMAIL_DELIVERY_UNCERTAIN' : 'EMAIL_DELIVERY_PENDING';
  const message = hasUncertain ? 'Email delivery outcome is uncertain and requires manual reconciliation.' : 'Email delivery is pending reconciliation.';
  throw new ApiError_(code, message, [{ field: 'emailLogId', message: String(active.EmailLogID || '') }]);
}

function ensureExplicitEmailPreparedLocked_(context, entry, response) {
  const attemptId = String(response.EmailLogID || '');
  let snapshot = null;
  try { snapshot = loadEmailSnapshot_(attemptId); } catch (_ignored) {}
  if (!snapshot) snapshot = response.PreparedSnapshot || recoverExplicitSnapshotLocked_(entry, response);
  if (!snapshot || !snapshot.header || !snapshot.templateName) throw new ApiError_('EMAIL_PREPARATION_FAILED', 'Email preparation snapshot is unavailable.');
  snapshot.attemptEmailLogId = attemptId;
  const attempt = {
    EmailLogID: attemptId, OrderID: String(entry.OrderID || ''), ChangeSetID: String(response.SourceChangeSetID || response.ChangeSetID || ''),
    EmailType: String(response.EmailType || snapshot.templateName || ''), Recipient: '', CC: '', Subject: '', SentAt: new Date().toISOString(),
    SentBy: String(context.user.StaffID), Result: 'PENDING', ErrorMessage: '', RetryCount: Number(response.RetryCount || 0),
  };
  if (!loadEmailSnapshotSafe_(attemptId)) {
    persistEmailSnapshot_(attempt, snapshot);
    updateExplicitPhaseLocked_(context, entry, response, 'SNAPSHOT_READY');
  }
  const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === attemptId; }, limit: 2 });
  if (attempts.length > 1) throw new ApiError_('EMAIL_PREPARATION_FAILED', 'Email attempt identity is invalid.');
  if (!attempts.length) {
    appendRecords_('EmailLog', [attempt]);
    updateExplicitPhaseLocked_(context, entry, response, 'ATTEMPT_READY');
    return { attempt: attempt, snapshot: snapshot, result: null };
  }
  return { attempt: attempts[0], snapshot: snapshot, result: null };
}

function loadEmailSnapshotSafe_(emailLogId) { try { return loadEmailSnapshot_(emailLogId); } catch (_ignored) { return null; } }

function recoverExplicitSnapshotLocked_(entry, response) {
  if (entry.Action === 'RESEND_FAILED_EMAIL' && response.RetriedEmailLogID) return loadEmailSnapshotSafe_(response.RetriedEmailLogID);
  if (entry.Action !== 'SEND_ORDER_EMAIL') return null;
  const header = findOrderHeader_(entry.OrderID);
  if (!header) return null;
  return makeEmailSnapshot_(response.EmailType || 'MEDICATION_RECEIVED', { header: header, items: getOrderItems_(entry.OrderID), actor: {}, eventAt: header.UpdatedAt, orderVersion: Number(response.ExpectedVersion), changes: [] }, response.EmailLogID);
}

function updateExplicitPhaseLocked_(context, entry, response, phase) {
  response.PreparationPhase = phase;
  updateRecordByCompositeKey_('RequestLog', staffRequestKey_(context, entry.Action, entry.RequestID, entry.OrderID), { Result: 'PENDING', ResponseData: JSON.stringify(response) });
}

function failExplicitPrepLocked_(context, entry, response, error, replayed) {
  const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(response.EmailLogID || ''); }, limit: 2 });
  if (attempts.length === 1 && String(attempts[0].Result || '') === 'PENDING') failUnsentEmailLocked_(context, attempts[0]);
  const completed = Object.assign({}, response, { deliveryPending: false, retryEligible: false, finalizationOutcome: 'PREPARATION_FAILED', finalizationReason: 'EMAIL_PREPARATION_FAILED', email: { result: 'FAILED', errorMessage: 'EMAIL_PREPARATION_FAILED', emailLogId: String(response.EmailLogID || '') }, replayed: Boolean(replayed) });
  delete completed.PreparedSnapshot;
  delete completed.PreparationPhase;
  try {
    completeStaffMutationRequest_(context, entry.RequestID, entry.Action, entry.OrderID, completed);
    const durable = findStaffMutationReplay_(entry.Action, context.user.StaffID, entry.RequestID);
    if (!durable || String(durable.OrderID || '') !== String(entry.OrderID || '') || String(durable.Result || '') !== 'SUCCESS') throw new Error('Email preparation failure was not durable.');
  } catch (completionError) {
    try { writeAudit_(orderAuditEntry_(context, entry.RequestID, entry.OrderID, 'EMAIL_PREPARATION', 'PREPARATION_FAILED', String(completionError && completionError.message || error && error.message || ''))); } catch (_ignored) {}
    throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email preparation failure is pending reconciliation.');
  }
  return completed;
}

function resumePreparedEmailRequest_(context, entry, replayed) {
  const lock = LockService.getScriptLock();
  let plan;
  lock.waitLock(30000);
  try {
    const latest = findStaffMutationReplay_(entry.Action, context.user.StaffID, entry.RequestID) || entry;
    if (String(latest.Result || '') !== 'PENDING') return reconcileEmailRequestLocked_(context, latest, replayed);
    let response;
    try { response = JSON.parse(String(latest.ResponseData || '{}')); } catch (_ignored) { throw new ApiError_('REQUEST_REPLAY', 'The email request state is invalid.'); }
    if (findTerminalEmailOutcome_(response.EmailLogID)) return reconcileEmailRequestLocked_(context, latest, replayed);
    let prepared;
    try { prepared = ensureExplicitEmailPreparedLocked_(context, latest, response); }
    catch (preparationError) { return failExplicitPrepLocked_(context, latest, response, preparationError, replayed); }
    const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(response.EmailLogID || ''); }, limit: 2 });
    if (attempts.length !== 1) throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
    if (String(attempts[0].Result || '') === 'SENDING') throw new ApiError_('EMAIL_DELIVERY_UNCERTAIN', 'Email delivery outcome is uncertain and requires manual reconciliation.');
    if (String(attempts[0].Result || '') !== 'PENDING') throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
    const snapshot = prepared.snapshot, header = findOrderHeader_(latest.OrderID);
    if (!header) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    if (latest.Action === 'RESEND_FAILED_EMAIL') { assertLatestEmailChainAttempt_(attempts[0], snapshot); assertEmailRetryCompatible_(attempts[0], snapshot, header); }
    else if (String(header.Status || '') !== 'RECEIVED' || Number(header.Version) !== Number(response.ExpectedVersion) || String(header.LastChangeSetID || '') !== String(response.OriginalLastChangeSetID || '')) throw new ApiError_('EMAIL_RETRY_STALE', 'The order changed before this email could be sent.');
    plan = { deliveryClaim: true, attempt: claimPendingEmailAttemptLocked_(response.EmailLogID), snapshot: snapshot, action: latest.Action, requestId: latest.RequestID, orderId: latest.OrderID, replayed: Boolean(replayed) };
  } finally { lock.releaseLock(); }
  return finishReceivedDelivery_(context, plan);
}

function replayReceivedUpdateRequest_(context, businessEntry, replayed) {
  const lock = LockService.getScriptLock();
  let plan;
  lock.waitLock(30000);
  try { plan = replayReceivedUpdateRequestLocked_(context, businessEntry, replayed); }
  finally { lock.releaseLock(); }
  return finishReceivedDelivery_(context, plan);
}

function replayReceivedUpdateRequestLocked_(context, businessEntry, replayed) {
  const finalizerId = receivedNotificationRequestId_(businessEntry.RequestID);
  let finalizer = findStaffMutationReplay_('FINALIZE_RECEIVED_EMAIL', context.user.StaffID, finalizerId);
  let businessResult;
  if (String(businessEntry.Result || '') === 'SUCCESS') businessResult = replayStaffMutation_(businessEntry);
  else businessResult = recoverPreparedReceiveLocked_(context, businessEntry, finalizer);
  if (String(businessEntry.Result || '') !== 'SUCCESS') finalizer = findStaffMutationReplay_('FINALIZE_RECEIVED_EMAIL', context.user.StaffID, finalizerId);
  if (!businessResult) return replayStaffMutation_(businessEntry);
  if (String(businessResult.Status || '') !== 'RECEIVED') return businessResult;
  if (finalizer && String(finalizer.Result || '') === 'PENDING' && String(businessResult.NotificationPreparation || '') === 'FAILED') {
    completeReceivedPrepFailureLocked_(context, finalizer, businessResult, emailIdFromFinalizer_(finalizer), true);
    finalizer = findStaffMutationReplay_('FINALIZE_RECEIVED_EMAIL', context.user.StaffID, finalizerId);
  }
  if (!finalizer && String(businessResult.NotificationPreparation || '') === 'FAILED') return businessResult;
  if (!finalizer) throw new ApiError_('REQUEST_REPLAY', 'The receiving email finalizer is unavailable.');
  return prepareReceivedDeliveryLocked_(context, finalizer, replayed);
}

/** A complete finalizer is the durable commit witness if execution stopped before the business request completed. */
function recoverPreparedReceiveLocked_(context, businessEntry, finalizer) {
  let response = {};
  if (finalizer) {
    try { response = JSON.parse(String(finalizer.ResponseData || '{}')); } catch (_ignored) { response = {}; }
  }
  const header = findOrderHeader_(businessEntry.OrderID);
  const changes = readRecords_('OrderChangeLog', { predicate: function (row) { return String(row.RequestID || '') === String(businessEntry.RequestID) && String(row.ActionType || '') === 'UPDATE_RECEIVED_ITEMS' && String(row.ChangedByStaffID || '') === String(context.user.StaffID) && String(row.OrderID || '') === String(businessEntry.OrderID); } });
  const changeSetId = String(response.ChangeSetID || changes[0] && changes[0].ChangeSetID || '');
  const expectedVersion = Number(response.ExpectedVersion || changes[0] && changes[0].OrderVersionAfter || 0);
  const ownsBusinessState = header && String(header.Status || '') === 'RECEIVED' && Number(header.Version) === expectedVersion && changeSetId && String(header.LastChangeSetID || '') === changeSetId;
  if (!ownsBusinessState) return null;
  const emailLogId = String(response.EmailLogID || '');
  const attempts = emailLogId ? readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === emailLogId; }, limit: 2 }) : [];
  const terminal = emailLogId ? findTerminalEmailOutcome_(emailLogId) : null;
  let snapshot = null;
  try { if (emailLogId) snapshot = loadEmailSnapshot_(emailLogId); } catch (_ignored) {}
  const completePreparation = finalizer && String(finalizer.Result || '') === 'PENDING' && snapshot && attempts.length === 1 && ['PENDING', 'SENDING', 'SUCCESS', 'FAILED'].indexOf(String(attempts[0].Result || '')) >= 0;
  const result = { OrderID: String(businessEntry.OrderID), Version: expectedVersion, Status: 'RECEIVED', ChangeSetID: changeSetId, replayed: false };
  if (!completePreparation && !terminal) {
    if (attempts.length === 1 && String(attempts[0].Result || '') === 'PENDING') failUnsentEmailLocked_(context, attempts[0]);
    if (finalizer) completeReceivedPrepFailureLocked_(context, finalizer, result, emailLogId);
    try { updateRecordByKey_('OrderHeaders', 'OrderID', result.OrderID, { NotificationStatus: 'FAILED' }); } catch (_ignored) {}
    try { writeAudit_(orderAuditEntry_(context, businessEntry.RequestID, result.OrderID, 'EMAIL_PREPARATION', 'PREPARATION_FAILED', 'EMAIL_PREPARATION_FAILED')); } catch (_ignored) {}
    result.NotificationPreparation = 'FAILED';
  }
  const audits = readRecords_('AuditLog', { predicate: function (row) { return String(row.Action || '') === 'UPDATE_RECEIVED_ITEMS' && String(row.RequestID || '') === String(businessEntry.RequestID) && String(row.OrderID || '') === result.OrderID; }, limit: 1 });
  if (!audits.length) writeAudit_(orderAuditEntry_(context, businessEntry.RequestID, result.OrderID, 'UPDATE_RECEIVED_ITEMS', 'SUCCESS', JSON.stringify({ recoveredFromPreparedFinalizer: true })));
  completeStaffMutationRequest_(context, businessEntry.RequestID, 'UPDATE_RECEIVED_ITEMS', result.OrderID, result);
  result.replayed = true;
  return result;
}

/** Claim under lock, then send outside the lock. */
function deliverReceivedFinalizer_(context, action, requestId, orderId, replayed) {
  const lock = LockService.getScriptLock();
  let plan;
  lock.waitLock(30000);
  try {
    const finalizer = findStaffMutationReplay_(action, context.user.StaffID, requestId);
    if (!finalizer || String(finalizer.OrderID || '') !== String(orderId || '')) throw new ApiError_('REQUEST_REPLAY', 'The email request could not be reconciled.');
    plan = prepareReceivedDeliveryLocked_(context, finalizer, replayed);
  } finally { lock.releaseLock(); }
  return finishReceivedDelivery_(context, plan);
}

function prepareReceivedDeliveryLocked_(context, finalizer, replayed) {
  if (String(finalizer.Result || '') !== 'PENDING') return reconcileEmailRequestLocked_(context, finalizer, replayed);
  let response;
  try { response = JSON.parse(String(finalizer.ResponseData || '{}')); } catch (_ignored) { throw new ApiError_('REQUEST_REPLAY', 'The email request state is invalid.'); }
  const terminal = findTerminalEmailOutcome_(response.EmailLogID);
  if (terminal) return reconcileEmailRequestLocked_(context, finalizer, replayed);
  const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(response.EmailLogID || ''); }, limit: 2 });
  if (attempts.length !== 1) throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
  if (String(attempts[0].Result || '') === 'SENDING') throw new ApiError_('EMAIL_DELIVERY_UNCERTAIN', 'Email delivery outcome is uncertain and requires manual reconciliation.');
  if (String(attempts[0].Result || '') !== 'PENDING') throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
  const snapshot = loadEmailSnapshot_(response.EmailLogID);
  const claimed = claimPendingEmailAttemptLocked_(response.EmailLogID);
  return { deliveryClaim: true, attempt: claimed, snapshot: snapshot, action: finalizer.Action, requestId: finalizer.RequestID, orderId: finalizer.OrderID, replayed: Boolean(replayed) };
}

function finishReceivedDelivery_(context, plan) {
  if (!plan || !plan.deliveryClaim) return plan;
  deliverPendingEmailAttempt_(plan.attempt, plan.snapshot, { managed: true });
  return reconcileEmailRequestByIdentity_(context, plan.action, plan.requestId, plan.orderId, plan.replayed);
}

/** Reserve the receiving finalizer and immutable attempt inside the business lock. */
function prepareReceivedEmailLocked_(context, businessRequestId, businessResult, emailModel) {
  const finalizerRequestId = receivedNotificationRequestId_(businessRequestId);
  const header = emailModel.header || {};
  const attemptId = 'EML-' + Utilities.getUuid(), finalizeChangeSetId = 'CHGSET-' + Utilities.getUuid();
  const response = pendingEmailResponse_(businessResult.OrderID, attemptId, Number(businessResult.Version), finalizeChangeSetId, 'MEDICATION_RECEIVED', { OriginalLastChangeSetID: String(header.LastChangeSetID || ''), ChangeSetID: businessResult.ChangeSetID, replayed: false });
  appendPendingEmailRequest_(context, finalizerRequestId, 'FINALIZE_RECEIVED_EMAIL', businessResult.OrderID, response);
  const reserved = createPendingEmailAttempt_('MEDICATION_RECEIVED', emailModel, { emailLogId: attemptId, rootEmailLogId: attemptId, retryCount: 0, changeSetId: businessResult.ChangeSetID, sentBy: context.user.StaffID, terminalLockHeld: true });
  return { finalizerRequestId: finalizerRequestId, response: response, reserved: reserved, preparationError: !reserved.attempt || Boolean(reserved.result) };
}

function abortPreparedEmailLocked_(context, prepared) {
  if (!prepared) return;
  const reserved = prepared.reserved || {};
  if (reserved.attempt) failUnsentEmailLocked_(context, reserved.attempt);
  failReceivedFinalizerLocked_(context, { Action: 'FINALIZE_RECEIVED_EMAIL', RequestID: prepared.finalizerRequestId, OrderID: prepared.response.OrderID }, 'EMAIL_PREPARATION_FAILED');
  if (reserved.attempt) {
    const pending = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(reserved.attempt.EmailLogID || '') && String(row.Result || '') === 'PENDING'; }, limit: 1 });
    if (pending.length) throw new ApiError_('EMAIL_PREPARATION_CLEANUP_FAILED', 'Email notification preparation cleanup failed.');
  }
}

function recordReceivePrepFailureLocked_(context, prepared, businessResult) {
  const reserved = prepared && prepared.reserved || {};
  if (reserved.attempt) failUnsentEmailLocked_(context, reserved.attempt);
  const finalizer = findStaffMutationReplay_('FINALIZE_RECEIVED_EMAIL', context.user.StaffID, prepared.finalizerRequestId);
  if (finalizer) completeReceivedPrepFailureLocked_(context, finalizer, businessResult, reserved.attempt && reserved.attempt.EmailLogID || '');
  try { updateRecordByKey_('OrderHeaders', 'OrderID', businessResult.OrderID, { NotificationStatus: 'FAILED' }); } catch (_ignored) {}
  try { writeAudit_(orderAuditEntry_(context, prepared.finalizerRequestId, businessResult.OrderID, 'EMAIL_PREPARATION', 'PREPARATION_FAILED', 'EMAIL_PREPARATION_FAILED')); } catch (_ignored) {}
}

function failUnsentEmailLocked_(context, attempt) {
  const id = String(attempt && attempt.EmailLogID || '');
  if (!id) return;
  for (let pass = 0; pass < 2; pass += 1) {
    const rows = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === id; }, limit: 2 });
    if (rows.length !== 1 || String(rows[0].Result || '') !== 'PENDING') return;
    try {
      const updated = updateRecordByKey_('EmailLog', 'EmailLogID', id, { Result: 'FAILED', ErrorMessage: 'EMAIL_PREPARATION_FAILED', SentAt: new Date().toISOString() });
      if (updated) return;
    } catch (_ignored) {}
  }
  try { writeAudit_(orderAuditEntry_(context, '', String(attempt.OrderID || ''), 'EMAIL_PREPARATION', 'CLEANUP_FAILED', 'EMAIL_PREPARATION_FAILED')); } catch (_ignored) {}
}

function completeReceivedPrepFailureLocked_(context, finalizer, businessResult, emailLogId, required) {
  let pending = {};
  try { pending = JSON.parse(String(finalizer.ResponseData || '{}')); } catch (_ignored) {}
  const response = Object.assign({}, pending, { OrderID: businessResult.OrderID, Version: businessResult.Version, Status: businessResult.Status, deliveryPending: false, retryEligible: false, finalizationOutcome: 'PREPARATION_FAILED', finalizationReason: 'EMAIL_PREPARATION_FAILED', email: { result: 'FAILED', errorMessage: 'EMAIL_PREPARATION_FAILED', emailLogId: String(emailLogId || '') } });
  try {
    completeStaffMutationRequest_(context, finalizer.RequestID, finalizer.Action, finalizer.OrderID, response);
    const completed = findStaffMutationReplay_(finalizer.Action, context.user.StaffID, finalizer.RequestID);
    if (!completed || String(completed.OrderID || '') !== String(finalizer.OrderID || '') || String(completed.Result || '') !== 'SUCCESS') throw new Error('Finalizer completion was not durable.');
    return response;
  } catch (error) {
    try { writeAudit_(orderAuditEntry_(context, finalizer.RequestID, finalizer.OrderID, 'EMAIL_PREPARATION', 'PREPARATION_FAILED', String(error && error.message || ''))); } catch (_ignored) {}
    if (required) throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email preparation failure is pending reconciliation.');
    return null;
  }
}

function emailIdFromFinalizer_(finalizer) {
  try { return String(JSON.parse(String(finalizer && finalizer.ResponseData || '{}')).EmailLogID || ''); } catch (_ignored) { return ''; }
}

function failReceivedFinalizerLocked_(context, finalizer, errorCode) {
  const response = { errorCode: String(errorCode || 'EMAIL_PREPARATION_FAILED'), message: 'Email notification preparation failed.' };
  const updates = { Result: 'TRANSACTION_FAILURE', ResponseData: JSON.stringify(response) };
  try {
    updateRecordByCompositeKey_('RequestLog', staffRequestKey_(context, 'FINALIZE_RECEIVED_EMAIL', finalizer.RequestID, finalizer.OrderID), updates);
    return;
  } catch (_firstError) {}
  try {
    updateRecordByCompositeKey_('RequestLog', staffRequestKey_(context, 'FINALIZE_RECEIVED_EMAIL', finalizer.RequestID, finalizer.OrderID), updates);
  } catch (_secondError) {
    try { writeAudit_(orderAuditEntry_(context, finalizer.RequestID, finalizer.OrderID, 'EMAIL_PREPARATION', 'CLEANUP_FAILED', String(errorCode || ''))); } catch (_ignored) {}
    throw new ApiError_('EMAIL_PREPARATION_CLEANUP_FAILED', 'Email notification preparation cleanup failed.');
  }
}

function pendingEmailResponse_(orderId, attemptId, expectedVersion, finalizeChangeSetId, emailType, extra) {
  return Object.assign({ OrderID: orderId, Version: expectedVersion, Status: 'RECEIVED', EmailLogID: attemptId, ExpectedVersion: expectedVersion, FinalizeChangeSetID: finalizeChangeSetId, EmailType: emailType, deliveryPending: true }, extra || {});
}

function appendPendingEmailRequest_(context, requestId, action, orderId, response) {
  appendRecords_('RequestLog', [{ RequestID: requestId, Action: action, OrderID: orderId, StaffID: String(context.user.StaffID), CreatedAt: new Date().toISOString(), Result: 'PENDING', ResponseData: JSON.stringify(response) }]);
}

function reconcileEmailRequestByIdentity_(context, action, requestId, orderId, replayed) {
  const entry = findStaffMutationReplay_(action, context.user.StaffID, requestId);
  if (!entry || String(entry.OrderID || '') !== String(orderId || '')) throw new ApiError_('REQUEST_REPLAY', 'The email request could not be reconciled.');
  return reconcileEmailRequest_(context, entry, replayed);
}

function reconcileEmailRequest_(context, entry, replayed) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const latest = findStaffMutationReplay_(entry.Action, context.user.StaffID, entry.RequestID);
    return reconcileEmailRequestLocked_(context, latest || entry, replayed);
  } finally { lock.releaseLock(); }
}

function reconcileEmailRequestLocked_(context, entry, replayed) {
  if (String(entry.Result || '') === 'SUCCESS') return replayStaffMutation_(entry);
  if (String(entry.Result || '') !== 'PENDING') return replayStaffMutation_(entry);
  let response;
  try { response = JSON.parse(String(entry.ResponseData || '{}')); } catch (_ignored) { throw new ApiError_('REQUEST_REPLAY', 'The email request state is invalid.'); }
  const outcome = findTerminalEmailOutcome_(response.EmailLogID);
  if (!outcome) {
    const attempts = readRecords_('EmailLog', { predicate: function (row) { return String(row.EmailLogID || '') === String(response.EmailLogID || ''); }, limit: 2 });
    if (attempts.some(function (row) { return String(row.Result || '') === 'SENDING'; })) throw new ApiError_('EMAIL_DELIVERY_UNCERTAIN', 'Email delivery outcome is uncertain and requires manual reconciliation.');
    throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
  }
  response.email = { result: String(outcome.Result), sentAt: outcome.SentAt || '', errorMessage: String(outcome.ErrorMessage || ''), emailLogId: String(outcome.EmailLogID || response.EmailLogID) };
  response = finalizeEmailOutcomeLocked_(context, entry, response);
  response.deliveryPending = false;
  response.replayed = Boolean(replayed);
  ensureEmailRequestAudit_(context, entry, response);
  const completedResponse = Object.assign({}, response);
  delete completedResponse.ExpectedVersion;
  delete completedResponse.FinalizeChangeSetID;
  delete completedResponse.OriginalLastChangeSetID;
  delete completedResponse.PreparedSnapshot;
  delete completedResponse.PreparationPhase;
  delete completedResponse.RetryCount;
  delete completedResponse.SourceChangeSetID;
  completeStaffMutationRequest_(context, entry.RequestID, entry.Action, entry.OrderID, completedResponse);
  return completedResponse;
}

function findTerminalEmailOutcome_(attemptId) {
  const logs = readRecords_('EmailLog');
  const terminalResult = function (log) { return ['SUCCESS', 'FAILED', 'SKIPPED_DISABLED'].indexOf(String(log.Result || '')) >= 0; };
  const direct = logs.filter(function (log) { return String(log.EmailLogID || '') === String(attemptId || '') && terminalResult(log); });
  if (direct.length) return direct[direct.length - 1];
  const receiptIds = readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === 'EMAIL_SNAPSHOT'; } }).filter(function (row) {
    try { return String(JSON.parse(String(row.ResponseData || '{}')).attemptEmailLogId || '') === String(attemptId || ''); } catch (_ignored) { return false; }
  }).map(function (row) { return String(row.RequestID || ''); });
  const terminal = logs.filter(function (log) { return receiptIds.indexOf(String(log.EmailLogID || '')) >= 0 && terminalResult(log); });
  return terminal.length ? terminal[terminal.length - 1] : null;
}

function finalizeEmailOutcomeLocked_(context, requestEntry, response) {
  const header = findOrderHeader_(response.OrderID);
  if (!header) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  const emailType = String(response.EmailType || '');
  if (response.email.result === 'FAILED') {
    const isReceivedEmail = emailType === 'MEDICATION_RECEIVED';
    const expectedState = !isReceivedEmail || (String(header.Status || '') === 'RECEIVED' && Number(header.Version) === Number(response.ExpectedVersion) && String(header.LastChangeSetID || '') === String(response.OriginalLastChangeSetID || ''));
    if (isReceivedEmail && expectedState && String(header.NotificationStatus || '') !== 'FAILED') updateRecordByKey_('OrderHeaders', 'OrderID', response.OrderID, { NotificationStatus: 'FAILED', UpdatedAt: new Date().toISOString(), UpdatedBy: String(context.user.StaffID) });
    response.Version = Number(header.Version); response.Status = String(header.Status); response.retryEligible = expectedState;
    response.finalizationOutcome = expectedState ? 'DELIVERY_FAILED_STATE_UNCHANGED' : 'DELIVERY_FAILED_STATE_NOT_UPDATED';
    response.finalizationReason = expectedState ? 'EMAIL_DELIVERY_FAILED' : 'CONCURRENT_STATE';
    return response;
  }
  if (response.email.result !== 'SUCCESS') throw new ApiError_('EMAIL_DELIVERY_PENDING', 'Email delivery is pending reconciliation.');
  if (emailType !== 'MEDICATION_RECEIVED') { response.Version = Number(header.Version); response.Status = String(header.Status); return response; }

  const expectedVersion = Number(response.ExpectedVersion), versionAfter = expectedVersion + 1, changeSetId = String(response.FinalizeChangeSetID || '');
  const currentStatus = String(header.Status || ''), currentVersion = Number(header.Version), currentMarker = String(header.LastChangeSetID || '');
  const alreadyOwned = currentStatus === 'NOTIFIED' && currentVersion === versionAfter && currentMarker === changeSetId;
  if (!alreadyOwned) {
    const stateBelongsToFinalizer = ['RECEIVED', 'NOTIFIED'].indexOf(currentStatus) >= 0 && [expectedVersion, versionAfter].indexOf(currentVersion) >= 0 && [String(response.OriginalLastChangeSetID || ''), changeSetId].indexOf(currentMarker) >= 0;
    if (!stateBelongsToFinalizer) {
      response.Version = currentVersion; response.Status = currentStatus; response.retryEligible = false;
      response.finalizationOutcome = 'DELIVERED_STATE_NOT_UPDATED'; response.finalizationReason = 'CONCURRENT_STATE';
      return response;
    }
    const now = new Date().toISOString();
    updateRecordByKey_('OrderHeaders', 'OrderID', response.OrderID, { Status: 'NOTIFIED', Version: versionAfter, NotificationStatus: 'SUCCESS', LastEmailSentAt: response.email.sentAt || now, LastEmailSentBy: String(context.user.StaffID), UpdatedAt: now, UpdatedBy: String(context.user.StaffID), LastChangeSetID: changeSetId, LastChangeType: requestEntry.Action, LastChangedAt: now, LastChangedBy: String(context.user.StaffID) });
  }
  const existingChanges = readRecords_('OrderChangeLog', { predicate: function (row) { return String(row.ChangeSetID || '') === changeSetId && String(row.OrderID || '') === String(response.OrderID) && String(row.ActionType || '') === String(requestEntry.Action); }, limit: 1 });
  if (!existingChanges.length) writeChanges_(staffMutationChangeRows_([{ scope: 'order', itemId: '', field: 'Status', oldValue: 'RECEIVED', newValue: 'NOTIFIED' }], context, Object.assign({}, header, { Status: 'RECEIVED', Version: expectedVersion }), versionAfter, changeSetId, requestEntry.RequestID, requestEntry.Action, ''));
  response.Version = versionAfter; response.Status = 'NOTIFIED'; response.retryEligible = false;
  response.finalizationOutcome = 'DELIVERED_STATE_UPDATED'; response.finalizationReason = 'EXPECTED_STATE';
  return response;
}

function ensureEmailRequestAudit_(context, entry, response) {
  const existing = readRecords_('AuditLog', { predicate: function (row) { return String(row.Action || '') === String(entry.Action) && String(row.RequestID || '') === String(entry.RequestID) && String(row.OrderID || '') === String(entry.OrderID); }, limit: 1 });
  if (!existing.length) writeAudit_(orderAuditEntry_(context, entry.RequestID, entry.OrderID, entry.Action, response.finalizationOutcome || response.email.result, JSON.stringify({ reason: response.finalizationReason || '', emailResult: response.email.result, error: response.email.errorMessage || '' })));
}

function assertLatestEmailChainAttempt_(sourceLog, sourceSnapshot) {
  const chainKey = emailAttemptChainKey_(sourceLog, sourceSnapshot);
  const snapshots = {};
  readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === 'EMAIL_SNAPSHOT'; } }).forEach(function (row) {
    try { snapshots[String(row.RequestID || '')] = JSON.parse(String(row.ResponseData || '{}')); } catch (_ignored) {}
  });
  const attempts = readRecords_('EmailLog').filter(function (log) {
    return emailAttemptChainKey_(log, snapshots[String(log.EmailLogID || '')] || {}) === chainKey;
  });
  const latestRetry = attempts.reduce(function (latest, log) { return Math.max(latest, Number(log.RetryCount || 0)); }, -1);
  if (Number(sourceLog.RetryCount || 0) !== latestRetry) throw new ApiError_('VALIDATION_ERROR', 'Only the latest failed email attempt in this event chain can be retried.');
  const associatedPendingId = String(sourceSnapshot.attemptEmailLogId || sourceLog.EmailLogID || '');
  if (attempts.some(function (log) {
    if (Number(log.RetryCount || 0) !== latestRetry || String(log.EmailLogID || '') === String(sourceLog.EmailLogID || '')) return false;
    if (String(log.Result || '') === 'SUCCESS') return true;
    return ['PENDING', 'SENDING'].indexOf(String(log.Result || '')) >= 0 && String(log.EmailLogID || '') !== associatedPendingId;
  })) throw new ApiError_('VALIDATION_ERROR', 'This email event already has a newer attempt.');
}

function assertEmailRetryCompatible_(sourceLog, snapshot, header) {
  const expectedVersion = Number(snapshot.event && snapshot.event.orderVersion || snapshot.header && snapshot.header.Version || 0);
  const expectedMarker = String(snapshot.header && snapshot.header.LastChangeSetID || '');
  const type = String(sourceLog.EmailType || '');
  const snapshotStatus = String(snapshot.header && snapshot.header.Status || '');
  const statusCompatible = type === 'MEDICATION_RECEIVED' ? String(header.Status || '') === 'RECEIVED' : (!snapshotStatus || String(header.Status || '') === snapshotStatus);
  const markerCompatible = !expectedMarker || String(header.LastChangeSetID || '') === expectedMarker;
  if (!statusCompatible || Number(header.Version) !== expectedVersion || !markerCompatible) throw new ApiError_('EMAIL_RETRY_STALE', 'The order changed after this email attempt and cannot be retried.');
}

function requireAdminOrderContext_(context) { if (!context || !context.user || String(context.user.Role || '').toUpperCase() !== 'ADMIN') throw new ApiError_('ACCESS_DENIED', 'Access denied.'); return context; }
function adminOrderSummary_(record) { return { OrderID: String(record.OrderID || ''), CreatedAt: record.CreatedAt || '', Department: String(record.Department || ''), WardClinic: String(record.WardClinic || ''), RequiredDate: String(record.RequiredDate || ''), Priority: String(record.Priority || ''), Status: String(record.Status || ''), ItemCount: Number(record.ItemCount || 0), Version: Number(record.Version || 0) }; }
function currentDepartmentForCache_(model) { return model && model.header ? model.header.Department : ''; }
function emailTextForOrder_(value) { return String(value == null ? '' : value).trim(); }

function normalizeAdminReceivePayload_(payload, requestId) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const unknown = Object.keys(input).filter(function (field) { return ADMIN_RECEIVE_ENVELOPE_FIELDS_.indexOf(field) < 0; });
  const orderId = cleanOrderText_(input.OrderID), expectedVersion = Number(input.expectedVersion), normalizedRequestId = String(requestId || '').trim();
  if (unknown.length || !orderId || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !normalizedRequestId || !Array.isArray(input.Items) || !input.Items.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid receiving update.');
  return { OrderID: orderId, expectedVersion: expectedVersion, requestId: normalizedRequestId, Items: input.Items };
}

function buildAdminReceivingPlan_(currentItems, submittedItems, context) {
  const byId = Object.create(null), seen = Object.create(null), updates = [], changes = [];
  (currentItems || []).forEach(function (item) { byId[String(item.OrderItemID || '')] = item; });
  submittedItems.forEach(function (entry, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiError_('VALIDATION_ERROR', 'Invalid received medication item.');
    const unknown = Object.keys(entry).filter(function (field) { return ADMIN_RECEIVE_ITEM_FIELDS_.indexOf(field) < 0; });
    const id = cleanOrderText_(entry.OrderItemID);
    if (unknown.length || !id || seen[id] || !byId[id]) throw new ApiError_('VALIDATION_ERROR', 'Invalid received medication item.');
    seen[id] = true;
    const existing = byId[id];
    const normalized = normalizeReceivedItem_(entry, existing, index);
    const itemUpdates = { UpdatedAt: new Date().toISOString(), UpdatedBy: String(context.user.StaffID) };
    ADMIN_RECEIVE_ITEM_FIELDS_.slice(1).forEach(function (field) {
      if (String(existing[field] == null ? '' : existing[field]) !== String(normalized[field] == null ? '' : normalized[field])) { itemUpdates[field] = normalized[field]; changes.push({ scope: 'item', itemId: id, field: field, oldValue: existing[field], newValue: normalized[field] }); }
    });
    if (Object.keys(itemUpdates).length > 2) updates.push({ keyValue: id, updates: itemUpdates });
  });
  const finalItems = (currentItems || []).map(function (item) { const update = updates.filter(function (entry) { return String(entry.keyValue) === String(item.OrderItemID); })[0]; return update ? Object.assign({}, item, update.updates) : item; });
  return { itemUpdates: updates, finalItems: finalItems, changes: changes };
}

function normalizeReceivedItem_(entry, existing, index) {
  const status = cleanOrderText_(entry.ItemStatus).toUpperCase(), date = cleanOrderText_(entry.ReceivedDate), unit = cleanOrderText_(entry.ReceivedUnit).toUpperCase(), note = entry.AdminNote == null ? '' : cleanOrderText_(entry.AdminNote), quantity = Number(entry.ReceivedQuantity), requested = Number(existing.RequestedQuantity);
  const errors = [];
  if (['PARTIALLY_RECEIVED', 'RECEIVED'].indexOf(status) < 0) errors.push({ field: 'Items[' + index + '].ItemStatus', message: 'Received item status is invalid.' });
  if (!canAdminReceiveItemTransition_(existing.ItemStatus, status)) errors.push({ field: 'Items[' + index + '].ItemStatus', message: 'Medication item cannot be reopened or moved to this status.' });
  if (!validOrderDate_(date)) errors.push({ field: 'Items[' + index + '].ReceivedDate', message: 'Received date must be valid.' });
  if (!isFinite(quantity) || quantity <= 0 || quantity > requested) errors.push({ field: 'Items[' + index + '].ReceivedQuantity', message: 'Received quantity must be positive and no greater than requested quantity.' });
  if (status === 'RECEIVED' && quantity !== requested) errors.push({ field: 'Items[' + index + '].ReceivedQuantity', message: 'A received item must have its full requested quantity.' });
  if (status === 'PARTIALLY_RECEIVED' && quantity >= requested) errors.push({ field: 'Items[' + index + '].ReceivedQuantity', message: 'A partially received item must be below requested quantity.' });
  if (!unit || unit.length > ORDER_TEXT_LIMITS_.Unit) errors.push({ field: 'Items[' + index + '].ReceivedUnit', message: 'Received unit is required.' });
  const master = getMasterData_(['UNIT']);
  if (!(master.UNIT || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === unit; })) errors.push({ field: 'Items[' + index + '].ReceivedUnit', message: 'Received unit is unavailable or inactive.' });
  if (note.length > 1000) errors.push({ field: 'Items[' + index + '].AdminNote', message: 'Admin note is too long.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid received medication item.', errors);
  return { ItemStatus: status, ReceivedDate: date, ReceivedQuantity: quantity, ReceivedUnit: unit, AdminNote: note };
}

function deriveReceivingStatus_(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const statuses = items.map(function (item) { return String(item.ItemStatus || ''); });
  if (statuses.some(function (status) { return ['SUBMITTED', 'UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'COMPLETED'].indexOf(status) < 0; })) return null;
  const active = statuses.filter(function (status) { return status !== 'CANCELLED'; });
  if (!active.length) return 'CANCELLED';
  if (statuses.length !== active.length) return 'PARTIALLY_CANCELLED';
  if (active.every(function (status) { return status === 'RECEIVED' || status === 'COMPLETED'; })) return active.length === statuses.length ? 'RECEIVED' : 'PARTIALLY_CANCELLED';
  if (statuses.some(function (status) { return status === 'PARTIALLY_RECEIVED' || status === 'RECEIVED' || status === 'COMPLETED'; })) return 'PARTIALLY_RECEIVED';
  return 'ORDERED';
}

function canAdminReceiveItemTransition_(from, to) {
  const current = String(from || '');
  if (current === to) return true;
  if (['CANCELLED', 'COMPLETED'].indexOf(current) >= 0) return false;
  const allowed = { SUBMITTED: ['PARTIALLY_RECEIVED', 'RECEIVED'], UNDER_REVIEW: ['PARTIALLY_RECEIVED', 'RECEIVED'], ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED'], PARTIALLY_RECEIVED: ['RECEIVED'], RECEIVED: [] };
  return (allowed[current] || []).indexOf(to) >= 0;
}
function canAdminReceiveOrderTransition_(from, to) {
  const current = String(from || '');
  if (current === to) return true;
  if (['CANCEL_REQUESTED', 'CANCELLED', 'COMPLETED', 'REJECTED', 'NOTIFIED', 'PATIENT_RECEIVED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED'].indexOf(current) >= 0) return false;
  return ['PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_CANCELLED', 'CANCELLED', 'ORDERED'].indexOf(to) >= 0;
}

// These are deliberately local to the Apps Script service.  Shared CommonJS
// contracts cover the wider workflow; staff mutations additionally enforce the
// persisted Sheets column allowlist below.
const STAFF_EDITABLE_ORDER_FIELDS_ = Object.freeze(['RequesterPhone', 'HN', 'PatientName', 'WardClinic', 'RequiredDate', 'Priority']);
const STAFF_EDITABLE_ITEM_FIELDS_ = Object.freeze(['GenericName', 'BrandName', 'Strength', 'DosageForm', 'RequestedQuantity', 'Unit', 'Prescriber']);
const STAFF_UPDATE_ENVELOPE_FIELDS_ = Object.freeze(['OrderID', 'expectedVersion', 'Items'].concat(STAFF_EDITABLE_ORDER_FIELDS_));
const STAFF_CANCEL_ENVELOPE_FIELDS_ = Object.freeze(['OrderID', 'expectedVersion', 'ReasonCode', 'ReasonDetail']);
const ADMIN_CANCEL_DECISION_FIELDS_ = Object.freeze(['OrderID', 'expectedVersion', 'decision', 'decisionReason']);
const STAFF_CANCELLABLE_ORDER_STATUSES_ = Object.freeze(['SUBMITTED', 'UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'NOTIFIED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED']);

/** Update an order only through trusted identity, version, and field policies. */
function updateOrderByStaff_(context, payload, requestId) {
  const input = normalizeStaffMutationPayload_(payload, requestId, STAFF_UPDATE_ENVELOPE_FIELDS_);
  const orderId = input.OrderID;
  const preLockOrder = findOrderHeader_(orderId);
  if (!preLockOrder) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireOrderAccess_(context, preLockOrder);
  const replay = findStaffMutationReplay_('UPDATE_ORDER', context.user.StaffID, input.requestId);
  if (replay) {
    finalizePostCommitNoticeSafe_(context, replay);
    return replayStaffMutation_(replay);
  }

  const lock = LockService.getScriptLock();
  let result;
  let email = null;
  let recovery = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('UPDATE_ORDER', context.user.StaffID, input.requestId);
    if (lockedReplay) return replayStaffMutation_(lockedReplay);
    const current = findOrderHeader_(orderId);
    if (!current) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    requireOrderAccess_(context, current);
    assertExpectedOrderVersion_(current, input.expectedVersion);
    assertStaffCanEditOrder_(current);
    const currentItems = getOrderItems_(orderId);
    const plan = buildStaffUpdatePlan_(current, currentItems, input, context);
    if (!plan.changes.length) throw new ApiError_('VALIDATION_ERROR', 'No editable changes were supplied.');
    const now = new Date().toISOString();
    const versionAfter = Number(current.Version) + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    const headerUpdates = Object.assign({}, plan.headerUpdates, {
      Version: versionAfter, UpdatedAt: now, UpdatedBy: String(context.user.StaffID),
      LastChangeSetID: changeSetId, LastChangeType: 'UPDATE_ORDER', LastChangedAt: now,
      LastChangedBy: String(context.user.StaffID), LastChangeReason: '', ItemCount: plan.itemCount,
    });
    recovery = { orderId: orderId, current: current, currentItems: currentItems, versionAfter: versionAfter, changeSetId: changeSetId, newItemIds: plan.newItems.map(function (item) { return item.OrderItemID; }), changes: plan.changes, historyWritten: false, action: 'UPDATE_ORDER' };
    beginStaffMutationRequest_(context, input.requestId, 'UPDATE_ORDER', orderId);
    try {
      updateRecordByKey_('OrderHeaders', 'OrderID', orderId, headerUpdates);
      batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', plan.itemUpdates.map(function (update) { return { keyValue: update.OrderItemID, updates: update.updates }; }));
      if (plan.newItems.length) appendRecords_('OrderItems', plan.newItems);
      writeChanges_(staffMutationChangeRows_(plan.changes, context, current, versionAfter, changeSetId, input.requestId, 'UPDATE_ORDER', ''));
      recovery.historyWritten = true;
      result = { OrderID: orderId, Version: versionAfter, Status: String(current.Status), ChangeSetID: changeSetId, replayed: false };
      writeAudit_(orderAuditEntry_(context, input.requestId, orderId, 'UPDATE_ORDER', 'SUCCESS', JSON.stringify({ changes: plan.changes.length, versionBefore: current.Version, versionAfter: versionAfter })));
      email = { kind: 'UPDATE', header: Object.assign({}, current, headerUpdates), items: plan.newItems.concat(currentItems), changes: plan.changes, changeSetId: changeSetId, reason: '', eventAt: now, orderVersion: versionAfter };
      completeStaffMutationRequest_(context, input.requestId, 'UPDATE_ORDER', orderId, durableStaffMutationResponse_(context, result, email));
    } catch (error) {
      recoverStaffMutationFailure_(context, input.requestId, 'UPDATE_ORDER', recovery, error);
      throw error;
    }
  } finally {
    lock.releaseLock();
  }
  invalidateDashboardCache_(context.user.Department);
  finalizePostCommitByIdentitySafe_(context, 'UPDATE_ORDER', input.requestId, orderId);
  return result;
}

/** Request or complete cancellation without deleting the header or its items. */
function cancelOrderByStaff_(context, payload, requestId) {
  const input = normalizeStaffMutationPayload_(payload, requestId, STAFF_CANCEL_ENVELOPE_FIELDS_);
  validateStaffCancellation_(input);
  const requestSignature = staffCancelSignature_(input);
  const preLockOrder = findOrderHeader_(input.OrderID);
  if (!preLockOrder) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireOrderAccess_(context, preLockOrder);
  const replay = findStaffMutationReplay_('CANCEL_ORDER', context.user.StaffID, input.requestId, requestSignature);
  if (replay) {
    finalizePostCommitNoticeSafe_(context, replay);
    return replayStaffMutation_(replay);
  }

  const lock = LockService.getScriptLock();
  let result;
  let email = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('CANCEL_ORDER', context.user.StaffID, input.requestId, requestSignature);
    if (lockedReplay) return replayStaffMutation_(lockedReplay);
    const current = findOrderHeader_(input.OrderID);
    if (!current) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    requireOrderAccess_(context, current);
    assertExpectedOrderVersion_(current, input.expectedVersion);
    assertStaffCanCancelOrder_(current);
    const now = new Date().toISOString();
    const requiresApproval = settingEnabled_(cancellationApprovalSettingKey_(), false);
    const nextStatus = !requiresApproval && canDirectStaffCancel_(current.Status) ? 'CANCELLED' : 'CANCEL_REQUESTED';
    const versionAfter = Number(current.Version) + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    const headerUpdates = {
      Status: nextStatus, Version: versionAfter, UpdatedAt: now, UpdatedBy: String(context.user.StaffID),
      LastChangeSetID: changeSetId, LastChangeType: 'CANCEL_ORDER', LastChangeReason: input.ReasonCode,
      LastChangedAt: now, LastChangedBy: String(context.user.StaffID), CancelReason: input.ReasonCode,
      CancellationPreviousStatus: String(current.Status || ''), CancellationRequestID: input.requestId,
      CancellationRequestedAt: now, CancellationRequestedBy: String(context.user.StaffID),
      CancellationDecision: '', CancellationDecisionAt: '', CancellationDecisionBy: '', CancellationDecisionReason: '',
    };
    if (nextStatus === 'CANCELLED') { headerUpdates.CancelledAt = now; headerUpdates.CancelledBy = String(context.user.StaffID); }
    const changes = [
      { scope: 'order', itemId: '', field: 'Status', oldValue: String(current.Status || ''), newValue: nextStatus },
      { scope: 'order', itemId: '', field: 'CancelReason', oldValue: String(current.CancelReason || ''), newValue: input.ReasonCode },
    ];
    if (input.ReasonDetail) changes.push({ scope: 'order', itemId: '', field: 'CancelReasonDetail', oldValue: '', newValue: input.ReasonDetail });
    const currentItems = getOrderItems_(input.OrderID);
    const itemUpdates = currentItems.map(function (item) {
      const itemStatus = String(item.ItemStatus || '');
      if (['SUBMITTED', 'UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].indexOf(itemStatus) < 0) throw new ApiError_('INVALID_STATUS_TRANSITION', 'A medication item cannot be cancelled in its current status.');
      const status = nextStatus === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      changes.push({ scope: 'item', itemId: item.OrderItemID, field: 'ItemStatus', oldValue: itemStatus, newValue: status });
      return { keyValue: item.OrderItemID, updates: { ItemStatus: status, CancellationPreviousStatus: itemStatus, UpdatedAt: now, UpdatedBy: String(context.user.StaffID) } };
    });
    const recovery = { orderId: input.OrderID, current: current, currentItems: currentItems, versionAfter: versionAfter, changeSetId: changeSetId, newItemIds: [], changes: changes, historyWritten: false, action: 'CANCEL_ORDER', requestSignature: requestSignature, actionTokens: captureActiveOrderTokensLocked_(input.OrderID), actionTokenExpected: [] };
    beginStaffMutationRequest_(context, input.requestId, 'CANCEL_ORDER', input.OrderID, requestSignature);
    try {
      updateRecordByKey_('OrderHeaders', 'OrderID', input.OrderID, headerUpdates);
      batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', itemUpdates);
      recovery.actionTokenExpected = revokeActiveOrderTokensLocked_(input.OrderID, String(context.user.StaffID), new Date(now), input.requestId);
      writeChanges_(staffMutationChangeRows_(changes, context, current, versionAfter, changeSetId, input.requestId, 'CANCEL_ORDER', input.ReasonCode));
      recovery.historyWritten = true;
      result = { OrderID: input.OrderID, Version: versionAfter, Status: nextStatus, ChangeSetID: changeSetId, replayed: false };
      writeAudit_(orderAuditEntry_(context, input.requestId, input.OrderID, 'CANCEL_ORDER', 'SUCCESS', JSON.stringify({ previousStatus: current.Status, status: nextStatus, reasonCode: input.ReasonCode, reasonDetail: input.ReasonDetail || '' })));
      email = { kind: 'CANCEL', header: Object.assign({}, current, headerUpdates), items: recovery.currentItems, changes: changes, changeSetId: changeSetId, reason: input.ReasonCode, detail: input.ReasonDetail, status: nextStatus, previousStatus: current.Status, eventAt: now, orderVersion: versionAfter };
      completeStaffMutationRequest_(context, input.requestId, 'CANCEL_ORDER', input.OrderID, durableStaffMutationResponse_(context, result, email), requestSignature);
    } catch (error) {
      recoverStaffMutationFailure_(context, input.requestId, 'CANCEL_ORDER', recovery, error);
      throw error;
    }
  } finally {
    lock.releaseLock();
  }
  invalidateDashboardCache_(context.user.Department);
  finalizePostCommitByIdentitySafe_(context, 'CANCEL_ORDER', input.requestId, input.OrderID);
  return result;
}

function decideCancellationByAdmin_(context, payload, requestId) {
  requireAdminOrderContext_(context);
  const input = normalizeAdminCancelDecision_(payload, requestId);
  const requestSignature = cancelDecisionSignature_(input);
  const replay = findStaffMutationReplay_('DECIDE_CANCELLATION', context.user.StaffID, input.requestId, requestSignature);
  if (replay) return replayStaffMutation_(replay);
  const preLockOrder = findOrderHeader_(input.OrderID);
  if (!preLockOrder) throw new ApiError_('ACCESS_DENIED', 'Access denied.');

  const lock = LockService.getScriptLock();
  let result;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('DECIDE_CANCELLATION', context.user.StaffID, input.requestId, requestSignature);
    if (lockedReplay) return replayStaffMutation_(lockedReplay);
    const current = findOrderHeader_(input.OrderID);
    if (!current) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
    assertExpectedOrderVersion_(current, input.expectedVersion);
    if (String(current.Status || '') !== 'CANCEL_REQUESTED') throw new ApiError_('INVALID_STATUS_TRANSITION', 'This cancellation request is no longer pending.');
    const previousStatus = String(current.CancellationPreviousStatus || '');
    if (STAFF_CANCELLABLE_ORDER_STATUSES_.indexOf(previousStatus) < 0) throw new ApiError_('INVALID_STATUS_TRANSITION', 'The recorded cancellation state cannot be restored.');
    const currentItems = getOrderItems_(input.OrderID);
    const now = new Date().toISOString();
    const versionAfter = Number(current.Version) + 1;
    const changeSetId = 'CHGSET-' + Utilities.getUuid();
    const approved = input.decision === 'APPROVE';
    const finalStatus = approved ? 'CANCELLED' : previousStatus;
    const headerUpdates = {
      Status: finalStatus, Version: versionAfter, UpdatedAt: now, UpdatedBy: String(context.user.StaffID),
      LastChangeSetID: changeSetId, LastChangeType: 'DECIDE_CANCELLATION', LastChangeReason: input.decisionReason,
      LastChangedAt: now, LastChangedBy: String(context.user.StaffID),
      CancellationDecision: approved ? 'APPROVED' : 'REJECTED', CancellationDecisionAt: now,
      CancellationDecisionBy: String(context.user.StaffID), CancellationDecisionReason: input.decisionReason,
    };
    if (approved) { headerUpdates.CancelledAt = now; headerUpdates.CancelledBy = String(context.user.StaffID); }
    const changes = [
      { scope: 'order', itemId: '', field: 'Status', oldValue: 'CANCEL_REQUESTED', newValue: approved ? finalStatus : 'CANCEL_REJECTED' },
      { scope: 'order', itemId: '', field: 'CancellationDecision', oldValue: '', newValue: headerUpdates.CancellationDecision },
    ];
    if (!approved) changes.push({ scope: 'order', itemId: '', field: 'Status', oldValue: 'CANCEL_REJECTED', newValue: finalStatus });
    const itemUpdates = currentItems.map(function (item) {
      if (String(item.ItemStatus || '') !== 'CANCEL_REQUESTED') throw new ApiError_('INVALID_STATUS_TRANSITION', 'A medication item is not pending cancellation.');
      const prior = String(item.CancellationPreviousStatus || '');
      if (!approved && ['SUBMITTED', 'UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].indexOf(prior) < 0) throw new ApiError_('INVALID_STATUS_TRANSITION', 'A medication item cannot be restored.');
      const next = approved ? 'CANCELLED' : prior;
      changes.push({ scope: 'item', itemId: item.OrderItemID, field: 'ItemStatus', oldValue: 'CANCEL_REQUESTED', newValue: next });
      return { keyValue: item.OrderItemID, updates: { ItemStatus: next, UpdatedAt: now, UpdatedBy: String(context.user.StaffID) } };
    });
    const cancellationRequestId = String(current.CancellationRequestID || '');
    const recovery = {
      orderId: input.OrderID, current: current, currentItems: currentItems, versionAfter: versionAfter,
      changeSetId: changeSetId, newItemIds: [], changes: changes, historyWritten: false,
      action: 'DECIDE_CANCELLATION', requestSignature: requestSignature,
      actionTokens: captureCancellationTokensLocked_(input.OrderID, cancellationRequestId), actionTokenExpected: [],
    };
    beginStaffMutationRequest_(context, input.requestId, 'DECIDE_CANCELLATION', input.OrderID, requestSignature);
    try {
      updateRecordByKey_('OrderHeaders', 'OrderID', input.OrderID, headerUpdates);
      batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', itemUpdates);
      if (!approved) recovery.actionTokenExpected = restoreRejectedCancelTokensLocked_(input.OrderID, cancellationRequestId, new Date(now));
      writeChanges_(staffMutationChangeRows_(changes, context, current, versionAfter, changeSetId, input.requestId, 'DECIDE_CANCELLATION', input.decisionReason));
      recovery.historyWritten = true;
      result = { OrderID: input.OrderID, Version: versionAfter, Status: finalStatus, CancellationDecision: headerUpdates.CancellationDecision, ChangeSetID: changeSetId, replayed: false };
      writeAudit_(orderAuditEntry_(context, input.requestId, input.OrderID, 'DECIDE_CANCELLATION', 'SUCCESS', JSON.stringify({ decision: headerUpdates.CancellationDecision, previousStatus: previousStatus, status: finalStatus })));
      completeStaffMutationRequest_(context, input.requestId, 'DECIDE_CANCELLATION', input.OrderID, result, requestSignature);
    } catch (error) {
      recoverStaffMutationFailure_(context, input.requestId, 'DECIDE_CANCELLATION', recovery, error);
      throw error;
    }
  } finally {
    lock.releaseLock();
  }
  invalidateDashboardCache_(currentDepartmentForCache_({ header: preLockOrder }));
  return result;
}

function normalizeAdminCancelDecision_(payload, requestId) {
  const input = normalizeStaffMutationPayload_(payload, requestId, ADMIN_CANCEL_DECISION_FIELDS_);
  const decision = String(input.decision || '').trim().toUpperCase();
  const reason = String(input.decisionReason || '').trim();
  if (['APPROVE', 'REJECT'].indexOf(decision) < 0) throw new ApiError_('VALIDATION_ERROR', 'A cancellation decision is required.', [{ field: 'decision', message: 'Choose APPROVE or REJECT.' }]);
  if (reason.length > 1000) throw new ApiError_('VALIDATION_ERROR', 'Cancellation decision reason is too long.', [{ field: 'decisionReason', message: 'Decision reason must not exceed 1000 characters.' }]);
  input.decision = decision;
  input.decisionReason = reason;
  return input;
}

function cancelDecisionSignature_(input) {
  return sha256Hex_(JSON.stringify([
    String(input.OrderID || ''),
    Number(input.expectedVersion),
    String(input.decision || ''),
    String(input.decisionReason || ''),
  ]));
}

function staffCancelSignature_(input) {
  return sha256Hex_(JSON.stringify([
    String(input.OrderID || ''),
    Number(input.expectedVersion),
    String(input.ReasonCode || ''),
    String(input.ReasonDetail || ''),
  ]));
}

function normalizeStaffMutationPayload_(payload, requestId, allowedFields) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const unknown = Object.keys(input).filter(function (field) { return allowedFields.indexOf(field) < 0; });
  if (unknown.length) {
    const statusOnly = unknown.length === 1 && unknown[0] === 'Status';
    throw new ApiError_(statusOnly ? 'INVALID_STATUS_TRANSITION' : 'VALIDATION_ERROR', statusOnly ? 'Staff cannot set order status.' : 'Unsupported order fields.', unknown.map(function (field) { return { field: field, message: 'This field is not editable.' }; }));
  }
  const orderId = typeof input.OrderID === 'string' ? input.OrderID.trim() : '';
  const expectedVersion = Number(input.expectedVersion);
  const normalizedRequestId = String(requestId || '').trim();
  if (!orderId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(orderId) || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !normalizedRequestId) {
    throw new ApiError_('VALIDATION_ERROR', 'Invalid order mutation.', [{ field: !orderId ? 'OrderID' : (!Number.isInteger(expectedVersion) ? 'expectedVersion' : 'requestId'), message: 'A valid value is required.' }]);
  }
  const result = { OrderID: orderId, expectedVersion: expectedVersion, requestId: normalizedRequestId };
  allowedFields.forEach(function (field) { if (Object.prototype.hasOwnProperty.call(input, field)) result[field] = input[field]; });
  return result;
}

function assertExpectedOrderVersion_(order, expectedVersion) {
  if (Number(order.Version) !== Number(expectedVersion)) throw new ApiError_('ORDER_VERSION_CONFLICT', 'This order was changed by another user. Reload and try again.');
}

function assertStaffCanEditOrder_(order) {
  const status = String(order.Status || '');
  if (status === 'SUBMITTED') return;
  if (status === 'ORDERED' && settingEnabled_('STAFF_CAN_EDIT_ORDERED', false)) return;
  throw new ApiError_('INVALID_STATUS_TRANSITION', 'This order cannot be edited in its current status.');
}

function assertStaffCanCancelOrder_(order) {
  const status = String(order.Status || '');
  if (STAFF_CANCELLABLE_ORDER_STATUSES_.indexOf(status) < 0) throw new ApiError_('INVALID_STATUS_TRANSITION', 'This order cannot be cancelled in its current status.');
  if (status === 'ORDERED' && !settingEnabled_('STAFF_CAN_CANCEL_ORDERED', false)) throw new ApiError_('INVALID_STATUS_TRANSITION', 'This order cannot be cancelled in its current status.');
}

function canDirectStaffCancel_(status) {
  return ['SUBMITTED', 'UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].indexOf(String(status || '')) >= 0;
}

function settingEnabled_(key, fallback) {
  return String(getSetting_(key, fallback ? 'TRUE' : 'FALSE')).toUpperCase() === 'TRUE';
}

function cancellationApprovalSettingKey_() {
  return ['CANCELLATION_REQUIRES_ADMIN', 'APPROVAL'].join('_');
}

function buildStaffUpdatePlan_(current, currentItems, input, context) {
  const headerUpdates = {};
  const changes = [];
  STAFF_EDITABLE_ORDER_FIELDS_.forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) return;
    const value = normalizeStaffOrderField_(field, input[field]);
    if (String(current[field] == null ? '' : current[field]) !== String(value == null ? '' : value)) {
      headerUpdates[field] = value;
      changes.push({ scope: 'order', itemId: '', field: field, oldValue: current[field], newValue: value });
    }
  });
  if (!Object.prototype.hasOwnProperty.call(input, 'Items')) {
    return { headerUpdates: headerUpdates, itemUpdates: [], newItems: [], itemCount: (currentItems || []).length, changes: changes };
  }
  const submittedItems = Object.create(null);
  (currentItems || []).forEach(function (item) { submittedItems[String(item.OrderItemID)] = item; });
  const proposedItems = Object.prototype.hasOwnProperty.call(input, 'Items') ? input.Items : currentItems;
  if (!Array.isArray(proposedItems)) throw new ApiError_('VALIDATION_ERROR', 'Medication items must be an array.', [{ field: 'Items', message: 'Medication items must be an array.' }]);
  const seen = Object.create(null);
  const itemUpdates = [];
  const newItems = [];
  let nextItemNo = (currentItems || []).reduce(function (max, item) { return Math.max(max, Number(item.ItemNo) || 0); }, 0);
  proposedItems.forEach(function (item, index) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError_('VALIDATION_ERROR', 'Medication item is invalid.', [{ field: 'Items[' + index + ']', message: 'Medication item is invalid.' }]);
    const suppliedId = typeof item.OrderItemID === 'string' ? item.OrderItemID.trim() : '';
    if (suppliedId && seen[suppliedId]) throw new ApiError_('VALIDATION_ERROR', 'Medication item IDs must be unique.', [{ field: 'Items[' + index + '].OrderItemID', message: 'Duplicate item ID.' }]);
    if (suppliedId) seen[suppliedId] = true;
    const unknown = Object.keys(item).filter(function (field) { return field !== 'OrderItemID' && STAFF_EDITABLE_ITEM_FIELDS_.indexOf(field) < 0; });
    if (unknown.length) throw new ApiError_('VALIDATION_ERROR', 'Unsupported medication fields.', unknown.map(function (field) { return { field: 'Items[' + index + '].' + field, message: 'This field is not editable.' }; }));
    const existing = suppliedId ? submittedItems[suppliedId] : null;
    if (suppliedId && !existing) throw new ApiError_('VALIDATION_ERROR', 'Medication item does not belong to this order.', [{ field: 'Items[' + index + '].OrderItemID', message: 'Unknown medication item.' }]);
    const normalized = normalizeStaffItem_(item, index, existing);
    if (existing) {
      const updates = { UpdatedAt: new Date().toISOString(), UpdatedBy: String(context.user.StaffID) };
      STAFF_EDITABLE_ITEM_FIELDS_.forEach(function (field) {
        if (String(existing[field] == null ? '' : existing[field]) !== String(normalized[field] == null ? '' : normalized[field])) {
          updates[field] = normalized[field];
          changes.push({ scope: 'item', itemId: suppliedId, field: field, oldValue: existing[field], newValue: normalized[field] });
        }
      });
      if (Object.keys(updates).length > 2) itemUpdates.push({ OrderItemID: suppliedId, updates: updates });
    } else {
      nextItemNo += 1;
      if (nextItemNo > MAX_ORDER_ITEM_COUNT_) throw new ApiError_('VALIDATION_ERROR', 'Too many medication items.');
      const newId = String(current.OrderID) + '-' + ('00' + nextItemNo).slice(-2);
      const now = new Date().toISOString();
      const newItem = Object.assign({ OrderItemID: newId, OrderID: String(current.OrderID), ItemNo: nextItemNo, ItemStatus: 'SUBMITTED', CreatedAt: now, CreatedBy: String(context.user.StaffID), UpdatedAt: now, UpdatedBy: String(context.user.StaffID), Active: 'TRUE' }, normalized);
      newItems.push(newItem);
      STAFF_EDITABLE_ITEM_FIELDS_.forEach(function (field) { changes.push({ scope: 'item', itemId: newId, field: field, oldValue: '', newValue: normalized[field] }); });
    }
  });
  Object.keys(submittedItems).forEach(function (id) {
    if (!seen[id]) throw new ApiError_('VALIDATION_ERROR', 'Persisted submitted item ' + id + ' cannot be removed.', [{ field: 'Items', message: 'Submitted medication items cannot be removed.' }]);
  });
  changes.sort(function (left, right) { return left.scope === right.scope ? (left.itemId || '').localeCompare(right.itemId || '') || left.field.localeCompare(right.field) : (left.scope === 'order' ? -1 : 1); });
  return { headerUpdates: headerUpdates, itemUpdates: itemUpdates, newItems: newItems, itemCount: (currentItems || []).length + newItems.length, changes: changes };
}

function normalizeStaffOrderField_(field, value) {
  const text = cleanOrderText_(value);
  if (field === 'HN' && !/^07-\d{2}-\d{6}$/.test(text)) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', [{ field: field, message: 'HN must use the format 07-00-000000.' }]);
  if (field === 'RequiredDate' && !validOrderDate_(text)) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', [{ field: field, message: 'Required date must be valid.' }]);
  if (field === 'Priority') {
    const masterData = getMasterData_(['PRIORITY']);
    validateActiveOrderCode_([], field, text, masterData.PRIORITY, 'Priority');
    const active = (masterData.PRIORITY || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === text.toUpperCase(); });
    if (!active) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', [{ field: field, message: 'Priority is unavailable or inactive.' }]);
    return text.toUpperCase();
  }
  if (field === 'PatientName' && !text) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', [{ field: field, message: 'Patient name is required.' }]);
  if (text.length > (ORDER_TEXT_LIMITS_[field] || 200)) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', [{ field: field, message: 'Value is too long.' }]);
  return text;
}

function normalizeStaffItem_(item, index, existing) {
  const base = existing || {};
  const result = {};
  STAFF_EDITABLE_ITEM_FIELDS_.forEach(function (field) { result[field] = Object.prototype.hasOwnProperty.call(item, field) ? item[field] : base[field]; });
  ['GenericName', 'BrandName', 'Strength', 'Prescriber'].forEach(function (field) { result[field] = cleanOrderText_(result[field]); });
  result.DosageForm = cleanOrderText_(result.DosageForm).toUpperCase();
  result.Unit = cleanOrderText_(result.Unit).toUpperCase();
  result.RequestedQuantity = Number(result.RequestedQuantity);
  const errors = [];
  if (!result.GenericName) errors.push({ field: 'Items[' + index + '].GenericName', message: 'Generic name is required.' });
  if (!result.DosageForm) errors.push({ field: 'Items[' + index + '].DosageForm', message: 'Dosage form is required.' });
  if (!result.Unit) errors.push({ field: 'Items[' + index + '].Unit', message: 'Unit is required.' });
  if (!result.Prescriber) errors.push({ field: 'Items[' + index + '].Prescriber', message: 'Prescriber is required.' });
  if (!isFinite(result.RequestedQuantity) || result.RequestedQuantity <= 0) errors.push({ field: 'Items[' + index + '].RequestedQuantity', message: 'Requested quantity must be positive.' });
  const masterData = getMasterData_(['DOSAGE_FORM', 'UNIT']);
  if (!(masterData.DOSAGE_FORM || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === result.DosageForm; })) errors.push({ field: 'Items[' + index + '].DosageForm', message: 'Dosage form is unavailable or inactive.' });
  if (!(masterData.UNIT || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === result.Unit; })) errors.push({ field: 'Items[' + index + '].Unit', message: 'Unit is unavailable or inactive.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid medication item.', errors);
  return result;
}

function validateStaffCancellation_(input) {
  const reason = typeof input.ReasonCode === 'string' ? input.ReasonCode.trim().toUpperCase() : '';
  const detail = typeof input.ReasonDetail === 'string' ? input.ReasonDetail.trim() : '';
  const masterData = getMasterData_(['CANCEL_REASON']);
  const active = (masterData.CANCEL_REASON || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === reason; });
  if (!active || (reason === 'OTHER' && !detail) || detail.length > 1000) {
    const invalidField = !active ? 'ReasonCode' : 'ReasonDetail';
    const message = !active ? 'Cancellation reason is invalid.' : (!detail ? 'Detail is required for OTHER.' : 'Detail must not exceed 1000 characters.');
    throw new ApiError_('VALIDATION_ERROR', 'A valid cancellation reason is required.', [{ field: invalidField, message: message }]);
  }
  input.ReasonCode = reason;
  input.ReasonDetail = detail;
}

function findStaffMutationReplay_(action, staffId, requestId, requestSignature) {
  const rows = readRecords_('RequestLog', { predicate: function (row) { return String(row.Action || '') === action && String(row.StaffID || '') === String(staffId) && String(row.RequestID || '') === String(requestId); }, limit: 1 });
  if (rows.length && requestSignature) {
    let stored = {};
    try { stored = JSON.parse(String(rows[0].ResponseData || '{}')); } catch (_ignored) {}
    if (stored.requestSignature && String(stored.requestSignature) !== String(requestSignature)) {
      throw new ApiError_('REQUEST_REPLAY', 'This request ID was already used with different cancellation data.');
    }
  }
  return rows.length ? rows[0] : null;
}

function replayStaffMutation_(entry) {
  if (String(entry.Result || '') !== 'SUCCESS') throw new ApiError_('REQUEST_REPLAY', 'The previous request did not complete.');
  let response = {};
  try { response = JSON.parse(String(entry.ResponseData || '{}')); } catch (_ignored) {}
  delete response.postCommitNotification;
  delete response.requestSignature;
  response.replayed = true;
  return response;
}

function durableStaffMutationResponse_(context, result, email) {
  const templateName = email.kind === 'CANCEL' ? 'CANCELLATION' : 'ORDER_UPDATE';
  let enabled = false;
  let policyError = '';
  try {
    enabled = email.kind === 'CANCEL' ? settingEnabled_('CANCEL_EMAIL_ENABLED', true) : settingEnabled_('UPDATE_EMAIL_ENABLED', true);
  } catch (_ignored) {
    policyError = 'NOTIFICATION_POLICY_UNAVAILABLE';
  }
  const model = {
    header: email.header, items: email.items || [], actor: context.user, changeSetId: email.changeSetId,
    changes: email.changes || [], previousStatus: email.previousStatus, cancelReason: email.reason,
    changedBy: context.user.FullName || context.user.StaffID, changedAt: email.eventAt || email.header.UpdatedAt,
    eventAt: email.eventAt, orderVersion: email.orderVersion, changeReason: email.reason,
  };
  const job = makePostCommitNotificationJob_(templateName, model, enabled ? 'SEND' : 'SKIP');
  if (policyError) job.policyError = policyError;
  return Object.assign({}, result, { postCommitNotification: job });
}

function finalizePostCommitByIdentitySafe_(context, action, requestId, orderId) {
  try {
    const entry = findStaffMutationReplay_(action, context.user.StaffID, requestId);
    if (!entry || String(entry.OrderID || '') !== String(orderId || '')) return null;
    return finalizePostCommitNoticeSafe_(context, entry);
  } catch (_ignored) {
    return null;
  }
}

function finalizePostCommitNoticeSafe_(context, entry) {
  let response = {};
  try { response = JSON.parse(String(entry && entry.ResponseData || '{}')); } catch (_ignored) { return null; }
  const job = response.postCommitNotification;
  if (!job || typeof job !== 'object') return null;
  if (job.status === 'TERMINAL' && job.outcome) return job.outcome;
  let outcome;
  try {
    outcome = deliverPostCommitNotificationJob_(job);
  } catch (error) {
    outcome = inspectPostCommitNotificationJob_(job);
    try {
      writeAudit_(orderAuditEntry_(context, entry.RequestID, entry.OrderID, 'POST_COMMIT_NOTIFICATION', 'RECONCILIATION_PENDING', String(outcome.errorMessage || 'EMAIL_RECONCILIATION_PENDING')));
    } catch (_ignored) {}
  }
  job.status = ['SUCCESS', 'FAILED', 'SKIPPED_DISABLED'].indexOf(String(outcome.result || '')) >= 0 ? 'TERMINAL' : String(outcome.result || 'PENDING');
  job.outcome = outcome;
  response.postCommitNotification = job;
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const requestKey = {
        Action: String(entry.Action || ''), StaffID: String(entry.StaffID || ''),
        RequestID: String(entry.RequestID || ''), OrderID: String(entry.OrderID || ''),
      };
      const latestRows = readRecords_('RequestLog', { predicate: function (row) {
        return Object.keys(requestKey).every(function (key) { return String(row[key] || '') === String(requestKey[key] || ''); });
      }, limit: 2 });
      let latestResponse = {};
      try { latestResponse = latestRows.length === 1 ? JSON.parse(String(latestRows[0].ResponseData || '{}')) : {}; } catch (_ignored) {}
      const latestJob = latestResponse.postCommitNotification;
      const candidateTerminal = job.status === 'TERMINAL' && job.outcome;
      if (latestJob && latestJob.status === 'TERMINAL' && latestJob.outcome) {
        outcome = latestJob.outcome;
      } else if (candidateTerminal) {
        updateRecordByCompositeKey_('RequestLog', requestKey, { ResponseData: JSON.stringify(response) });
      } else if (latestJob && latestJob.status === 'UNCERTAIN' && latestJob.outcome) {
        outcome = latestJob.outcome;
      } else {
        updateRecordByCompositeKey_('RequestLog', requestKey, { ResponseData: JSON.stringify(response) });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (_ignored) {
    // The original PENDING job remains durable and is reconciled on replay.
  }
  return outcome;
}

function beginStaffMutationRequest_(context, requestId, action, orderId, requestSignature) {
  const response = { errorCode: 'TRANSACTION_FAILURE', message: 'Order mutation did not complete.' };
  if (requestSignature) response.requestSignature = requestSignature;
  appendRecords_('RequestLog', [{ RequestID: requestId, Action: action, OrderID: orderId, StaffID: String(context.user.StaffID), CreatedAt: new Date().toISOString(), Result: 'TRANSACTION_FAILURE', ResponseData: JSON.stringify(response) }]);
}

function staffRequestKey_(context, action, requestId, orderId) {
  return { Action: action, StaffID: String(context.user.StaffID), RequestID: requestId, OrderID: orderId };
}

function completeStaffMutationRequest_(context, requestId, action, orderId, response, requestSignature) {
  const durableResponse = Object.assign({}, response);
  if (requestSignature) durableResponse.requestSignature = requestSignature;
  updateRecordByCompositeKey_('RequestLog', staffRequestKey_(context, action, requestId, orderId), { Result: 'SUCCESS', ResponseData: JSON.stringify(durableResponse) });
}

function recoverStaffMutationFailure_(context, requestId, action, recovery, error) {
  let rollback = { succeeded: false, detail: 'No business write was applied.' };
  try { rollback = rollbackStaffMutationIfOwned_(recovery); } catch (rollbackError) { rollback = { succeeded: false, detail: 'Rollback failed: ' + String(rollbackError && rollbackError.message || 'unknown error') }; }
  if (recovery.historyWritten) {
    try {
      if (rollback.succeeded) {
        const inverse = (recovery.changes || []).map(function (change) { return { scope: change.scope, itemId: change.itemId, field: change.field, oldValue: change.newValue, newValue: change.oldValue }; });
        const entries = staffMutationChangeRows_(inverse, context, recovery.current, recovery.versionAfter, recovery.changeSetId, requestId, recovery.action + '_ROLLBACK', '', 'ROLLED_BACK');
        entries.forEach(function (entry) { entry.OrderVersionBefore = recovery.versionAfter; entry.OrderVersionAfter = Number(recovery.current.Version); });
        writeChanges_(entries);
      } else {
        writeChanges_([{
          ChangeSetID: recovery.changeSetId, OrderID: recovery.orderId, ChangedByStaffID: String(context.user.StaffID), ChangedByName: String(context.user.FullName || ''), Department: String(recovery.current.Department || ''), ChangedByRole: String(context.user.Role || ''), ActionType: recovery.action + '_ROLLBACK', FieldName: 'ROLLBACK', FieldLabel: 'Rollback', OldValue: '', NewValue: rollback.detail, ChangeReason: '', OrderVersionBefore: recovery.versionAfter, OrderVersionAfter: recovery.versionAfter, RequestID: requestId, Source: 'WEB', Result: 'ROLLBACK_FAILED',
        }]);
      }
    } catch (changeLogError) {
      try { writeAudit_(orderAuditEntry_(context, requestId, recovery.orderId, action, 'COMPENSATION_LOG_FAILURE', String(changeLogError && changeLogError.message || 'Compensation log write failed.'))); } catch (_auditError) {}
    }
  }
  try {
    const failureResponse = { errorCode: 'TRANSACTION_FAILURE', message: 'Order mutation did not complete.' };
    if (recovery.requestSignature) failureResponse.requestSignature = recovery.requestSignature;
    updateRecordByCompositeKey_('RequestLog', staffRequestKey_(context, action, requestId, recovery.orderId), { Result: 'TRANSACTION_FAILURE', ResponseData: JSON.stringify(failureResponse) });
  } catch (_requestLogError) {}
  try { writeAudit_(orderAuditEntry_(context, requestId, recovery.orderId, action, rollback.succeeded ? 'TRANSACTION_FAILURE' : 'ROLLBACK_FAILED', rollback.detail)); } catch (_auditError) {}
}

function rollbackStaffMutationIfOwned_(recovery) {
  if (!recovery) return { succeeded: false, detail: 'No recovery snapshot was available.' };
  const latest = findOrderHeader_(recovery.orderId);
  if (!latest || Number(latest.Version) !== Number(recovery.versionAfter) || String(latest.LastChangeSetID || '') !== String(recovery.changeSetId || '')) return { succeeded: false, detail: 'Rollback skipped because mutation ownership could not be proven.' };
  updateRecordByKey_('OrderHeaders', 'OrderID', recovery.orderId, recovery.current);
  batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', (recovery.currentItems || []).map(function (item) { return { keyValue: item.OrderItemID, updates: item }; }));
  deleteOwnedStaffNewItemRows_(recovery.orderId, recovery.newItemIds || []);
  restoreCancelledTokensLocked_(recovery);
  return { succeeded: true, detail: 'Owned header and existing items were restored.' };
}

function restoreCancelledTokensLocked_(recovery) {
  const snapshots = recovery.actionTokens || [];
  if (!snapshots.length) return;
  const expectedById = {};
  (recovery.actionTokenExpected || []).forEach(function (row) { expectedById[String(row.TokenID)] = row; });
  const current = readRecords_('ActionTokens', { predicate: function (row) {
    return snapshots.some(function (snapshot) { return String(snapshot.TokenID) === String(row.TokenID); });
  } });
  const currentById = {};
  current.forEach(function (row) { currentById[String(row.TokenID)] = row; });
  snapshots.forEach(function (snapshot) {
    const row = currentById[String(snapshot.TokenID)], expected = expectedById[String(snapshot.TokenID)];
    const original = row && String(row.Status || '') === String(snapshot.Status || '') && String(row.UsedAt || '') === String(snapshot.UsedAt || '') && String(row.UsedBy || '') === String(snapshot.UsedBy || '') && String(row.CancellationRequestID || '') === String(snapshot.CancellationRequestID || '') && String(row.CancellationPreviousStatus || '') === String(snapshot.CancellationPreviousStatus || '');
    const owned = row && expected && String(row.Status || '') === String(expected.Status || '') && String(row.UsedAt || '') === String(expected.UsedAt || '') && String(row.UsedBy || '') === String(expected.UsedBy || '') && String(row.CancellationRequestID || '') === String(expected.CancellationRequestID || '') && String(row.CancellationPreviousStatus || '') === String(expected.CancellationPreviousStatus || '');
    if (!original && !owned) throw new Error('Action token rollback ownership could not be proven.');
    if (original) return;
    const restored = updateRecordByKey_('ActionTokens', 'TokenID', snapshot.TokenID, { Status: snapshot.Status, UsedAt: snapshot.UsedAt, UsedBy: snapshot.UsedBy, CancellationRequestID: snapshot.CancellationRequestID, CancellationPreviousStatus: snapshot.CancellationPreviousStatus });
    if (!restored || String(restored.Status || '') !== String(snapshot.Status || '') || String(restored.UsedAt || '') !== String(snapshot.UsedAt || '') || String(restored.UsedBy || '') !== String(snapshot.UsedBy || '')) throw new Error('Action token rollback failed.');
  });
}

function deleteOwnedStaffNewItemRows_(orderId, itemIds) {
  if (!itemIds.length) return;
  const sheet = getSheetOrThrow_('OrderItems');
  const headers = getHeaderMap_(sheet);
  const idColumn = headers.OrderItemID;
  const orderColumn = headers.OrderID;
  if (!idColumn || !orderColumn) throw new Error('Order item ownership columns are unavailable.');
  const values = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
  const rows = [];
  values.forEach(function (row, index) {
    if (itemIds.indexOf(String(row[idColumn - 1])) >= 0 && String(row[orderColumn - 1]) === String(orderId)) rows.push(index + 2);
  });
  if (rows.length !== itemIds.length) throw new Error('New item ownership could not be proven.');
  rows.sort(function (left, right) { return right - left; }).forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
}

function staffMutationChangeRows_(changes, context, current, versionAfter, changeSetId, requestId, action, reason, result) {
  return changes.map(function (change) {
    return { ChangeSetID: changeSetId, OrderID: String(current.OrderID), OrderItemID: String(change.itemId || ''), ChangedByStaffID: String(context.user.StaffID), ChangedByName: String(context.user.FullName || ''), Department: String(current.Department || ''), ChangedByRole: String(context.user.Role || ''), ActionType: action, FieldName: change.field, FieldLabel: change.field, OldValue: change.oldValue, NewValue: change.newValue, ChangeReason: reason, OrderVersionBefore: Number(current.Version), OrderVersionAfter: versionAfter, RequestID: requestId, Source: 'WEB', Result: result || 'SUCCESS' };
  });
}

/** A reminder scanner must exclude both pending and final cancellations. */
function isReminderEligibleForOrder_(order) {
  const status = String(order && order.Status || '');
  return status !== 'CANCEL_REQUESTED' && status !== 'CANCELLED';
}

function invalidateDashboardCache_(department) {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove('MEDICATION_RESERVATION_DASHBOARD_' + String(department || ''));
    cache.remove(['MEDICATION_RESERVATION', 'DASHBOARD', 'ALL'].join('_'));
  } catch (_ignored) {}
}

function sendStaffMutationEmail_(context, email) {
  if (!email) return;
  const enabled = email.kind === 'CANCEL' ? settingEnabled_('CANCEL_EMAIL_ENABLED', true) : settingEnabled_('UPDATE_EMAIL_ENABLED', true);
  const recipient = String(email.header.RequesterEmail || '').trim();
  const templateName = email.kind === 'CANCEL' ? 'CANCELLATION' : 'ORDER_UPDATE';
  const model = { header: email.header, items: email.items || [], actor: context.user, changeSetId: email.changeSetId, changes: email.changes || [], previousStatus: email.previousStatus, cancelReason: email.reason, changedBy: context.user.FullName || context.user.StaffID, changedAt: email.eventAt || email.header.UpdatedAt, eventAt: email.eventAt, orderVersion: email.orderVersion, changeReason: email.reason };
  if (!enabled) return recordSkippedEmailAttempt_(templateName, model, 'SKIPPED_DISABLED', 'Notification setting is disabled.');
  return sendOrderNotificationSafe_(templateName, model);
}

function maskOrderPatientForEmail_(header) {
  const name = String(header && header.PatientName || '').trim();
  const hn = String(header && header.HN || '');
  const maskedName = name ? name.charAt(0) + '***' : 'Patient';
  return maskedName + ' (HN ***' + hn.slice(-4) + ')';
}

function emailChangeLine_(change) {
  const field = String(change.field || '');
  const oldValue = field === 'PatientName' ? maskPatientValueForEmail_(change.oldValue) : (field === 'HN' ? maskHnValueForEmail_(change.oldValue) : String(change.oldValue == null ? '' : change.oldValue));
  const newValue = field === 'PatientName' ? maskPatientValueForEmail_(change.newValue) : (field === 'HN' ? maskHnValueForEmail_(change.newValue) : String(change.newValue == null ? '' : change.newValue));
  return field + ': ' + oldValue + ' → ' + newValue;
}

function maskPatientValueForEmail_(value) { const text = String(value == null ? '' : value).trim(); return text ? text.charAt(0) + '***' : ''; }
function maskHnValueForEmail_(value) { const text = String(value == null ? '' : value); return text ? '***' + text.slice(-4) : ''; }

function escapeStaffMutationEmailHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]; });
}

function getOrderChangeLog_(context, orderId) {
  const order = findOrderHeader_(orderId);
  if (!order) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireOrderAccess_(context, order);
  return readRecords_('OrderChangeLog', { predicate: function (entry) { return String(entry.OrderID || '') === String(order.OrderID); } });
}

function getAppointmentHistory_(context, orderId) {
  const order = findOrderHeader_(orderId);
  if (!order) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  requireOrderAccess_(context, order);
  return readRecords_('AppointmentResponseLog', { predicate: function (entry) { return String(entry.OrderID || '') === String(order.OrderID); } });
}

function findOrderHeader_(orderId) {
  const records = readRecords_('OrderHeaders', { predicate: function (record) { return String(record.OrderID || '') === String(orderId || ''); }, limit: 1 });
  return records.length ? records[0] : null;
}

function orderSummary_(record) {
  return { OrderID: String(record.OrderID || ''), CreatedAt: record.CreatedAt || '', HN: String(record.HN || ''), PatientName: String(record.PatientName || ''), WardClinic: String(record.WardClinic || ''), RequiredDate: String(record.RequiredDate || ''), Priority: String(record.Priority || ''), Status: String(record.Status || ''), ItemCount: Number(record.ItemCount || 0), Version: Number(record.Version || 0) };
}

function orderDetail_(record) {
  return Object.assign({}, orderSummary_(record), { RequesterPhone: String(record.RequesterPhone || '') });
}

function validateCreateOrderPayload_(payload) {
  const errors = [];
  const masterData = getMasterData_(['DOSAGE_FORM', 'UNIT', 'PRIORITY']);
  validateOrderText_(errors, 'RequesterPhone', payload.RequesterPhone, ORDER_TEXT_LIMITS_.RequesterPhone);
  validateOrderText_(errors, 'PatientName', payload.PatientName, ORDER_TEXT_LIMITS_.PatientName, true);
  validateOrderText_(errors, 'WardClinic', payload.WardClinic, ORDER_TEXT_LIMITS_.WardClinic);
  if (!/^07-\d{2}-\d{6}$/.test(cleanOrderText_(payload.HN))) errors.push({ field: 'HN', message: 'HN must use the format 07-00-000000.' });
  if (!validOrderDate_(payload.RequiredDate)) errors.push({ field: 'RequiredDate', message: 'Required date must be a valid YYYY-MM-DD date.' });
  if (cleanOrderText_(payload.Priority)) validateActiveOrderCode_(errors, 'Priority', payload.Priority, masterData.PRIORITY, 'Priority');
  if (!Array.isArray(payload.Items) || payload.Items.length < 1 || payload.Items.length > MAX_ORDER_ITEM_COUNT_) errors.push({ field: 'Items', message: 'One to 99 medication items are required.' });
  (Array.isArray(payload.Items) ? payload.Items : []).forEach(function (item, index) {
    const prefix = 'Items[' + index + ']';
    if (!item || typeof item !== 'object') { errors.push({ field: prefix, message: 'Medication item is invalid.' }); return; }
    validateOrderText_(errors, prefix + '.GenericName', item.GenericName, ORDER_TEXT_LIMITS_.GenericName, true);
    validateOrderText_(errors, prefix + '.BrandName', item.BrandName, ORDER_TEXT_LIMITS_.BrandName);
    validateOrderText_(errors, prefix + '.Strength', item.Strength, ORDER_TEXT_LIMITS_.Strength);
    validateOrderText_(errors, prefix + '.DosageForm', item.DosageForm, ORDER_TEXT_LIMITS_.DosageForm, true);
    validateOrderText_(errors, prefix + '.Unit', item.Unit, ORDER_TEXT_LIMITS_.Unit, true);
    validateOrderText_(errors, prefix + '.Prescriber', item.Prescriber, ORDER_TEXT_LIMITS_.Prescriber, true);
    validateActiveOrderCode_(errors, prefix + '.DosageForm', item.DosageForm, masterData.DOSAGE_FORM, 'Dosage form');
    validateActiveOrderCode_(errors, prefix + '.Unit', item.Unit, masterData.UNIT, 'Unit');
    const quantity = Number(item.RequestedQuantity);
    if (!isFinite(quantity) || quantity <= 0) errors.push({ field: prefix + '.RequestedQuantity', message: 'Requested quantity must be positive.' });
  });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid order.', errors);
}

function validateOrderText_(errors, field, value, limit, required) {
  if (value == null || (typeof value === 'string' && !value.trim())) { if (required) errors.push({ field: field, message: field + ' is required.' }); return; }
  if (typeof value !== 'string') { errors.push({ field: field, message: field + ' must be a string.' }); return; }
  if (value.length > limit) errors.push({ field: field, message: field + ' must not exceed ' + limit + ' characters.' });
}

function validateActiveOrderCode_(errors, field, value, entries, label) {
  const code = cleanOrderText_(value).toUpperCase();
  const active = (entries || []).some(function (entry) { return String(entry.Code || '').toUpperCase() === code; });
  if (!active) errors.push({ field: field, message: label + ' is unavailable or inactive.' });
}

function cleanOrderText_(value) { return typeof value === 'string' ? value.trim() : ''; }
function positiveInteger_(value, fallback) { const number = Number(value); return isFinite(number) && number > 0 ? Math.floor(number) : fallback; }
function validOrderDate_(value) { const text = cleanOrderText_(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const pieces = text.split('-').map(Number); const date = new Date(Date.UTC(pieces[0], pieces[1] - 1, pieces[2])); return date.getUTCFullYear() === pieces[0] && date.getUTCMonth() === pieces[1] - 1 && date.getUTCDate() === pieces[2]; }
function orderAuditEntry_(context, requestId, orderId, action, result, detail) { return { StaffID: context && context.user ? context.user.StaffID : '', Role: context && context.user ? context.user.Role : '', Department: context && context.user ? context.user.Department : '', Action: action, OrderID: orderId, RequestID: requestId, Result: result, Detail: detail }; }

/**
 * Bundled from backend/ReminderService.gs
 */
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

/**
 * Bundled from backend/ResponseService.gs
 */
/** Consistent, deliberately small API response envelopes. */
function ApiError_(errorCode, safeMessage, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage || 'Request could not be completed.';
  this.errors = errors || null;
}

ApiError_.prototype = Object.create(Error.prototype);
ApiError_.prototype.constructor = ApiError_;

function apiSuccess_(data, requestId, message, metadata) {
  const response = { success: true, message: message || 'OK', data: data == null ? {} : data, requestId: requestId || '' };
  const expiresAt = metadata && typeof metadata.sessionExpiresAt === 'string' ? metadata.sessionExpiresAt : '';
  if (expiresAt && isFinite(new Date(expiresAt).getTime())) response.sessionExpiresAt = expiresAt;
  return response;
}

function apiFailure_(error, requestId) {
  const known = error && error.name === 'ApiError';
  const response = {
    success: false,
    message: known ? error.safeMessage : 'Request could not be completed.',
    errorCode: known ? error.errorCode : 'INTERNAL_ERROR',
    requestId: requestId || '',
  };
  if (known && error.errors && error.errors.length) response.errors = error.errors;
  if (known && Number.isFinite(Number(error.retryAfterSeconds))) {
    response.retryAfterSeconds = Math.max(1, Math.min(86400, Math.ceil(Number(error.retryAfterSeconds))));
  }
  return response;
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Bundled from backend/SchemaService.gs
 */
/**
 * Google Sheets schema ownership.  This service is deliberately additive: it
 * never removes, renames, reorders, or overwrites an existing business column.
 */
const SPREADSHEET_ID_PROPERTY_ = 'SPREADSHEET_ID';
const SCHEMA_CACHE_KEY_ = schemaKey_('MEDICATION_RESERVATION_', 'SCHEMA_READY_V1');
const SCHEMA_CACHE_SECONDS_ = 21600;

const SCHEMA_ = Object.freeze({
  Users: Object.freeze({ headers: Object.freeze(['StaffID', 'FullName', 'Department', 'Email', 'Role', 'PINHash', 'Active', 'CreatedAt', 'UpdatedAt', 'FailedLoginWindowStartedAt', 'FailedLoginCount', 'LoginLockedUntil', 'LastFailedLoginAt']), plainTextColumns: Object.freeze(['StaffID']) }),
  Departments: Object.freeze({ headers: Object.freeze(['DepartmentCode', 'DepartmentName', 'DepartmentEmail', 'CCEmail', 'Active', 'UpdatedAt', 'UpdatedBy']), plainTextColumns: Object.freeze([]) }),
  OrderHeaders: Object.freeze({ headers: Object.freeze(['OrderID', 'ClientRequestID', 'CreatedAt', 'CreatedByStaffID', 'CreatedByName', 'Department', 'RequesterEmail', 'RequesterPhone', 'HN', 'PatientName', 'WardClinic', 'RequiredDate', 'Priority', 'Status', 'ItemCount', 'Version', 'CreatedSource', 'UpdatedAt', 'UpdatedBy', 'LastChangeSetID', 'LastChangeType', 'LastChangeReason', 'LastChangedAt', 'LastChangedBy', 'CancelledAt', 'CancelledBy', 'CancelReason', 'NotificationStatus', 'LastEmailSentAt', 'LastEmailSentBy', 'UpdateNotificationStatus', 'LastUpdateEmailSentAt', 'AppointmentSequence', 'LastAppointmentReminderAt', 'LastAppointmentReminderSequence', 'AppointmentResponseStatus', 'AppointmentRespondedAt', 'AppointmentRespondedBy', 'PatientReceivedAt', 'NoShowReasonCode', 'NoShowReasonDetail', 'NoShowRecordedAt', 'NoShowCount', 'LastRequiredDate', 'LastRescheduledAt', 'LastRescheduledBy', 'LastRescheduleReason', 'CancellationPreviousStatus', 'CancellationRequestID', 'CancellationRequestedAt', 'CancellationRequestedBy', 'CancellationDecision', 'CancellationDecisionAt', 'CancellationDecisionBy', 'CancellationDecisionReason']), plainTextColumns: Object.freeze(['CreatedByStaffID', 'HN']) }),
  OrderItems: Object.freeze({ headers: Object.freeze(['OrderItemID', 'OrderID', 'ItemNo', 'GenericName', 'BrandName', 'Strength', 'DosageForm', 'RequestedQuantity', 'Unit', 'Prescriber', 'ItemStatus', 'ReceivedDate', 'ReceivedQuantity', 'ReceivedUnit', 'AdminNote', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Active', 'CancellationPreviousStatus']), plainTextColumns: Object.freeze([]) }),
  OrderChangeLog: Object.freeze({ headers: Object.freeze(['ChangeLogID', 'ChangeSetID', 'OrderID', 'OrderItemID', 'ChangedAt', 'ChangedByStaffID', 'ChangedByName', 'Department', 'ChangedByRole', 'ActionType', 'FieldName', 'FieldLabel', 'OldValue', 'NewValue', 'ChangeReason', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Source', 'Result']), plainTextColumns: Object.freeze(['ChangedByStaffID']) }),
  EmailLog: Object.freeze({ headers: Object.freeze(['EmailLogID', 'OrderID', 'ChangeSetID', 'EmailType', 'Recipient', 'CC', 'Subject', 'SentAt', 'SentBy', 'Result', 'ErrorMessage', 'RetryCount']), plainTextColumns: Object.freeze([]) }),
  AuditLog: Object.freeze({ headers: Object.freeze(['AuditID', 'Timestamp', 'StaffID', 'Role', 'Department', 'Action', 'OrderID', 'OrderItemID', 'RequestID', 'OldValue', 'NewValue', 'Result', 'Detail']), plainTextColumns: Object.freeze(['StaffID']) }),
  Settings: Object.freeze({ headers: Object.freeze(['Key', 'Value', 'Description', 'UpdatedAt', 'UpdatedBy']), plainTextColumns: Object.freeze([]) }),
  MasterData: Object.freeze({ headers: Object.freeze(['Type', 'Code', 'DisplayName', 'SortOrder', 'Active', 'UpdatedAt']), plainTextColumns: Object.freeze([]) }),
  Sessions: Object.freeze({ headers: Object.freeze(['SessionTokenHash', 'StaffID', 'CreatedAt', 'ExpiresAt', 'LastActiveAt', 'Active']), plainTextColumns: Object.freeze(['StaffID']) }),
  RequestLog: Object.freeze({ headers: Object.freeze(['RequestID', 'Action', 'OrderID', 'StaffID', 'CreatedAt', 'Result', 'ResponseData']), plainTextColumns: Object.freeze(['StaffID']) }),
  AppointmentResponseLog: Object.freeze({ headers: Object.freeze(['ResponseLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ActionType', 'ResponseAt', 'ResponseSource', 'RespondedByStaffID', 'RespondedByName', 'Department', 'ReasonCode', 'ReasonDetail', 'OldRequiredDate', 'NewRequiredDate', 'ActionTokenID', 'ChangeSetID', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Result', 'ErrorMessage']), plainTextColumns: Object.freeze(['RespondedByStaffID']) }),
  AppointmentReminderLog: Object.freeze({ headers: Object.freeze(['ReminderLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ReminderType', 'Recipient', 'CC', 'SentAt', 'Result', 'ErrorMessage', 'ActionTokenGroupID', 'RetryCount']), plainTextColumns: Object.freeze([]) }),
  ActionTokens: Object.freeze({ headers: Object.freeze(['TokenID', 'TokenHash', 'OrderID', 'AppointmentSequence', 'ActionType', 'Department', 'CreatedAt', 'ExpiresAt', 'UsedAt', 'UsedBy', 'Status', 'ReminderLogID', 'RequestID', 'CancellationRequestID', 'CancellationPreviousStatus']), plainTextColumns: Object.freeze([]) }),
});

const DEFAULT_SETTINGS_ = Object.freeze([
  Object.freeze(['ORDER_PREFIX', 'MED', 'Prefix used for generated order IDs']),
  Object.freeze(['SESSION_TIMEOUT_MINUTES', '30', 'Idle session timeout in minutes']),
  Object.freeze(['SESSION_TOUCH_INTERVAL_MINUTES', '2', 'Minimum minutes between durable session activity writes']),
  Object.freeze(['UPDATE_EMAIL_ENABLED', 'TRUE', 'Send update notifications']),
  Object.freeze(['CANCEL_EMAIL_ENABLED', 'TRUE', 'Send cancellation notifications']),
  Object.freeze(['STAFF_CAN_EDIT_ORDERED', 'TRUE', 'Allow staff edits after ordering']),
  Object.freeze(['STAFF_CAN_CANCEL_ORDERED', 'TRUE', 'Allow staff cancellation after ordering']),
  Object.freeze(['DASHBOARD_CACHE_SECONDS', '60', 'Dashboard cache lifetime']),
  Object.freeze(['UPCOMING_REQUIRED_DATE_DAYS', '7', 'Upcoming appointment window']),
  Object.freeze(['TIMEZONE', 'Asia/Bangkok', 'Application display timezone']),
  Object.freeze(['LOGO_URL', '', 'Optional public logo URL']),
  Object.freeze(['ADMIN_NOTIFICATION_EMAIL', '', 'Optional admin notification recipient']),
  Object.freeze(['UPDATE_NOTIFICATION_CC', '', 'Optional update notification CC']),
  Object.freeze(['APPOINTMENT_REMINDER_ENABLED', 'TRUE', 'Enable appointment reminders']),
  Object.freeze(['APPOINTMENT_REMINDER_HOUR', '7', 'Local reminder hour']),
  Object.freeze(['APPOINTMENT_ACTION_TOKEN_HOURS', '168', 'Appointment action token lifetime']),
  Object.freeze([schemaKey_('ALLOW_EMAIL_RECEIVED_ACTION', '_WITHOUT_LOGIN'), 'TRUE', 'Permit received confirmation token flow']),
  Object.freeze([schemaKey_('ALLOW_EMAIL_NO_SHOW_ACTION', '_WITHOUT_LOGIN'), 'TRUE', 'Permit no-show token flow']),
  Object.freeze(['RESCHEDULE_REQUIRES_LOGIN', 'TRUE', 'Require login before rescheduling']),
  Object.freeze(['APPOINTMENT_REMINDER_RETRY_LIMIT', '3', 'Maximum reminder retries']),
  Object.freeze(['DEPARTMENT_EMAIL_REQUIRED', 'TRUE', 'Require a department email']),
  Object.freeze(['PATIENT_RECEIVED_AUTO_COMPLETE', 'TRUE', 'Complete order after patient received']),
  Object.freeze([schemaKey_('CANCELLATION_REQUIRES_ADMIN', '_APPROVAL'), 'FALSE', 'Require admin cancellation approval']),
  Object.freeze(['LOGIN_IDENTITY_FAILURE_LIMIT', '5', 'Failed attempts before a known identity is temporarily locked']),
  Object.freeze(['LOGIN_GLOBAL_FAILURE_LIMIT', '50', 'Failed attempts before global login is temporarily locked']),
  Object.freeze(['LOGIN_FAILURE_WINDOW_MINUTES', '15', 'Rolling failure window for login throttling']),
  Object.freeze(['LOGIN_LOCKOUT_MINUTES', '15', 'Temporary login lockout duration']),
  Object.freeze(['LOGIN_GLOBAL_THROTTLE_STATE', '', 'Runtime global login throttle state; change only through recovery helpers']),
]);

const DEFAULT_MASTER_DATA_ = Object.freeze({
  DOSAGE_FORM: Object.freeze(['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'ORAL_SOLUTION', 'INJECTION', 'CREAM', 'OINTMENT', 'GEL', 'EYE_DROPS', 'EAR_DROPS', 'NASAL_SPRAY', 'INHALER', 'SUPPOSITORY', 'PATCH', 'POWDER', 'GRANULE', 'SOLUTION', 'OTHER']),
  UNIT: Object.freeze(['TABLET', 'CAPSULE', 'BOTTLE', 'VIAL', 'AMPOULE', 'TUBE', 'BOX', 'PACK', 'SACHET', 'PIECE', 'ML', 'G', 'MG', 'DOSE', 'INHALER', 'PATCH', 'SUPPOSITORY', 'OTHER']),
  PRIORITY: Object.freeze(['NORMAL', 'URGENT', 'CRITICAL']),
  CANCEL_REASON: Object.freeze(['PATIENT_CANCELLED', 'TREATMENT_CHANGED', 'MEDICATION_CHANGED', 'TRANSFERRED', 'DUPLICATE_ORDER', 'DECEASED', 'OTHER']),
  NO_SHOW_REASON: Object.freeze(['UNREACHABLE', 'PATIENT_UNAVAILABLE', 'TREATED_ELSEWHERE', 'REFUSED_MEDICATION', 'DECEASED', 'UNKNOWN', 'OTHER']),
});

function schemaKey_(prefix, suffix) {
  return prefix + suffix;
}

function initializeDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = openConfiguredSpreadsheet_();
    Object.keys(SCHEMA_).forEach(function (sheetName) {
      repairSheetSchema_(spreadsheet, sheetName, SCHEMA_[sheetName]);
    });
    seedMissingSettings_(spreadsheet.getSheetByName('Settings'));
    seedMissingMasterData_(spreadsheet.getSheetByName('MasterData'));
    clearConfigurationCaches_();
    CacheService.getScriptCache().put(SCHEMA_CACHE_KEY_, 'ready', SCHEMA_CACHE_SECONDS_);
    return getDatabaseHealthFromSpreadsheet_(spreadsheet);
  } finally {
    lock.releaseLock();
  }
}

function getDatabaseHealth() {
  return getDatabaseHealthFromSpreadsheet_(openConfiguredSpreadsheet_());
}

function scheduledSchemaCheck() {
  return initializeDatabase();
}

function openConfiguredSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY_);
  if (!spreadsheetId) throw new Error('Spreadsheet configuration is missing.');
  return SpreadsheetApp.openById(spreadsheetId);
}

function getHeaderMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  return headers.reduce(function (map, header, index) {
    const name = String(header || '').trim();
    if (name && !Object.prototype.hasOwnProperty.call(map, name)) map[name] = index + 1;
    return map;
  }, {});
}

function repairSheetSchema_(spreadsheet, sheetName, definition) {
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  const headerMap = getHeaderMap_(sheet);
  const missingHeaders = definition.headers.filter(function (header) {
    return !Object.prototype.hasOwnProperty.call(headerMap, header);
  });

  // Append only missing headers so existing order and data remain untouched.
  if (missingHeaders.length) sheet.getRange(1, sheet.getLastColumn() + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  formatSchemaSheet_(sheet, definition);
  return sheet;
}

function formatSchemaSheet_(sheet, definition) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) return;
  sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const headerMap = getHeaderMap_(sheet);
  definition.plainTextColumns.forEach(function (header) {
    const column = headerMap[header];
    if (column) sheet.getRange(1, column, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function seedMissingSettings_(sheet) {
  const existingKeys = getExistingCompositeKeys_(sheet, ['Key']);
  const now = new Date().toISOString();
  const rows = DEFAULT_SETTINGS_.filter(function (setting) {
    return !existingKeys[setting[0]];
  }).map(function (setting) {
    return { Key: setting[0], Value: setting[1], Description: setting[2], UpdatedAt: now, UpdatedBy: 'SCHEMA_INITIALIZER' };
  });
  if (rows.length) appendRecords_('Settings', rows);
}

function seedMissingMasterData_(sheet) {
  const existingKeys = getExistingCompositeKeys_(sheet, ['Type', 'Code']);
  const now = new Date().toISOString();
  const rows = [];
  Object.keys(DEFAULT_MASTER_DATA_).forEach(function (type) {
    DEFAULT_MASTER_DATA_[type].forEach(function (code, index) {
      const key = makeCompositeKey_([type, code]);
      if (!existingKeys[key]) rows.push({ Type: type, Code: code, DisplayName: code, SortOrder: index + 1, Active: 'TRUE', UpdatedAt: now });
    });
  });
  if (rows.length) appendRecords_('MasterData', rows);
}

function getExistingCompositeKeys_(sheet, keyHeaders) {
  const records = readRecords_(sheet.getName());
  return records.reduce(function (keys, record) {
    const values = keyHeaders.map(function (header) { return record[header]; });
    if (values.every(function (value) { return String(value || '') !== ''; })) keys[makeCompositeKey_(values)] = true;
    return keys;
  }, {});
}

function makeCompositeKey_(values) {
  return values.map(function (value) { return String(value); }).join('\u001f');
}

function getDatabaseHealthFromSpreadsheet_(spreadsheet) {
  const missingSheets = [];
  const missingColumns = {};
  Object.keys(SCHEMA_).forEach(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      missingSheets.push(sheetName);
      return;
    }
    const headerMap = getHeaderMap_(sheet);
    const missing = SCHEMA_[sheetName].headers.filter(function (header) { return !headerMap[header]; });
    if (missing.length) missingColumns[sheetName] = missing;
  });
  return { healthy: !missingSheets.length && !Object.keys(missingColumns).length, missingSheets: missingSheets, missingColumns: missingColumns };
}

/**
 * Bundled from backend/SecurityService.gs
 */
/** Apps Script cryptographic adapters. Stored PIN values use bounded-work salted HMAC records. */
const PIN_HASH_PREFIX_ = 'HMAC-SHA256$v2$';
const PIN_HASH_BYTES_ = 32;
const PIN_SALT_BYTES_ = 16;

function sha256Hex_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return bytesToHex_(digest);
}

function bytesToHex_(bytes) {
  return bytes.map(function (value) {
    const unsigned = value < 0 ? value + 256 : value;
    return (unsigned < 16 ? '0' : '') + unsigned.toString(16);
  }).join('');
}

function randomBytes_(length) {
  let hex = '';
  while (hex.length < length * 2) hex += Utilities.getUuid().replace(/-/g, '');
  const bytes = [];
  for (let index = 0; index < length * 2; index += 2) bytes.push(parseInt(hex.substr(index, 2), 16));
  return bytes;
}

function generateRandomToken_() {
  return Utilities.base64EncodeWebSafe(randomBytes_(48)).replace(/=+$/, '');
}

function pinPepperBytes_() {
  const encoded = String(PropertiesService.getScriptProperties().getProperty('APP_SECRET') || '').trim();
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded)) throw new Error('APP_SECRET is not configured correctly.');
  const bytes = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(encoded));
  if (bytes.length !== PIN_HASH_BYTES_) throw new Error('APP_SECRET is not configured correctly.');
  return bytes;
}

function computePinMac_(pin, salt) {
  const domain = Array.prototype.slice.call(Utilities.newBlob('MEDICATION_RESERVATION_PIN_V2\u0000').getBytes());
  const pinBytes = Array.prototype.slice.call(Utilities.newBlob(String(pin)).getBytes());
  return Array.prototype.slice.call(Utilities.computeHmacSha256Signature(domain.concat(salt, pinBytes), pinPepperBytes_()));
}

function base64WebSafeNoPadding_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function createPinHash_(pin) {
  assertProvisionedPinPolicy_(pin);
  const salt = randomBytes_(PIN_SALT_BYTES_);
  const mac = computePinMac_(pin, salt);
  return PIN_HASH_PREFIX_ + base64WebSafeNoPadding_(salt) + '$' + base64WebSafeNoPadding_(mac);
}

function assertProvisionedPinPolicy_(pin) {
  if (typeof pin !== 'string' || pin.length < 8 || pin.length > 128) throw new Error('PIN must contain 8 to 128 characters.');
}

function verifyPinHash_(pin, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.indexOf(PIN_HASH_PREFIX_) !== 0) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'HMAC-SHA256' || parts[1] !== 'v2') return false;
  try {
    const salt = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[2]));
    const expected = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[3]));
    if (salt.length !== PIN_SALT_BYTES_ || expected.length !== PIN_HASH_BYTES_) return false;
    if (!isCanonicalWebSafeBase64_(parts[2], salt) || !isCanonicalWebSafeBase64_(parts[3], expected)) return false;
    const actual = computePinMac_(pin, salt);
    return constantTimeEqual_(actual, expected);
  } catch (_ignored) {
    return false;
  }
}

function isCanonicalWebSafeBase64_(encoded, bytes) {
  return base64WebSafeNoPadding_(bytes) === encoded;
}

function constantTimeEqual_(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] & 255) ^ (right[index] & 255);
  return difference === 0;
}

/**
 * Bundled from backend/SessionService.gs
 */
function createSession_(staffId) {
  const rawToken = generateRandomToken_();
  const now = new Date();
  const timeoutMinutes = Math.max(1, Number(getSetting_('SESSION_TIMEOUT_MINUTES', '30')) || 30);
  const touchIntervalMinutes = sessionTouchIntervalMinutes_();
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000).toISOString();
  const durableExpiresAt = new Date(now.getTime() + (timeoutMinutes + touchIntervalMinutes) * 60 * 1000).toISOString();
  appendRecords_('Sessions', [{
    SessionTokenHash: sha256Hex_(rawToken),
    StaffID: String(staffId),
    CreatedAt: now.toISOString(),
    ExpiresAt: durableExpiresAt,
    LastActiveAt: now.toISOString(),
    Active: 'TRUE',
  }]);
  return { rawToken: rawToken, expiresAt: expiresAt };
}

function requireSession_(token, options) {
  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!rawToken) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  const tokenHash = sha256Hex_(rawToken);
  const sessions = readRecords_('Sessions', { predicate: function (session) { return String(session.SessionTokenHash || '') === tokenHash; }, limit: 1 });
  const session = sessions.length ? sessions[0] : null;
  const now = new Date();
  const timeoutMinutes = Math.max(1, Number(getSetting_('SESSION_TIMEOUT_MINUTES', '30')) || 30);
  const touchIntervalMinutes = sessionTouchIntervalMinutes_();
  const lastActiveAt = session ? new Date(session.LastActiveAt) : new Date(0);
  const expiresAt = session ? new Date(session.ExpiresAt) : new Date(0);
  const expired = !session || String(session.Active || '').toUpperCase() !== 'TRUE' || !isFinite(expiresAt.getTime()) || !isFinite(lastActiveAt.getTime()) || expiresAt <= now || now.getTime() - lastActiveAt.getTime() > (timeoutMinutes + touchIntervalMinutes) * 60 * 1000;
  if (expired) {
    if (session && String(session.Active || '').toUpperCase() === 'TRUE') updateRecordByKey_('Sessions', 'SessionTokenHash', tokenHash, { Active: 'FALSE' });
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }
  const user = findUserByStaffId_(session.StaffID);
  if (!userIsActive_(user)) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  const touchRequested = !options || options.touch !== false;
  let activityAccepted = touchRequested && now.getTime() - lastActiveAt.getTime() < touchIntervalMinutes * 60 * 1000;
  let effectiveLastActiveAt = lastActiveAt;
  let effectiveDurableExpiresAt = expiresAt;
  const shouldTouch = touchRequested && !activityAccepted;
  if (shouldTouch) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const currentRows = readRecords_('Sessions', { predicate: function (current) {
        return String(current.SessionTokenHash || '') === tokenHash;
      }, limit: 1 });
      const current = currentRows.length ? currentRows[0] : null;
      const currentLastActiveAt = current ? new Date(current.LastActiveAt) : new Date(0);
      const currentExpiresAt = current ? new Date(current.ExpiresAt) : new Date(0);
      if (!current || String(current.Active || '').toUpperCase() !== 'TRUE'
        || !isFinite(currentLastActiveAt.getTime()) || !isFinite(currentExpiresAt.getTime())
        || currentExpiresAt <= now
        || now.getTime() - currentLastActiveAt.getTime() > (timeoutMinutes + touchIntervalMinutes) * 60 * 1000) {
        throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
      }
      effectiveLastActiveAt = currentLastActiveAt;
      effectiveDurableExpiresAt = currentExpiresAt;
      if (now.getTime() - currentLastActiveAt.getTime() < touchIntervalMinutes * 60 * 1000) {
        activityAccepted = true;
      } else {
        const nextDurableExpiresAt = new Date(now.getTime() + (timeoutMinutes + touchIntervalMinutes) * 60 * 1000);
        const updated = updateRecordByKey_('Sessions', 'SessionTokenHash', tokenHash, {
          LastActiveAt: now.toISOString(),
          ExpiresAt: nextDurableExpiresAt.toISOString(),
        });
        if (updated) {
          activityAccepted = true;
          effectiveLastActiveAt = now;
          effectiveDurableExpiresAt = nextDurableExpiresAt;
        }
      }
    } finally {
      lock.releaseLock();
    }
  }
  const calculatedClientExpiresAt = activityAccepted
    ? new Date(now.getTime() + timeoutMinutes * 60 * 1000)
    : new Date(effectiveLastActiveAt.getTime() + timeoutMinutes * 60 * 1000);
  const clientExpiresAt = new Date(Math.min(calculatedClientExpiresAt.getTime(), effectiveDurableExpiresAt.getTime()));
  return {
    sessionTokenHash: tokenHash, session: session, user: trustedIdentity_(user),
    expiresAt: clientExpiresAt.toISOString(),
  };
}

function sessionTouchIntervalMinutes_() {
  const configured = Number(getSetting_('SESSION_TOUCH_INTERVAL_MINUTES', '2'));
  return Number.isFinite(configured) && configured >= 1 && configured <= 10 ? Math.floor(configured) : 2;
}

function logout_(context) {
  if (context && context.sessionTokenHash) updateRecordByKey_('Sessions', 'SessionTokenHash', context.sessionTokenHash, { Active: 'FALSE' });
  return { loggedOut: true };
}

/**
 * Bundled from backend/SetupConfigurationService.gs
 */
/** Pure setup-time Script Property validation. Never include supplied values in errors. */
const SETUP_PROPERTY_NAMES_ = Object.freeze(['SPREADSHEET_ID', 'FRONTEND_BASE_URL', 'APP_SECRET', 'TOKEN_SIGNING_SECRET', 'DEPLOYMENT_ENV']);
const SETUP_ENVIRONMENTS_ = Object.freeze(['development', 'test', 'staging', 'production']);
const GOOGLE_SHEET_ID_PATTERN_ = /^[A-Za-z0-9_-]{20,}$/;
const RANDOM_SECRET_PATTERN_ = /^[A-Za-z0-9_-]{43}=?$/;
const HTTPS_BASE_URL_PATTERN_ = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)?\/?$/i;

function validateSetupConfiguration_(properties) {
  const values = properties && typeof properties === 'object' ? properties : {};
  const errors = [];
  const spreadsheetId = setupPropertyValue_(values, 'SPREADSHEET_ID');
  const frontendBaseUrl = setupPropertyValue_(values, 'FRONTEND_BASE_URL');
  const appSecret = setupPropertyValue_(values, 'APP_SECRET');
  const tokenSigningSecret = setupPropertyValue_(values, 'TOKEN_SIGNING_SECRET');
  const deploymentEnv = setupPropertyValue_(values, 'DEPLOYMENT_ENV');
  const normalizedFrontendBaseUrl = normalizeFrontendBaseUrl_(frontendBaseUrl);

  if (!GOOGLE_SHEET_ID_PATTERN_.test(spreadsheetId)) setupConfigurationError_(errors, 'SPREADSHEET_ID', 'INVALID_SPREADSHEET_ID', 'Use the canonical Google Sheet ID format.');
  if (!normalizedFrontendBaseUrl) setupConfigurationError_(errors, 'FRONTEND_BASE_URL', 'INVALID_FRONTEND_BASE_URL', 'Use a canonical HTTPS base URL without credentials, query, fragment, or whitespace.');
  const appSecretValid = RANDOM_SECRET_PATTERN_.test(appSecret);
  const tokenSigningSecretValid = RANDOM_SECRET_PATTERN_.test(tokenSigningSecret);
  if (!appSecretValid) setupConfigurationError_(errors, 'APP_SECRET', 'INVALID_APP_SECRET', 'Use a distinct 32-byte random Base64URL value.');
  if (!tokenSigningSecretValid) setupConfigurationError_(errors, 'TOKEN_SIGNING_SECRET', 'INVALID_TOKEN_SIGNING_SECRET', 'Use a distinct 32-byte random Base64URL value.');
  if (appSecretValid && tokenSigningSecretValid && canonicalSetupSecret_(appSecret) === canonicalSetupSecret_(tokenSigningSecret)) {
    setupConfigurationError_(errors, 'APP_SECRET', 'SECRETS_MUST_DIFFER', 'Use a distinct 32-byte random Base64URL value.');
    setupConfigurationError_(errors, 'TOKEN_SIGNING_SECRET', 'SECRETS_MUST_DIFFER', 'Use a distinct 32-byte random Base64URL value.');
  }
  if (SETUP_ENVIRONMENTS_.indexOf(deploymentEnv) === -1) setupConfigurationError_(errors, 'DEPLOYMENT_ENV', 'INVALID_DEPLOYMENT_ENV', 'Use one of: development, test, staging, production.');

  return {
    valid: errors.length === 0,
    errors: errors,
    normalized: { FRONTEND_BASE_URL: normalizedFrontendBaseUrl || '' },
  };
}

function setupPropertyValue_(properties, name) {
  const value = properties[name];
  return typeof value === 'string' ? value : '';
}

function normalizeFrontendBaseUrl_(value) {
  if (!value || value !== value.trim()) return '';
  const match = HTTPS_BASE_URL_PATTERN_.exec(value);
  if (!match) return '';
  const host = String(match[1]).toLowerCase();
  const path = String(match[2] || '').replace(/\/+$/, '');
  return 'https://' + host + path;
}

function canonicalSetupSecret_(value) {
  return value.charAt(value.length - 1) === '=' ? value.slice(0, -1) : value;
}

function setupConfigurationError_(errors, field, code, message) {
  errors.push({ field: field, code: code, message: message });
}

/**
 * Bundled from backend/SheetRepository.gs
 */
/** Header-based repository helpers. All data access uses whole ranges. */
function getSheetOrThrow_(sheetName) {
  const sheet = openConfiguredSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Unknown sheet: ' + sheetName);
  return sheet;
}

function readRecords_(sheetName, options) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const headerNames = Object.keys(headers);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || !lastColumn) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const requestedFields = options && options.fields ? options.fields : headerNames;
  const records = values.map(function (row) {
    const record = {};
    requestedFields.forEach(function (field) {
      const column = headers[field];
      if (column) record[field] = row[column - 1];
    });
    return record;
  });
  const filtered = options && typeof options.predicate === 'function' ? records.filter(options.predicate) : records;
  const hasLimit = options && Object.prototype.hasOwnProperty.call(options, 'limit');
  const limit = hasLimit ? Math.max(0, options.limit) : filtered.length;
  return filtered.slice(0, limit);
}

function appendRecords_(sheetName, records) {
  if (!records || !records.length) return { startRow: null, rowCount: 0 };
  const sheet = getSheetOrThrow_(sheetName);
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  if (!headers.length) throw new Error('Sheet has no headers: ' + sheetName);
  const rows = records.map(function (record) {
    return headers.map(function (header) { return toSafeSheetValue_(record[String(header || '').trim()]); });
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  return { startRow: startRow, rowCount: rows.length };
}

function updateRecordByKey_(sheetName, keyName, keyValue, updates) {
  const sheet = getSheetOrThrow_(sheetName);
  const headerMap = getHeaderMap_(sheet);
  const keyColumn = headerMap[keyName];
  if (!keyColumn) throw new Error('Unknown key column: ' + keyName);
  const unknownFields = Object.keys(updates || {}).filter(function (field) { return !headerMap[field]; });
  if (unknownFields.length) throw new Error('Unknown update columns: ' + unknownFields.join(', '));
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const keyValues = sheet.getRange(2, keyColumn, lastRow - 1, 1).getDisplayValues();
  const matchIndex = keyValues.findIndex(function (row) { return row[0] === String(keyValue); });
  if (matchIndex < 0) return null;
  const rowNumber = matchIndex + 2;
  const updateEntries = Object.keys(updates || {}).map(function (field) {
    return { column: headerMap[field], value: toSafeSheetValue_(updates[field]) };
  }).sort(function (left, right) {
    return left.column - right.column;
  });
  writeContiguousUpdateRanges_(sheet, rowNumber, updateEntries);
  return readRecordAtRow_(sheet, rowNumber, headerMap);
}

function updateRecordByCompositeKey_(sheetName, keyValues, updates) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const keys = keyValues && typeof keyValues === 'object' ? Object.keys(keyValues) : [];
  if (!keys.length || keys.some(function (key) { return !headers[key]; })) throw new Error('Unknown composite key column.');
  const rows = readRecords_(sheetName);
  const matches = rows.map(function (row, index) { return { row: row, rowNumber: index + 2 }; }).filter(function (entry) {
    return keys.every(function (key) { return String(entry.row[key] || '') === String(keyValues[key] || ''); });
  });
  if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
  const unknown = Object.keys(updates || {}).filter(function (field) { return !headers[field]; });
  if (unknown.length) throw new Error('Unknown update columns: ' + unknown.join(', '));
  const entries = Object.keys(updates || {}).map(function (field) { return { column: headers[field], value: toSafeSheetValue_(updates[field]) }; }).sort(function (a, b) { return a.column - b.column; });
  writeContiguousUpdateRanges_(sheet, matches[0].rowNumber, entries);
  return readRecordAtRow_(sheet, matches[0].rowNumber, headers);
}

function batchUpdateRecordsByKeys_(sheetName, keyName, records) {
  const updates = Array.isArray(records) ? records : [];
  if (!updates.length) return [];
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const keyColumn = headers[keyName];
  if (!keyColumn) throw new Error('Unknown key column: ' + keyName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Batch update keys were not found.');
  const keyRows = sheet.getRange(2, keyColumn, lastRow - 1, 1).getDisplayValues();
  const rowByKey = {};
  keyRows.forEach(function (row, index) { const key = String(row[0]); if (key) rowByKey[key] = index + 2; });
  const rowNumbers = updates.map(function (entry) {
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'keyValue')) throw new Error('Batch update requires keyValue.');
    const row = rowByKey[String(entry.keyValue)];
    if (!row) throw new Error('Batch update key was not found.');
    const unknown = Object.keys(entry.updates || {}).filter(function (field) { return !headers[field]; });
    if (unknown.length) throw new Error('Unknown update columns: ' + unknown.join(', '));
    return row;
  });
  if (new Set(rowNumbers).size !== rowNumbers.length) throw new Error('Batch update keys must be unique.');
  const columns = updates.reduce(function (all, entry) { return all.concat(Object.keys(entry.updates || {}).map(function (field) { return headers[field]; })); }, []);
  const firstRow = Math.min.apply(null, rowNumbers), lastTargetRow = Math.max.apply(null, rowNumbers);
  const firstColumn = Math.min.apply(null, columns), lastColumn = Math.max.apply(null, columns);
  const range = sheet.getRange(firstRow, firstColumn, lastTargetRow - firstRow + 1, lastColumn - firstColumn + 1);
  const values = range.getValues();
  const formulas = range.getFormulas();
  formulas.forEach(function (row, rowIndex) { row.forEach(function (formula, columnIndex) { if (formula) values[rowIndex][columnIndex] = formula; }); });
  updates.forEach(function (entry, index) {
    const rowOffset = rowNumbers[index] - firstRow;
    Object.keys(entry.updates || {}).forEach(function (field) { values[rowOffset][headers[field] - firstColumn] = toSafeSheetValue_(entry.updates[field]); });
  });
  range.setValues(values);
  return rowNumbers.map(function (rowNumber) { return readRecordAtRow_(sheet, rowNumber, headers); });
}

function writeContiguousUpdateRanges_(sheet, rowNumber, entries) {
  let group = [];
  entries.forEach(function (entry) {
    if (group.length && entry.column !== group[group.length - 1].column + 1) {
      writeUpdateRange_(sheet, rowNumber, group);
      group = [];
    }
    group.push(entry);
  });
  if (group.length) writeUpdateRange_(sheet, rowNumber, group);
}

function writeUpdateRange_(sheet, rowNumber, entries) {
  const firstColumn = entries[0].column;
  sheet.getRange(rowNumber, firstColumn, 1, entries.length).setValues([entries.map(function (entry) { return entry.value; })]);
}

function readRecordAtRow_(sheet, rowNumber, headerMap) {
  const lastColumn = sheet.getLastColumn();
  const row = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
  return recordFromRow_(row, headerMap);
}

function recordFromRow_(row, headerMap) {
  return Object.keys(headerMap).reduce(function (record, header) {
    record[header] = row[headerMap[header] - 1];
    return record;
  }, {});
}

function toSafeSheetValue_(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : null;
  return text && /^[=+\-@]/.test(text) ? "'" + text : value;
}

/**
 * Bundled from backend/Tests.gs
 */
/**
 * Manual Apps Script integration checks. Run runSchemaTests from the editor.
 * It uses a disposable spreadsheet and restores the configured ID afterwards.
 */
function runSchemaTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Schema Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);

    assertSchemaTest_(!sandbox.getSheetByName('Users'), 'test fixture must begin without Users');
    initializeDatabase();
    assertSchemaTest_(sandbox.getSheetByName('Users'), 'missing sheet was not created');

    const users = sandbox.getSheetByName('Users');
    const userHeaders = getHeaderMap_(users);
    users.getRange(2, userHeaders.StaffID, 1, 1).setValue('00123');
    users.getRange(2, userHeaders.FullName, 1, 1).setValue('sentinel row');
    users.deleteColumn(userHeaders.UpdatedAt);
    assertSchemaTest_(!getHeaderMap_(users).UpdatedAt, 'fixture did not remove a required column');
    initializeDatabase();

    const repairedUsers = sandbox.getSheetByName('Users');
    const repairedHeaders = getHeaderMap_(repairedUsers);
    assertSchemaTest_(repairedHeaders.UpdatedAt, 'missing column was not appended');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getDisplayValue() === '00123', 'sentinel StaffID was overwritten');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.FullName, 1, 1).getDisplayValue() === 'sentinel row', 'sentinel row was overwritten');

    const columnsBeforeRepeat = repairedUsers.getLastColumn();
    const settingsRowsBeforeRepeat = sandbox.getSheetByName('Settings').getLastRow() - 1;
    const masterDataRowsBeforeRepeat = sandbox.getSheetByName('MasterData').getLastRow() - 1;
    initializeDatabase();
    assertSchemaTest_(repairedUsers.getLastColumn() === columnsBeforeRepeat, 'repeated initialization appended columns');
    assertSchemaTest_(sandbox.getSheetByName('Settings').getLastRow() - 1 === settingsRowsBeforeRepeat, 'repeated initialization duplicated Settings keys');
    assertSchemaTest_(sandbox.getSheetByName('MasterData').getLastRow() - 1 === masterDataRowsBeforeRepeat, 'repeated initialization duplicated MasterData Type+Code pairs');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getNumberFormat() === '@', 'StaffID is not plain text');
    assertSchemaTest_(readRecords_('Users', { limit: 0 }).length === 0, 'limit: 0 must return zero records');
    const orderHeaders = getHeaderMap_(sandbox.getSheetByName('OrderHeaders'));
    assertSchemaTest_(sandbox.getSheetByName('OrderHeaders').getRange(2, orderHeaders.HN, 1, 1).getNumberFormat() === '@', 'HN is not plain text');

    const customColumn = repairedUsers.getLastColumn() + 1;
    repairedUsers.getRange(1, customColumn, 1, 1).setValue('Custom Formula');
    const customFormulaCell = repairedUsers.getRange(2, customColumn, 1, 1);
    const staffIdA1 = repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getA1Notation();
    customFormulaCell.setFormula('=' + staffIdA1 + '&"-custom"');
    const formulaBeforeUpdate = customFormulaCell.getFormula();
    updateRecordByKey_('Users', 'StaffID', '00123', { FullName: 'updated sentinel' });
    assertSchemaTest_(customFormulaCell.getFormula() === formulaBeforeUpdate, 'custom column formula was overwritten during mapped update');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.FullName, 1, 1).getDisplayValue() === 'updated sentinel', 'mapped column update did not persist');
    return { passed: true, message: 'Schema tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

function assertSchemaTest_(condition, message) {
  if (!condition) throw new Error('Schema test failed: ' + message);
}

/**
 * Manual Apps Script identity integration checks. Run runAuthTests from the
 * editor; it creates a disposable spreadsheet and never uses a real user.
 */
function runAuthTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Auth Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();

    const pinHash = createPinHash_('24682468');
    appendRecords_('Users', [
      { StaffID: '00123', FullName: 'Test Staff', Department: 'ER', Email: 'staff@example.invalid', Role: 'STAFF', PINHash: pinHash, Active: 'TRUE', CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() },
      { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Email: 'other@example.invalid', Role: 'STAFF', PINHash: pinHash, Active: 'TRUE', CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() },
    ]);

    const loggedIn = login_({ staffId: '00123', pin: '24682468' }, 'auth-leading-zero');
    assertSchemaTest_(loggedIn.user.StaffID === '00123', 'leading-zero StaffID was not preserved');
    assertSchemaTest_(!Object.prototype.hasOwnProperty.call(loggedIn.user, 'PINHash'), 'login leaked PINHash');
    const repeatedLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-repeat');
    assertSchemaTest_(repeatedLogin.sessionToken !== loggedIn.sessionToken, 'repeated login reused a raw session token');
    assertSchemaTest_(requireSession_(loggedIn.sessionToken).user.StaffID === '00123', 'repeated login invalidated an existing session');
    assertSchemaTest_(requireSession_(repeatedLogin.sessionToken).user.StaffID === '00123', 'repeated login did not create an independently usable session');
    assertAuthThrows_(function () { login_({ staffId: '00123', pin: 'wrong' }, 'auth-bad-pin'); }, 'INVALID_CREDENTIALS', 'bad PIN was accepted');

    updateRecordByKey_('Users', 'StaffID', '00123', { Active: 'FALSE' });
    assertAuthThrows_(function () { login_({ staffId: '00123', pin: '24682468' }, 'auth-inactive'); }, 'INVALID_CREDENTIALS', 'inactive user was accepted');
    updateRecordByKey_('Users', 'StaffID', '00123', { Active: 'TRUE' });

    const expiredLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-expired');
    updateRecordByKey_('Sessions', 'SessionTokenHash', sha256Hex_(expiredLogin.sessionToken), { ExpiresAt: new Date(0).toISOString() });
    assertAuthThrows_(function () { requireSession_(expiredLogin.sessionToken); }, 'SESSION_EXPIRED', 'expired session was accepted');

    const activeLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-logout');
    const context = requireSession_(activeLogin.sessionToken);
    logout_(context);
    assertAuthThrows_(function () { requireSession_(activeLogin.sessionToken); }, 'SESSION_EXPIRED', 'logged-out session was accepted');

    const roleTamperLogin = login_({ staffId: '00123', pin: '24682468', role: 'ADMIN' }, 'auth-role-tamper');
    const trustedContext = requireSession_(roleTamperLogin.sessionToken);
    assertAuthThrows_(function () { requireRole_(trustedContext, ['ADMIN']); }, 'ACCESS_DENIED', 'client role tampering changed authorization');
    assertAuthThrows_(function () { requireOrderAccess_(trustedContext, { Department: 'ICU' }); }, 'ACCESS_DENIED', 'foreign department access was allowed');
    return { passed: true, message: 'Authentication tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

function assertAuthThrows_(operation, errorCode, message) {
  try {
    operation();
  } catch (error) {
    if (error && error.errorCode === errorCode) return;
    throw new Error('Authentication test failed: ' + message + ' (unexpected error)');
  }
  throw new Error('Authentication test failed: ' + message);
}

/**
 * Manual scanner-safety and replay checks against a disposable spreadsheet.
 * The blank managed recipient deliberately makes email delivery fail safely.
 */
function runAppointmentTests() {
  const properties = PropertiesService.getScriptProperties();
  const frontendProperty = ['FRONTEND', 'BASE', 'URL'].join('_');
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const originalFrontendBaseUrl = properties.getProperty(frontendProperty);
  const sandbox = SpreadsheetApp.create('Medication Reservation Appointment Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    properties.setProperty(frontendProperty, 'https://example.invalid/medication');
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const now = new Date();
    const appointmentDate = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
    const order = {
      OrderID: 'MED-APPOINTMENT-TEST', CreatedAt: now.toISOString(), Department: 'ER', RequesterEmail: '', HN: '07-01-000001',
      PatientName: 'Scanner Test', RequiredDate: appointmentDate, Status: 'NOTIFIED', ItemCount: 1, Version: 1,
      AppointmentSequence: 1, NoShowCount: 0,
    };
    appendRecords_('OrderHeaders', [order]);
    appendRecords_('OrderItems', [{ OrderItemID: 'MED-APPOINTMENT-TEST-01', OrderID: order.OrderID, ItemNo: 1, GenericName: 'Test medicine', RequestedQuantity: 1, Unit: 'CAPSULE', ItemStatus: 'RECEIVED', Active: 'TRUE' }]);
    const group = createAppointmentActionTokenGroup_(order, 'APRM-MANUAL', 'ATG-MANUAL', now);
    const tokenMatch = /[?&]token=([^&]+)/.exec(group.actionLinks.received);
    assertSchemaTest_(tokenMatch && tokenMatch[1], 'received action link did not contain an opaque token');
    const token = decodeURIComponent(tokenMatch[1]);
    const sheets = ['OrderHeaders', 'OrderItems', 'ActionTokens', 'AppointmentResponseLog', 'OrderChangeLog', 'AuditLog', 'RequestLog'];
    const beforeGet = JSON.stringify(sheets.reduce(function (result, name) { result[name] = readRecords_(name); return result; }, {}));
    getAppointmentAction_(token);
    getAppointmentAction_(token);
    const afterGet = JSON.stringify(sheets.reduce(function (result, name) { result[name] = readRecords_(name); return result; }, {}));
    assertSchemaTest_(beforeGet === afterGet, 'repeated appointment GET changed a business sheet');
    const first = confirmPatientReceived_({ token: token }, 'appointment-confirm');
    const replay = confirmPatientReceived_({ token: token }, 'appointment-confirm');
    assertSchemaTest_(first.Status === 'COMPLETED', 'received confirmation did not apply completion policy');
    assertSchemaTest_(replay.replayed === true, 'same request did not return its stored idempotent result');
    assertAuthThrows_(function () { confirmPatientReceived_({ token: token }, 'appointment-token-replay'); }, 'TOKEN_REPLAY', 'used appointment token was accepted again');
    return { passed: true, message: 'Appointment tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    if (originalFrontendBaseUrl === null) properties.deleteProperty(frontendProperty);
    else properties.setProperty(frontendProperty, originalFrontendBaseUrl);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script mutation integration checks against a disposable Sheet.
 */
function runOrderUpdateTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Update Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const context = { user: { StaffID: '00123', FullName: 'Update Tester', Department: 'ER', Email: '', Role: 'STAFF' } };
    const created = createOrder_(context, {
      HN: '07-01-000001', PatientName: 'Ada Lovelace', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [{ GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' }],
    }, 'update-create');
    const existing = getOrderItems_(created.OrderID)[0];
    const update = updateOrderByStaff_(context, {
      OrderID: created.OrderID, expectedVersion: 1, PatientName: 'Grace Hopper',
      Items: [{ OrderItemID: existing.OrderItemID, GenericName: existing.GenericName, BrandName: existing.BrandName, Strength: existing.Strength, DosageForm: existing.DosageForm, RequestedQuantity: 3, Unit: existing.Unit, Prescriber: existing.Prescriber }],
    }, 'update-order');
    assertSchemaTest_(update.Version === 2, 'staff update did not increment Version exactly once');
    assertSchemaTest_(getOrderChangeLog_(context, created.OrderID).length === 2, 'staff update did not write one change row per changed field');
    assertAuthThrows_(function () {
      updateOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 1, PatientName: 'Stale', Items: [existing] }, 'update-stale');
    }, 'ORDER_VERSION_CONFLICT', 'stale update overwrote a newer version');
    assertAuthThrows_(function () {
      updateOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 2, Items: [] }, 'update-remove-item');
    }, 'VALIDATION_ERROR', 'submitted item deletion was accepted');
    const cancelled = cancelOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 2, ReasonCode: 'OTHER', ReasonDetail: 'Clinical change' }, 'cancel-order');
    assertSchemaTest_(cancelled.Status === 'CANCELLED', 'direct cancellation policy was not applied');
    assertSchemaTest_(getOrderItems_(created.OrderID).length === 1, 'cancellation deleted an item row');
    assertSchemaTest_(!isReminderEligibleForOrder_(findOrderHeader_(created.OrderID)), 'cancelled order remained reminder eligible');
    return { passed: true, message: 'Order update tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script order integration checks. Run runOrderTests from the
 * editor; it uses a disposable spreadsheet and uses a blank requester email
 * so the confirmation path is logged as failed without sending mail.
 */
function runOrderTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Order Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const context = { user: { StaffID: '00123', FullName: 'Test Staff', Department: 'ER', Email: '', Role: 'STAFF' } };
    const payload = {
      HN: '07-01-000001', PatientName: 'Ada Lovelace', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [
        { GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' },
        { GenericName: 'Paracetamol', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 4, Unit: 'TABLET', Prescriber: 'Dr Test' },
      ],
    };
    const first = createOrder_(context, payload, 'order-idempotent');
    const second = createOrder_(context, payload, 'order-idempotent');
    assertSchemaTest_(first.OrderID === second.OrderID, 'sequential duplicate did not return the same OrderID');
    assertSchemaTest_(getOrderItems_(first.OrderID).length === 2, 'multi-item order was not written');
    const list = listDepartmentOrders_(context, { pageSize: 999 });
    assertSchemaTest_(list.pageSize === 100 && !Object.prototype.hasOwnProperty.call(list.orders[0], 'items'), 'list response includes lazy items or ignores the page cap');
    const foreignContext = { user: { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Role: 'STAFF' } };
    assertAuthThrows_(function () { getOrderDetail_(foreignContext, first.OrderID); }, 'ACCESS_DENIED', 'foreign department probe was allowed');
    return { passed: true, message: 'Order tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script email/receiving checks.  A blank requester address is a
 * deliberate delivery double: MailApp fails, EmailLog records FAILED, and the
 * already-committed receiving quantities and status remain intact.
 */
function runEmailTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Email Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const staff = { user: { StaffID: '00123', FullName: 'Email Staff', Department: 'ER', Email: '', Role: 'STAFF' } };
    const admin = { user: { StaffID: '00999', FullName: 'Email Admin', Department: 'ER', Email: '', Role: 'ADMIN' } };
    const created = createOrder_(staff, {
      HN: '07-01-000001', PatientName: '<Ada Lovelace>', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [{ GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' }],
    }, 'email-create');
    const item = getOrderItems_(created.OrderID)[0];
    const received = updateReceivedItems_(admin, {
      OrderID: created.OrderID, expectedVersion: 1,
      Items: [{ OrderItemID: item.OrderItemID, ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'CAPSULE', AdminNote: '' }],
    }, 'email-receive');
    assertSchemaTest_(received.Status === 'RECEIVED', 'receiving did not derive RECEIVED status');
    assertSchemaTest_(Number(getOrderItems_(created.OrderID)[0].ReceivedQuantity) === 2, 'receiving quantity was not committed');
    const log = readRecords_('EmailLog', { predicate: function (entry) { return String(entry.OrderID || '') === created.OrderID && String(entry.EmailType || '') === 'MEDICATION_RECEIVED'; }, limit: 1 })[0];
    assertSchemaTest_(log && String(log.Result) === 'FAILED', 'failed delivery was not independently logged');
    const snapshot = loadEmailSnapshot_(log.EmailLogID);
    assertSchemaTest_(snapshot && snapshot.event && Number(snapshot.event.orderVersion) === 2, 'email snapshot did not preserve the original order version');
    assertSchemaTest_(snapshot.event.actor && String(snapshot.event.actor.StaffID) === '00999', 'email snapshot did not preserve the original actor');
    assertSchemaTest_(snapshot.items && snapshot.items.length === 1 && String(snapshot.items[0].GenericName) === 'Amoxicillin', 'email snapshot did not preserve original items');
    const template = buildOrderEmailTemplate_('MEDICATION_RECEIVED', { header: findOrderHeader_(created.OrderID), items: getOrderItems_(created.OrderID), actor: admin.user });
    assertSchemaTest_(template.subject === '[Medication Received] Order ID: ' + created.OrderID, 'received template subject is incorrect');
    assertSchemaTest_(template.htmlBody.indexOf('&lt;Ada Lovelace&gt;') < 0 && template.htmlBody.indexOf('07-01-000001') < 0, 'email template exposed unmasked patient data');
    return { passed: true, message: 'Email tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Bundled from backend/TriggerService.gs
 */
const APPOINTMENT_REMINDER_HANDLER_ = 'processAppointmentDueReminders';

/** Install the daily reminder trigger idempotently without deleting unrelated triggers. */
function setupAppointmentReminderTrigger() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === APPOINTMENT_REMINDER_HANDLER_;
    });
    if (existing.length) return { created: false, handler: APPOINTMENT_REMINDER_HANDLER_, existing: existing.length };
    const configured = Number(getSetting_('APPOINTMENT_REMINDER_HOUR', '7'));
    const hour = Number.isInteger(configured) && configured >= 0 && configured <= 23 ? configured : 7;
    const timezone = String(getSetting_('TIMEZONE', 'Asia/Bangkok') || 'Asia/Bangkok');
    ScriptApp.newTrigger(APPOINTMENT_REMINDER_HANDLER_).timeBased().everyDays(1).atHour(hour).inTimezone(timezone).create();
    return { created: true, handler: APPOINTMENT_REMINDER_HANDLER_, hour: hour, timezone: timezone };
  } finally { lock.releaseLock(); }
}

/**
 * Bundled from backend/UserService.gs
 */
function findUserByStaffId_(staffId) {
  const normalized = String(staffId || '').trim();
  if (!normalized) return null;
  const users = readRecords_('Users', { predicate: function (user) { return String(user.StaffID || '') === normalized; }, limit: 1 });
  return users.length ? users[0] : null;
}

function userIsActive_(user) {
  return !!user && String(user.Active || '').toUpperCase() === 'TRUE';
}

function trustedIdentity_(user) {
  if (!user) return null;
  const identity = {
    StaffID: String(user.StaffID || ''),
    FullName: String(user.FullName || ''),
    Department: String(user.Department || ''),
    Email: String(user.Email || ''),
    Role: String(user.Role || '').toUpperCase(),
    PINHash: user.PINHash,
  };
  delete identity.PINHash;
  return identity;
}

/**
 * Bundled from backend/ValidationService.gs
 */
const MAX_API_REQUEST_BYTES_ = 1024 * 1024;

function parsePostRequest_(event) {
  const contents = event && event.postData && typeof event.postData.contents === 'string' ? event.postData.contents : '';
  if (!contents || utf8ByteLength_(contents) > MAX_API_REQUEST_BYTES_) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'body', message: 'A JSON request body is required.' }]);
  let body;
  try {
    body = JSON.parse(contents);
  } catch (_ignored) {
    throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'body', message: 'Body must be valid JSON.' }]);
  }
  return normalizeApiRequest_(body, 'POST', true);
}

function parseGetRequest_(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  const payload = parameters.payload ? parseJsonObject_(parameters.payload) : {};
  return normalizeApiRequest_({ action: parameters.action, requestId: parameters.requestId, payload: payload }, 'GET', true);
}

function utf8ByteLength_(value) {
  return Utilities.newBlob(String(value)).getBytes().length;
}

function parseJsonObject_(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_ignored) {
    return {};
  }
}

function normalizeApiRequest_(body, method, requireRequestId) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const action = typeof request.action === 'string' ? request.action.trim() : '';
  const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
  if (!action || action.length > 80) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'action', message: 'Action is required.' }]);
  if (requireRequestId && (!requestId || requestId.length > 128)) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'requestId', message: 'Request ID is required.' }]);
  return {
    action: action,
    requestId: requestId,
    sessionToken: typeof request.sessionToken === 'string' ? request.sessionToken.trim() : '',
    payload: request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {},
    method: method,
  };
}
