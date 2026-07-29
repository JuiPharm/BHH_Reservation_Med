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
  const isAdmin = context && context.user && String(context.user.Role || '').toUpperCase() === 'ADMIN';
  const userDept = String(context && context.user && context.user.Department || '');
  const dashboardQuery = normalizeStaffDashboardQuery_(query);
  const filterDept = isAdmin ? dashboardQuery.department : userDept;

  const matching = readRecords_('OrderHeaders', { predicate: function (record) {
    if (filterDept && String(record.Department || '') !== filterDept) return false;
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
  const department = cleanOrderText_(input.department || filters.department || filters.Department).toUpperCase();
  const search = cleanOrderText_(input.search).toUpperCase();
  const sortMatch = /^([A-Za-z]+):(asc|desc)$/i.exec(cleanOrderText_(input.sort));
  const sortField = sortMatch && STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] ? STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] : 'CreatedAt';
  const sortDirection = sortMatch && STAFF_DASHBOARD_SORT_FIELDS_[sortMatch[1].toUpperCase()] && sortMatch[2].toLowerCase() === 'asc' ? 1 : -1;
  return {
    status: status, department: department, search: search, sortField: sortField, sortDirection: sortDirection,
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
  const isAdmin = context && context.user && String(context.user.Role || '').toUpperCase() === 'ADMIN';
  const userDept = String(context && context.user && context.user.Department || '');
  const dashboardQuery = normalizeStaffDashboardQuery_(query);
  const filterDept = isAdmin ? dashboardQuery.department : userDept;

  const cache = CacheService.getScriptCache();
  const cacheVersion = cache.get('DASHBOARD_VERSION') || '0';
  const cacheKey = 'STAFF_' + cacheVersion + '_' + Utilities.base64Encode(JSON.stringify({ d: filterDept, s: dashboardQuery.status, q: dashboardQuery.search, f: dashboardQuery.sortField, r: dashboardQuery.sortDirection, p: dashboardQuery.page, z: dashboardQuery.pageSize })).substring(0, 200);
  
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  const allFilteredOrders = [];
  const counts = {};
  
  // Single read for both counting and filtering
  const orders = readRecords_('OrderHeaders', { predicate: function (record) {
    if (filterDept && String(record.Department || '') !== filterDept) return false;
    
    // Count status before applying search/status filters
    const status = String(record.Status || 'UNKNOWN');
    counts[status] = (counts[status] || 0) + 1;
    
    // Apply search and status filters for the list
    if (dashboardQuery.status && String(record.Status || '').toUpperCase() !== dashboardQuery.status) return false;
    if (dashboardQuery.search && String(record.OrderID || '').toUpperCase().indexOf(dashboardQuery.search) < 0) return false;
    
    allFilteredOrders.push(record);
    return true; // We don't use the return array from readRecords_ for list, we use allFilteredOrders
  } });

  sortStaffDashboardOrders_(allFilteredOrders, dashboardQuery.sortField, dashboardQuery.sortDirection);
  const pageSize = dashboardQuery.pageSize;
  const page = dashboardQuery.page;
  const start = (page - 1) * pageSize;
  const pagedOrders = allFilteredOrders.slice(start, start + pageSize).map(orderSummary_);

  const result = { department: filterDept || (isAdmin ? 'ALL' : userDept), totalOrders: allFilteredOrders.length, statusCounts: counts, page: page, pageSize: pageSize, total: allFilteredOrders.length, recentOrders: pagedOrders };
  
  try {
    const jsonResult = JSON.stringify(result);
    if (jsonResult.length < 100000) cache.put(cacheKey, jsonResult, 60);
  } catch(e) {}
  
  return result;
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
  const filters = query && typeof query === 'object' ? query : {};
  const department = cleanOrderText_(filters.department || filters.Department).toUpperCase();
  const statusFilter = cleanOrderText_(filters.status || filters.Status).toUpperCase();
  const search = cleanOrderText_(filters.orderId || filters.OrderID || filters.search).toUpperCase();
  const pageSize = Math.min(MAX_ORDER_PAGE_SIZE_, positiveInteger_(filters.pageSize == null ? filters.limit : filters.pageSize, 25));
  const page = positiveInteger_(filters.page, 1);

  const cache = CacheService.getScriptCache();
  const cacheVersion = cache.get('DASHBOARD_VERSION') || '0';
  const cacheKey = 'ADMIN_' + cacheVersion + '_' + Utilities.base64Encode(JSON.stringify({ d: department, s: statusFilter, q: search, p: page, z: pageSize })).substring(0, 200);
  
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  const allFilteredOrders = [];
  const statusCounts = {};

  const orders = readRecords_('OrderHeaders', { predicate: function (order) { 
    if (department && String(order.Department || '').toUpperCase() !== department) return false;
    
    // Count status before applying search/status filters
    const status = String(order.Status || 'UNKNOWN');
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    
    // Apply search and status filters for the list
    if (statusFilter && String(order.Status || '').toUpperCase() !== statusFilter) return false;
    if (search && String(order.OrderID || '').toUpperCase().indexOf(search) < 0) return false;
    
    allFilteredOrders.push(order);
    return true;
  } });

  // Optional: You can sort admin orders here if needed, or rely on default sheet order.
  // Using default sheet order for now to match original behavior, but reversed (newest first).
  allFilteredOrders.reverse();

  const start = (page - 1) * pageSize;
  const pagedOrders = allFilteredOrders.slice(start, start + pageSize).map(adminOrderSummary_);

  const result = { department: department || 'ALL', totalOrders: allFilteredOrders.length, statusCounts: statusCounts, page: page, pageSize: pageSize, total: allFilteredOrders.length, recentOrders: pagedOrders };
  
  try {
    const jsonResult = JSON.stringify(result);
    if (jsonResult.length < 100000) cache.put(cacheKey, jsonResult, 60);
  } catch(e) {}
  
  return result;
}

function markOrderPurchased_(context, payload, requestId) {
  requireAdminOrderContext_(context);
  const orderId = requireOrderId_(payload);
  const initial = findOrderHeader_(orderId);
  if (!initial) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  const replay = findStaffMutationReplay_('MARK_ORDER_PURCHASED', context.user.StaffID, requestId);
  if (replay) return replay.ResponsePayload;
  const lock = LockService.getScriptLock();
  let result = null;
  lock.waitLock(30000);
  try {
    const lockedReplay = findStaffMutationReplay_('MARK_ORDER_PURCHASED', context.user.StaffID, requestId);
    if (lockedReplay) { result = lockedReplay.ResponsePayload; }
    else {
      const current = findOrderHeader_(orderId);
      if (!current) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
      assertExpectedOrderVersion_(current, Number(payload.expectedVersion));
      const allowed = ['SUBMITTED', 'UNDER_REVIEW'];
      if (allowed.indexOf(String(current.Status || '')) < 0) throw new ApiError_('INVALID_STATUS_TRANSITION', 'Order cannot be marked as ordered from its current status.');
      const now = new Date();
      const updates = { Status: 'ORDERED', UpdatedAt: toSheetDate_(now), UpdatedBy: context.user.StaffID, Version: Number(current.Version || 0) + 1 };
      
      // Update items status too
      const currentItems = getOrderItems_(orderId);
      const itemUpdates = currentItems.map(function(item) {
        if (allowed.indexOf(String(item.Status || '')) >= 0) {
          return { keyValue: item.OrderItemID, updates: { Status: 'ORDERED', UpdatedAt: toSheetDate_(now), UpdatedBy: context.user.StaffID, Version: Number(item.Version || 0) + 1 } };
        }
        return null;
      }).filter(Boolean);
      
      const newHeader = updateRecordByKey_('OrderHeaders', 'OrderID', orderId, updates);
      if (itemUpdates.length) batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', itemUpdates);
      
      appendRecords_('OrderChangeLog', [{ LogID: generateId_(), OrderID: orderId, StaffID: context.user.StaffID, Timestamp: toSheetDate_(now), OldStatus: current.Status, NewStatus: 'ORDERED', Reason: 'Marked as ordered by admin' }]);
      result = orderDetail_(newHeader);
      logStaffMutation_('MARK_ORDER_PURCHASED', context.user.StaffID, requestId, result);
    }
  } finally {
    lock.releaseLock();
  }
  
  // Enqueue email for ORDER_PLACED to department email
  const deptHeader = initial.Department ? readRecords_('Departments', { predicate: function(d) { return d.DepartmentName === initial.Department; }, limit: 1 })[0] : null;
  const toEmail = deptHeader ? deptHeader.DepartmentEmail : '';
  const ccEmail = deptHeader ? deptHeader.CCEmail : '';
  if (toEmail) {
    enqueueEmailNotification_('ORDER_PLACED', { header: result }, { to: toEmail, cc: ccEmail });
  }
  
  return result;
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
