import { apiRequest, createRequestId } from './api.js';
import { loadOrderDetail, renderOrderSummary } from './order-detail.js';
import { requireAuth } from './session.js';
import { confirmAction, setLoading, showFieldErrors, showToast } from './ui.js';

const AMBIGUOUS_FAILURES = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE']);
const receiveRequestIds = new Map();
const emailRequestIds = new Map();
const retryEmailRequestIds = new Map();
const cancellationDecisionRequestIds = new Map();
const manuallyReconciledEmailTargets = new Set();

function dataOf(response) { return response && response.data ? response.data : response; }
function ambiguous(error) { return AMBIGUOUS_FAILURES.has(String(error && error.errorCode || '')); }
function operationKey(action, payload) { return `${action}:${JSON.stringify(payload)}`; }
function emailTarget(action, target) { return `${action}:${String(target || '').trim()}`; }
function requiresManualEmailReconciliation(error) { return ['EMAIL_DELIVERY_PENDING', 'EMAIL_DELIVERY_UNCERTAIN'].includes(String(error && error.errorCode || '')); }
function manualEmailError() {
  const error = new Error('สถานะอีเมลยังไม่แน่ชัด โปรดให้ผู้ดูแลระบบตรวจสอบก่อนดำเนินการซ้ำ');
  error.errorCode = 'EMAIL_RECONCILIATION_REQUIRED';
  return error;
}
function validationError(errors) {
  const error = new Error('ข้อมูลการรับยาไม่ถูกต้อง');
  error.errorCode = 'VALIDATION_ERROR';
  error.errors = Object.entries(errors).map(([field, message]) => ({ field, message }));
  return error;
}

export async function loadAdminDashboard(filters = {}, request = apiRequest) {
  const input = filters && typeof filters === 'object' ? filters : {};
  const payload = {};
  ['department', 'status', 'search', 'orderId', 'page', 'pageSize'].forEach((field) => {
    if (input[field] !== undefined && input[field] !== '') payload[field] = input[field];
  });
  return dataOf(await request('GET_ADMIN_DASHBOARD', payload));
}

export function validateReceivedItemsModel(model) {
  const input = model && typeof model === 'object' ? model : {};
  const errors = {};
  if (!String(input.OrderID || '').trim()) errors.OrderID = 'ไม่พบเลขที่คำขอ';
  if (!Number.isInteger(Number(input.expectedVersion)) || Number(input.expectedVersion) < 1) errors.expectedVersion = 'ไม่พบรุ่นข้อมูลล่าสุด';
  if (!Array.isArray(input.Items) || !input.Items.length) errors.Items = 'ต้องระบุรายการยาที่รับ';
  (input.Items || []).forEach((item, index) => {
    const prefix = `Items[${index}]`;
    const requested = Number(item && item.RequestedQuantity);
    const received = Number(item && item.ReceivedQuantity);
    const status = String(item && item.ItemStatus || '').trim().toUpperCase();
    if (!String(item && item.OrderItemID || '').trim()) errors[`${prefix}.OrderItemID`] = 'ไม่พบรายการยา';
    if (!['RECEIVED', 'PARTIALLY_RECEIVED'].includes(status)) errors[`${prefix}.ItemStatus`] = 'เลือกสถานะการรับยา';
    if (!Number.isFinite(requested) || requested <= 0 || !Number.isFinite(received) || received <= 0 || received > requested
      || (status === 'RECEIVED' && received !== requested) || (status === 'PARTIALLY_RECEIVED' && received >= requested)) {
      errors[`${prefix}.ReceivedQuantity`] = 'จำนวนที่รับต้องสอดคล้องกับจำนวนที่ขอและสถานะ';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item && item.ReceivedDate || ''))) errors[`${prefix}.ReceivedDate`] = 'ระบุวันที่รับยา';
    if (!String(item && item.ReceivedUnit || '').trim()) errors[`${prefix}.ReceivedUnit`] = 'ระบุหน่วยที่รับ';
  });
  return { valid: Object.keys(errors).length === 0, errors };
}

function receivedPayload(model) {
  return {
    OrderID: String(model.OrderID || '').trim(), expectedVersion: Number(model.expectedVersion),
    Items: model.Items.map((item) => ({
      OrderItemID: String(item.OrderItemID || '').trim(), ItemStatus: String(item.ItemStatus || '').trim().toUpperCase(),
      ReceivedDate: String(item.ReceivedDate || '').trim(), ReceivedQuantity: Number(item.ReceivedQuantity),
      ReceivedUnit: String(item.ReceivedUnit || '').trim().toUpperCase(), AdminNote: String(item.AdminNote || '').trim(),
    })),
  };
}

const purchaseRequestIds = new Map();
export async function submitOrderPurchased(orderId, expectedVersion, request = apiRequest, requestIdFactory = createRequestId) {
  const payload = { OrderID: String(orderId || '').trim(), expectedVersion: Number(expectedVersion) };
  if (!payload.OrderID || !Number.isInteger(payload.expectedVersion) || payload.expectedVersion < 1) {
    throw validationError({ _form: 'ข้อมูลไม่ครบถ้วน' });
  }
  const key = operationKey('MARK_ORDER_PURCHASED', payload);
  const requestId = purchaseRequestIds.get(key) || requestIdFactory();
  purchaseRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('MARK_ORDER_PURCHASED', payload, { requestId }));
    purchaseRequestIds.delete(key);
    return result;
  } catch (error) {
    if (!ambiguous(error)) purchaseRequestIds.delete(key);
    throw error;
  }
}

export async function submitReceivedItems(model, request = apiRequest, requestIdFactory = createRequestId) {
  const validation = validateReceivedItemsModel(model);
  if (!validation.valid) throw validationError(validation.errors);
  const payload = receivedPayload(model);
  const key = operationKey('UPDATE_RECEIVED_ITEMS', payload);
  const requestId = receiveRequestIds.get(key) || requestIdFactory();
  receiveRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('UPDATE_RECEIVED_ITEMS', payload, { requestId }));
    receiveRequestIds.delete(key);
    return result;
  } catch (error) {
    if (!ambiguous(error)) receiveRequestIds.delete(key);
    throw error;
  } finally { /* Ambiguous errors retain their ID in the catch path. */ }
}

export async function submitCancellationDecision(model, request = apiRequest, requestIdFactory = createRequestId) {
  const payload = {
    OrderID: String(model && model.OrderID || '').trim(),
    expectedVersion: Number(model && model.expectedVersion),
    decision: String(model && model.decision || '').trim().toUpperCase(),
    decisionReason: String(model && model.decisionReason || '').trim(),
  };
  if (!payload.OrderID || !Number.isInteger(payload.expectedVersion) || payload.expectedVersion < 1
    || !['APPROVE', 'REJECT'].includes(payload.decision) || payload.decisionReason.length > 1000) {
    throw validationError({ decision: 'ข้อมูลการตัดสินใจยกเลิกไม่ถูกต้อง' });
  }
  const key = operationKey('DECIDE_CANCELLATION', payload);
  const requestId = cancellationDecisionRequestIds.get(key) || requestIdFactory();
  cancellationDecisionRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('DECIDE_CANCELLATION', payload, { requestId }));
    cancellationDecisionRequestIds.delete(key);
    return result;
  } catch (error) {
    if (!ambiguous(error)) cancellationDecisionRequestIds.delete(key);
    throw error;
  }
}

export function emailDeliveryState(outcome) {
  const result = String((outcome && outcome.email && outcome.email.result) || (outcome && outcome.result) || '').toUpperCase();
  const code = String(outcome && outcome.errorCode || '').toUpperCase();
  return { retryable: result === 'FAILED', manualReview: ['UNCERTAIN', 'SENDING', 'PENDING'].includes(result) || ['EMAIL_DELIVERY_PENDING', 'EMAIL_DELIVERY_UNCERTAIN', 'EMAIL_RECONCILIATION_REQUIRED'].includes(code) };
}

export function emailResultState(outcome) {
  const state = emailDeliveryState(outcome);
  const email = outcome && outcome.email ? outcome.email : outcome || {};
  const emailLogId = String(email.emailLogId || email.EmailLogID || '');
  if (state.manualReview) return { retryable: false, manualReview: true, emailLogId, message: 'สถานะอีเมลยังไม่แน่ชัด โปรดให้ผู้ดูแลระบบตรวจสอบก่อนดำเนินการซ้ำ' };
  if (state.retryable) return { retryable: true, manualReview: false, emailLogId, message: 'การส่งอีเมลล้มเหลว สามารถลองส่งซ้ำได้' };
  return { retryable: false, manualReview: false, emailLogId, message: 'ระบบบันทึกผลการส่งอีเมลแล้ว' };
}

export function emailControlState(state) {
  return { sendDisabled: Boolean(state && state.manualReview), retryDisabled: Boolean(state && state.manualReview) };
}

export async function confirmAndSendOrderEmail(orderId, expectedVersion, request = apiRequest, confirm = confirmAction, requestIdFactory = createRequestId) {
  const target = emailTarget('SEND_ORDER_EMAIL', orderId);
  if (manuallyReconciledEmailTargets.has(target)) throw manualEmailError();
  if (!await confirm({ title: 'ยืนยันการส่งอีเมล', message: 'ต้องการส่งอีเมลแจ้งการรับยาใช่หรือไม่', confirmLabel: 'ส่งอีเมล' })) return null;
  const payload = { OrderID: String(orderId || '').trim(), expectedVersion: Number(expectedVersion) };
  const key = operationKey('SEND_ORDER_EMAIL', payload);
  const requestId = emailRequestIds.get(key) || requestIdFactory();
  emailRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('SEND_ORDER_EMAIL', payload, { requestId }));
    emailRequestIds.delete(key);
    return result;
  } catch (error) {
    if (requiresManualEmailReconciliation(error)) manuallyReconciledEmailTargets.add(target);
    else if (!ambiguous(error)) emailRequestIds.delete(key);
    throw error;
  }
}

export async function confirmAndResendFailedEmail(emailLogId, request = apiRequest, confirm = confirmAction, requestIdFactory = createRequestId) {
  const target = emailTarget('RESEND_FAILED_EMAIL', emailLogId);
  if (manuallyReconciledEmailTargets.has(target)) throw manualEmailError();
  if (!await confirm({ title: 'ยืนยันการส่งอีเมลซ้ำ', message: 'ส่งซ้ำเฉพาะรายการที่ระบบบันทึกว่าล้มเหลว', confirmLabel: 'ส่งซ้ำ' })) return null;
  const payload = { EmailLogID: String(emailLogId || '') };
  const key = operationKey('RESEND_FAILED_EMAIL', payload);
  const requestId = retryEmailRequestIds.get(key) || requestIdFactory();
  retryEmailRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('RESEND_FAILED_EMAIL', payload, { requestId }));
    retryEmailRequestIds.delete(key);
    return result;
  } catch (error) {
    if (requiresManualEmailReconciliation(error)) manuallyReconciledEmailTargets.add(target);
    else if (!ambiguous(error)) retryEmailRequestIds.delete(key);
    throw error;
  }
}

function textCell(value, label) {
  const cell = document.createElement('td');
  cell.dataset.label = label;
  cell.textContent = String(value == null || value === '' ? '—' : value);
  return cell;
}

function renderAdminOrders(container, orders) {
  container.replaceChildren();
  (orders || []).forEach((order) => {
    const row = document.createElement('tr');
    const link = document.createElement('a');
    link.className = 'order-link';
    link.href = `admin-order-detail.html?orderId=${encodeURIComponent(String(order.OrderID || ''))}`;
    link.textContent = String(order.OrderID || '—');
    const id = document.createElement('td');
    id.append(link);
    id.dataset.label = 'เลขที่คำขอ';
    row.append(id, textCell(order.Department, 'หน่วยงาน'), textCell(order.Status, 'สถานะ'), textCell(order.RequiredDate, 'วันนัด'), textCell(order.ItemCount, 'รายการ'));
    container.append(row);
  });
}

function receivedModel(form, orderId, version) {
  return {
    OrderID: orderId, expectedVersion: version,
    Items: [...form.querySelectorAll('[data-received-item]')].map((row) => ({
      OrderItemID: row.dataset.orderItemId, RequestedQuantity: Number(row.dataset.requestedQuantity),
      ItemStatus: row.querySelector('[name="ItemStatus"]').value, ReceivedDate: row.querySelector('[name="ReceivedDate"]').value,
      ReceivedQuantity: row.querySelector('[name="ReceivedQuantity"]').value, ReceivedUnit: row.querySelector('[name="ReceivedUnit"]').value,
      AdminNote: row.querySelector('[name="AdminNote"]').value,
    })),
  };
}

export function receivedRow(item, index = 0) {
  const row = document.createElement('fieldset');
  row.className = 'received-item';
  row.dataset.receivedItem = 'true';
  row.dataset.medicationItem = 'true';
  row.dataset.orderItemId = String(item.OrderItemID || '');
  row.dataset.requestedQuantity = String(item.RequestedQuantity || '');
  const legend = document.createElement('legend');
  legend.textContent = `${item.GenericName || 'ยา'} (${item.RequestedQuantity || '—'} ${item.Unit || ''})`;
  const status = document.createElement('select'); status.name = 'ItemStatus';
  [['PARTIALLY_RECEIVED', 'รับบางส่วน'], ['RECEIVED', 'รับครบ']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; status.append(option); });
  const date = document.createElement('input'); date.name = 'ReceivedDate'; date.type = 'date';
  const quantity = document.createElement('input'); quantity.name = 'ReceivedQuantity'; quantity.type = 'number'; quantity.min = '1'; quantity.max = String(item.RequestedQuantity || ''); quantity.step = 'any';
  const unit = document.createElement('input'); unit.name = 'ReceivedUnit'; unit.value = String(item.Unit || '');
  const note = document.createElement('input'); note.name = 'AdminNote';
  [['ItemStatus', 'สถานะ', status], ['ReceivedDate', 'วันที่รับ', date], ['ReceivedQuantity', 'จำนวนที่รับ', quantity], ['ReceivedUnit', 'หน่วย', unit], ['AdminNote', 'หมายเหตุ', note]].forEach(([name, label, input]) => {
    const field = document.createElement('label');
    const error = document.createElement('span');
    const errorId = `received-error-${index}-${name}`;
    field.textContent = label;
    input.setAttribute('aria-describedby', errorId);
    error.id = errorId;
    error.dataset.medicationFieldError = name;
    error.setAttribute('role', 'alert');
    field.append(input, error);
    row.append(field);
  });
  return row;
}

async function initializeDashboard() {
  const root = document.getElementById('admin-orders-panel');
  if (!root) return;
  if (!requireAuth()) return;
  const loading = document.getElementById('page-loading');
  const rows = document.getElementById('admin-orders');
  const department = document.getElementById('admin-department');
  const error = document.getElementById('page-error');
  const load = async () => {
    setLoading(loading, true, 'กำลังตรวจสอบสิทธิ์และโหลดแดชบอร์ด');
    error.textContent = '';
    try { renderAdminOrders(rows, (await loadAdminDashboard({ department: department.value })).recentOrders); }
    catch (reason) { error.textContent = reason.message || 'ไม่สามารถเปิดแดชบอร์ดผู้ดูแลได้'; }
    finally { setLoading(loading, false); }
  };
  department.addEventListener('change', load);
  await load();
}

async function initializeDetail() {
  const root = document.getElementById('admin-order-detail');
  if (!root) return;
  if (!requireAuth()) return;
  const orderId = new URLSearchParams(window.location.search).get('orderId') || '';
  const loading = document.getElementById('page-loading');
  const error = document.getElementById('page-error');
  const summary = document.getElementById('admin-order-summary');
  const items = document.getElementById('received-items');
  const form = document.getElementById('received-items-form');
  const purchasingPanel = document.getElementById('order-purchasing-section');
  const markPurchasedBtn = document.getElementById('mark-order-purchased');
  const purchasedResult = document.getElementById('purchased-result');
  const send = document.getElementById('send-order-email');
  const emailResult = document.getElementById('email-result');
  const cancellationPanel = document.getElementById('cancellation-decision');
  const cancellationReason = document.getElementById('cancellation-decision-reason');
  const cancellationResult = document.getElementById('cancellation-decision-result');
  const approveCancellation = document.getElementById('approve-cancellation');
  const rejectCancellation = document.getElementById('reject-cancellation');
  let version = 0;
  let emailManualLocked = false;
  const renderEmailResult = (outcome) => {
    const state = emailResultState(outcome);
    emailManualLocked = emailManualLocked || state.manualReview;
    const controls = emailControlState({ manualReview: emailManualLocked });
    send.disabled = controls.sendDisabled;
    emailResult.replaceChildren();
    if (state.manualReview) { emailResult.textContent = state.message; return; }
    emailResult.textContent = state.message;
    if (!state.retryable || !state.emailLogId) return;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'ลองส่งอีเมลซ้ำ';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        const result = await confirmAndResendFailedEmail(state.emailLogId);
        if (!result) { retry.disabled = false; return; }
        renderEmailResult(result);
      } catch (reason) {
        const next = emailResultState(reason);
        if (next.manualReview) renderEmailResult(reason);
        else { retry.disabled = false; showToast(reason.message || 'ไม่สามารถส่งอีเมลซ้ำได้', 'error'); }
      }
    });
    emailResult.append(retry);
  };
  setLoading(loading, true, 'กำลังตรวจสอบสิทธิ์และโหลดคำขอ');
  try {
    await loadAdminDashboard({}); // Successful response is the ADMIN authorization confirmation.
    const detail = await loadOrderDetail(orderId);
    const order = detail.order || {};
    version = Number(order.Version || 0);
    summary.replaceChildren(renderOrderSummary(order));
    items.replaceChildren(...(detail.items || []).map(receivedRow));
    
    const status = String(order.Status || '');
    cancellationPanel.hidden = status !== 'CANCEL_REQUESTED';
    purchasingPanel.hidden = (status !== 'SUBMITTED' && status !== 'UNDER_REVIEW');
    if (!purchasingPanel.hidden) form.hidden = true; // hide receive items if not yet ordered (optional UX)
    else form.hidden = false;
    
  } catch (reason) { error.textContent = reason.message || 'ไม่สามารถโหลดคำขอได้'; form.querySelector('button').disabled = true; send.disabled = true; markPurchasedBtn.disabled = true; }
  finally { setLoading(loading, false); }
  
  markPurchasedBtn.addEventListener('click', async () => {
    if (!await confirmAction({ title: 'ยืนยันการสั่งซื้อ', message: 'ต้องการบันทึกว่าคำขอนี้ได้สั่งซื้อไปแล้วใช่หรือไม่?', confirmLabel: 'ยืนยันสั่งซื้อ' })) return;
    markPurchasedBtn.disabled = true; setLoading(loading, true, 'กำลังบันทึกการสั่งซื้อ');
    try {
      const result = await submitOrderPurchased(orderId, version);
      version = Number(result.Version || version);
      purchasedResult.textContent = 'บันทึกการสั่งซื้อเรียบร้อยแล้ว';
      purchasingPanel.hidden = true; form.hidden = false;
      showToast('บันทึกการสั่งซื้อแล้ว', 'success');
      // Update summary status
      summary.replaceChildren(renderOrderSummary(result));
    } catch (reason) {
      markPurchasedBtn.disabled = false;
      showToast(reason.message || 'ไม่สามารถบันทึกได้', 'error');
    } finally {
      setLoading(loading, false);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const model = receivedModel(form, orderId, version);
    const validation = validateReceivedItemsModel(model);
    if (!validation.valid) { showFieldErrors(validation.errors, form); return; }
    if (!await confirmAction({ title: 'ยืนยันการบันทึกรับยา', message: 'ยืนยันจำนวนและสถานะการรับยาทุกรายการหรือไม่', confirmLabel: 'บันทึก' })) return;
    submit.disabled = true; setLoading(loading, true, 'กำลังบันทึกการรับยา');
    try { const result = await submitReceivedItems(model); version = Number(result.Version || version); showToast('บันทึกการรับยาแล้ว', 'success'); }
    catch (reason) { if (reason.errors) showFieldErrors(reason.errors, form); showToast(reason.message || 'ไม่สามารถบันทึกการรับยาได้', 'error'); }
    finally { submit.disabled = false; setLoading(loading, false); }
  });
  const decide = async (decision) => {
    const label = decision === 'APPROVE' ? 'อนุมัติการยกเลิก' : 'ปฏิเสธการยกเลิก';
    if (!await confirmAction({ title: label, message: `${label}และบันทึกเหตุผลนี้หรือไม่`, confirmLabel: label })) return;
    approveCancellation.disabled = true;
    rejectCancellation.disabled = true;
    setLoading(loading, true, 'กำลังบันทึกการตัดสินใจ');
    try {
      const result = await submitCancellationDecision({
        OrderID: orderId, expectedVersion: version, decision, decisionReason: cancellationReason.value,
      });
      version = Number(result.Version || version);
      cancellationResult.textContent = decision === 'APPROVE' ? 'อนุมัติการยกเลิกแล้ว' : 'ปฏิเสธการยกเลิกและคืนสถานะเดิมแล้ว';
      cancellationPanel.hidden = true;
    } catch (reason) {
      showToast(reason.message || 'ไม่สามารถบันทึกการตัดสินใจได้', 'error');
    } finally {
      approveCancellation.disabled = false;
      rejectCancellation.disabled = false;
      setLoading(loading, false);
    }
  };
  approveCancellation.addEventListener('click', () => decide('APPROVE'));
  rejectCancellation.addEventListener('click', () => decide('REJECT'));
  send.addEventListener('click', async () => {
    send.disabled = true; setLoading(loading, true, 'กำลังส่งอีเมล');
    try {
      const result = await confirmAndSendOrderEmail(orderId, version);
      if (!result) return;
      renderEmailResult(result);
    } catch (reason) {
      if (emailResultState(reason).manualReview) renderEmailResult(reason);
      else showToast(reason.message || 'ไม่สามารถส่งอีเมลได้', 'error');
    }
    finally { send.disabled = emailManualLocked; setLoading(loading, false); }
  });
}

// User Management Implementation
let allUsers = [];

export async function fetchUsersList(request = apiRequest) {
  const result = await request('LIST_USERS', {});
  return dataOf(result);
}

export async function createUser(payload, request = apiRequest) {
  const result = await request('CREATE_USER', payload);
  return dataOf(result);
}

export async function resetUserPin(payload, request = apiRequest) {
  const result = await request('RESET_USER_PIN', payload);
  return dataOf(result);
}

export async function updateUserStatus(staffId, active, request = apiRequest) {
  const result = await request('UPDATE_USER', { staffId, active });
  return dataOf(result);
}

function renderUsersTable(tbody, users) {
  tbody.replaceChildren();
  if (!users || !users.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'text-center';
    td.textContent = 'ไม่พบข้อมูลผู้ใช้งาน';
    tr.append(td);
    tbody.append(tr);
    return;
  }
  users.forEach((user) => {
    const tr = document.createElement('tr');

    const tdStaff = document.createElement('td');
    tdStaff.textContent = user.StaffID || '—';

    const tdName = document.createElement('td');
    tdName.textContent = user.FullName || '—';

    const tdDept = document.createElement('td');
    tdDept.textContent = user.Department || '—';

    const tdEmail = document.createElement('td');
    tdEmail.textContent = user.Email || '—';

    const tdRole = document.createElement('td');
    const roleBadge = document.createElement('span');
    roleBadge.className = `badge-role ${String(user.Role).toLowerCase()}`;
    roleBadge.textContent = user.Role;
    tdRole.append(roleBadge);

    const tdActive = document.createElement('td');
    const activeBadge = document.createElement('span');
    activeBadge.className = `badge-active ${user.Active ? 'active' : 'inactive'}`;
    activeBadge.textContent = user.Active ? 'เปิดใช้งาน' : 'ระงับการใช้';
    tdActive.append(activeBadge);

    const tdActions = document.createElement('td');
    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn-sm secondary';
    btnReset.textContent = 'รีเซ็ต PIN';
    btnReset.addEventListener('click', () => openResetPinModal(user));

    const btnToggle = document.createElement('button');
    btnToggle.type = 'button';
    btnToggle.className = `btn-sm ${user.Active ? 'danger' : 'primary'}`;
    btnToggle.textContent = user.Active ? 'ระงับ' : 'เปิดใช้งาน';
    btnToggle.style.marginLeft = '0.35rem';
    btnToggle.addEventListener('click', () => toggleUserActive(user));

    tdActions.append(btnReset, btnToggle);
    tr.append(tdStaff, tdName, tdDept, tdEmail, tdRole, tdActive, tdActions);
    tbody.append(tr);
  });
}

function openResetPinModal(user) {
  const modal = document.getElementById('modal-reset-pin');
  if (!modal) return;
  document.getElementById('reset-target-name').textContent = user.FullName || '—';
  document.getElementById('reset-target-id').textContent = user.StaffID || '—';
  document.getElementById('reset-target-staffid-input').value = user.StaffID || '';
  document.getElementById('reset-pin-error').textContent = '';
  document.getElementById('form-reset-pin').reset();
  modal.showModal();
}

async function toggleUserActive(user) {
  const newStatus = !user.Active;
  const actionLabel = newStatus ? 'เปิดใช้งาน' : 'ระงับการใช้งาน';
  if (!await confirmAction({ title: `ยืนยัน${actionLabel}`, message: `คุณต้องการ${actionLabel} ผู้ใช้ ${user.FullName} (${user.StaffID}) ใช่หรือไม่?` })) return;
  const loading = document.getElementById('page-loading');
  setLoading(loading, true, `กำลัง${actionLabel}...`);
  try {
    await updateUserStatus(user.StaffID, newStatus);
    showToast(`${actionLabel}สำเร็จ`, 'success');
    await refreshUserList();
  } catch (err) {
    showToast(err.message || 'ไม่สามารถปรับอัปเดตสถานะผู้ใช้ได้', 'error');
  } finally {
    setLoading(loading, false);
  }
}

async function refreshUserList() {
  const tbody = document.getElementById('admin-users-tbody');
  const loading = document.getElementById('page-loading');
  const error = document.getElementById('page-error');
  if (!tbody) return;
  setLoading(loading, true, 'กำลังโหลดรายการผู้ใช้งาน');
  error.textContent = '';
  try {
    const data = await fetchUsersList();
    allUsers = data.users || [];
    filterAndRenderUsers();
  } catch (err) {
    error.textContent = err.message || 'ไม่สามารถดึงรายการผู้ใช้งานได้';
  } finally {
    setLoading(loading, false);
  }
}

function filterAndRenderUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  const searchInput = document.getElementById('user-search');
  const term = String(searchInput ? searchInput.value : '').trim().toLowerCase();
  if (!term) {
    renderUsersTable(tbody, allUsers);
    return;
  }
  const filtered = allUsers.filter((u) =>
    String(u.StaffID || '').toLowerCase().includes(term) ||
    String(u.FullName || '').toLowerCase().includes(term) ||
    String(u.Department || '').toLowerCase().includes(term) ||
    String(u.Email || '').toLowerCase().includes(term) ||
    String(u.Role || '').toLowerCase().includes(term)
  );
  renderUsersTable(tbody, filtered);
}

function initializeUserManagement() {
  const tabOrders = document.getElementById('tab-orders');
  const tabUsers = document.getElementById('tab-users');
  const panelOrders = document.getElementById('admin-orders-panel');
  const panelUsers = document.getElementById('admin-users-panel');

  if (tabOrders && tabUsers) {
    tabOrders.addEventListener('click', () => {
      tabOrders.classList.add('active'); tabOrders.setAttribute('aria-selected', 'true');
      tabUsers.classList.remove('active'); tabUsers.setAttribute('aria-selected', 'false');
      panelOrders.hidden = false; panelUsers.hidden = true;
    });
    tabUsers.addEventListener('click', () => {
      tabUsers.classList.add('active'); tabUsers.setAttribute('aria-selected', 'true');
      tabOrders.classList.remove('active'); tabOrders.setAttribute('aria-selected', 'false');
      panelUsers.hidden = false; panelOrders.hidden = true;
      refreshUserList();
    });
  }

  const searchInput = document.getElementById('user-search');
  if (searchInput) searchInput.addEventListener('input', filterAndRenderUsers);

  // Create User Modal Handlers
  const modalCreate = document.getElementById('modal-create-user');
  const btnOpenCreate = document.getElementById('btn-open-create-user');
  const btnCancelCreate = document.getElementById('btn-cancel-create-user');
  const formCreate = document.getElementById('form-create-user');
  const createError = document.getElementById('create-user-error');

  if (btnOpenCreate && modalCreate) {
    btnOpenCreate.addEventListener('click', () => {
      if (createError) createError.textContent = '';
      if (formCreate) formCreate.reset();
      modalCreate.showModal();
    });
  }
  if (btnCancelCreate && modalCreate) {
    btnCancelCreate.addEventListener('click', () => modalCreate.close());
  }

  if (formCreate) {
    formCreate.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(formCreate);
      const payload = {
        staffId: formData.get('staffId'),
        fullName: formData.get('fullName'),
        department: formData.get('department'),
        email: formData.get('email'),
        role: formData.get('role'),
        pin: formData.get('pin'),
      };
      const loading = document.getElementById('page-loading');
      if (createError) createError.textContent = '';
      setLoading(loading, true, 'กำลังเพิ่มผู้ใช้งาน');
      try {
        await createUser(payload);
        showToast('เพิ่มผู้ใช้งานใหม่เรียบร้อยแล้ว', 'success');
        modalCreate.close();
        await refreshUserList();
      } catch (err) {
        if (createError) createError.textContent = err.message || 'ไม่สามารถเพิ่มผู้ใช้งานได้';
      } finally {
        setLoading(loading, false);
      }
    });
  }

  // Reset PIN Modal Handlers
  const modalReset = document.getElementById('modal-reset-pin');
  const btnCancelReset = document.getElementById('btn-cancel-reset-pin');
  const formReset = document.getElementById('form-reset-pin');
  const resetError = document.getElementById('reset-pin-error');

  if (btnCancelReset && modalReset) {
    btnCancelReset.addEventListener('click', () => modalReset.close());
  }

  if (formReset) {
    formReset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(formReset);
      const payload = {
        staffId: formData.get('staffId'),
        newPin: formData.get('newPin'),
      };
      const loading = document.getElementById('page-loading');
      if (resetError) resetError.textContent = '';
      setLoading(loading, true, 'กำลังตั้งรหัสผ่านใหม่');
      try {
        await resetUserPin(payload);
        showToast('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว', 'success');
        modalReset.close();
      } catch (err) {
        if (resetError) resetError.textContent = err.message || 'ไม่สามารถตั้งรหัสผ่านใหม่ได้';
      } finally {
        setLoading(loading, false);
      }
    });
  }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { initializeDashboard(); initializeDetail(); initializeUserManagement(); });

