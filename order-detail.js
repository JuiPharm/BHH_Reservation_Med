import { apiRequest, createRequestId } from './api.js';
import { formatBangkokTime } from './dashboard.js';
import { confirmAction, setLoading, showFieldErrors, showToast } from './ui.js';

let cancellationRequestId = '';

export function validateCancellationModel(model) {
  const value = model && typeof model === 'object' ? model : {};
  const errors = {};
  const reason = String(value.ReasonCode || '').trim().toUpperCase();
  const detail = String(value.ReasonDetail || '').trim();
  if (!reason) errors.ReasonCode = 'เลือกเหตุผลการยกเลิก';
  if (reason === 'OTHER' && !detail) errors.ReasonDetail = 'ระบุรายละเอียดเหตุผล';
  if (detail.length > 1000) errors.ReasonDetail = 'รายละเอียดต้องไม่เกิน 1000 ตัวอักษร';
  return { valid: Object.keys(errors).length === 0, errors };
}

export async function submitCancellation(model, request = apiRequest, requestIdFactory = createRequestId) {
  const validation = validateCancellationModel(model);
  if (!validation.valid) {
    const error = new Error('ข้อมูลการยกเลิกไม่ถูกต้อง');
    error.errorCode = 'VALIDATION_ERROR';
    error.errors = Object.entries(validation.errors).map(([field, message]) => ({ field, message }));
    throw error;
  }
  cancellationRequestId = cancellationRequestId || requestIdFactory();
  try {
    const result = await request('CANCEL_ORDER', {
      OrderID: String(model.OrderID || '').trim(), expectedVersion: Number(model.expectedVersion),
      ReasonCode: String(model.ReasonCode || '').trim().toUpperCase(), ReasonDetail: String(model.ReasonDetail || '').trim(),
    }, { requestId: cancellationRequestId });
    cancellationRequestId = '';
    return result && result.data ? result.data : result;
  } catch (error) {
    if (!['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE'].includes(String(error && error.errorCode || ''))) cancellationRequestId = '';
    throw error;
  }
}

export async function loadOrderDetail(orderId, request = apiRequest) {
  const response = await request('GET_ORDER_DETAIL', { OrderID: String(orderId || '') });
  return response && response.data ? response.data : response;
}

export async function loadOrderChangeLog(orderId, request = apiRequest) {
  const response = await request('GET_ORDER_CHANGE_LOG', { OrderID: String(orderId || '') });
  return response && response.data ? response.data : response;
}

function detailPair(label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = String(value == null || value === '' ? '—' : value);
  wrapper.append(term, detail);
  return wrapper;
}

export function renderOrderSummary(order) {
  const list = document.createElement('dl');
  list.className = 'order-summary';
  list.append(
    detailPair('เลขที่คำขอ', order.OrderID), detailPair('สถานะ', order.Status), detailPair('ความสำคัญ', order.Priority),
    detailPair('จำนวนรายการ', order.ItemCount), detailPair('วันที่สร้าง', formatBangkokTime(order.CreatedAt)), detailPair('วันที่ต้องการ', order.RequiredDate),
  );
  return list;
}

function renderItems(container, items) {
  container.replaceChildren();
  (items || []).forEach((item) => {
    const row = document.createElement('li');
    row.textContent = `${item.GenericName || '—'} ${item.Strength || ''} — ${item.RequestedQuantity || '—'} ${item.Unit || ''}`;
    container.append(row);
  });
}

function renderLog(container, entries) {
  container.replaceChildren();
  (entries || []).forEach((entry) => {
    const row = document.createElement('li');
    row.textContent = `${formatBangkokTime(entry.ChangedAt)}: ${entry.FieldLabel || entry.FieldName || '—'}`;
    container.append(row);
  });
}

async function initialize() {
  const root = document.getElementById('order-detail');
  if (!root) return;
  const orderId = new URLSearchParams(window.location.search).get('orderId') || '';
  const editLink = document.getElementById('edit-order-link');
  if (editLink && orderId) editLink.href = `edit-order.html?orderId=${encodeURIComponent(orderId)}`;
  const loading = document.getElementById('page-loading');
  const summary = document.getElementById('order-summary');
  const itemsPanel = document.getElementById('order-items-panel');
  const itemList = document.getElementById('order-items');
  const logPanel = document.getElementById('order-log-panel');
  const logList = document.getElementById('order-change-log');
  const cancelForm = document.getElementById('cancel-order-form');
  let detailLoaded = false;
  itemsPanel.addEventListener('toggle', async () => {
    if (!itemsPanel.open || detailLoaded) return;
    setLoading(loading, true, 'กำลังโหลดรายละเอียดคำขอ');
    try {
      const data = await loadOrderDetail(orderId);
      summary.replaceChildren(renderOrderSummary(data.order || {}));
      renderItems(itemList, data.items);
      detailLoaded = true;
    } catch (error) { showToast(error.message || 'ไม่สามารถโหลดรายละเอียดคำขอได้', 'error'); }
    finally { setLoading(loading, false); }
  });
  logPanel.addEventListener('toggle', async () => {
    if (!logPanel.open || logPanel.dataset.loaded === 'true') return;
    setLoading(loading, true, 'กำลังโหลดประวัติการเปลี่ยนแปลง');
    try { renderLog(logList, await loadOrderChangeLog(orderId)); logPanel.dataset.loaded = 'true'; }
    catch (error) { showToast(error.message || 'ไม่สามารถโหลดประวัติได้', 'error'); }
    finally { setLoading(loading, false); }
  });
  cancelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const model = {
      OrderID: orderId,
      ReasonCode: cancelForm.elements.ReasonCode.value,
      ReasonDetail: cancelForm.elements.ReasonDetail.value,
    };
    const validation = validateCancellationModel(model);
    if (!validation.valid) { showFieldErrors(validation.errors, cancelForm); return; }
    if (!await confirmAction({ title: 'ยืนยันการยกเลิก', message: 'ส่งคำขอยกเลิกพร้อมเหตุผลนี้หรือไม่', confirmLabel: 'ส่งคำขอ' })) return;
    const submit = cancelForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const detail = await loadOrderDetail(orderId);
      const result = await submitCancellation({ ...model, expectedVersion: Number(detail.order && detail.order.Version) });
      showToast(result.Status === 'CANCEL_REQUESTED' ? 'ส่งคำขอยกเลิกแล้ว' : 'ยกเลิกคำขอแล้ว', 'success');
      cancelForm.reset();
    } catch (error) {
      if (error.errors) showFieldErrors(error.errors, cancelForm);
      showToast(error.message || 'ไม่สามารถยกเลิกคำขอได้', 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
