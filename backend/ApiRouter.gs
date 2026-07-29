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
  LIST_USERS: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: false, handler: 'listUsers_' }),
  CREATE_USER: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'createUserByAdmin_' }),
  RESET_USER_PIN: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'resetUserPinByAdmin_' }),
  UPDATE_USER: Object.freeze({ auth: true, roles: Object.freeze(['ADMIN']), mutates: true, handler: 'updateUserByAdmin_' }),
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
      case 'listUsers_': return listUsers_;
      case 'createUserByAdmin_': return createUserByAdmin_;
      case 'resetUserPinByAdmin_': return resetUserPinByAdmin_;
      case 'updateUserByAdmin_': return updateUserByAdmin_;
      default: throw new ApiError_('UNKNOWN_ACTION', 'Unsupported action.');
    }
  } catch (_ignored) {
    throw new ApiError_('NOT_IMPLEMENTED', 'This action is not available.');
  }
}
