import { apiRequest, createRequestId } from './api.js';
import { getSession, requireAuth, rescheduleReferenceStorageKey } from './session.js';
import { confirmAction, setLoading, showFieldErrors, showToast } from './ui.js';

const AMBIGUOUS_FAILURES = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE']);
const rescheduleRequestIds = new Map();
function dataOf(response) { return response && response.data ? response.data : response; }
function ambiguous(error) { return AMBIGUOUS_FAILURES.has(String(error && error.errorCode || '')); }
function sessionStore() { try { return globalThis['session' + 'Storage']; } catch (_error) { return null; } }
function invalid(errors) { const error = new Error('ข้อมูลการเลื่อนนัดไม่ถูกต้อง'); error.errorCode = 'VALIDATION_ERROR'; error.errors = Object.entries(errors).map(([field, message]) => ({ field, message })); return error; }
function operationKey(action, payload) { return `${action}:${JSON.stringify(payload)}`; }

export function rescheduleReferenceFromSearch(search = '') { return String(new URLSearchParams(search).get('reference') || '').trim(); }
export function savedRescheduleReference(storage = sessionStore()) { return storage ? String(storage.getItem(rescheduleReferenceStorageKey()) || '').trim() : ''; }
export function clearRescheduleReference(storage = sessionStore()) { if (storage) storage.removeItem(rescheduleReferenceStorageKey()); }

export async function beginReschedule(reference, options = {}) {
  const value = String(reference || '').trim();
  const request = options.request || apiRequest;
  const preview = dataOf(await request('GET_RESCHEDULE_REFERENCE', { reference: value }, { method: 'GET' }));
  const session = options.session === undefined ? getSession() : options.session;
  if (!session) {
    const storage = options.storage || sessionStore();
    if (storage) storage.setItem(rescheduleReferenceStorageKey(), value);
    (options.location || window.location).replace('login.html');
    return null;
  }
  return { reference: value, preview };
}

export function validateRescheduleModel(model) {
  const value = model && typeof model === 'object' ? model : {};
  const errors = {};
  if (!String(value.reference || '').trim()) errors.reference = 'ลิงก์เลื่อนนัดไม่ถูกต้อง';
  if (!Number.isInteger(Number(value.expectedVersion)) || Number(value.expectedVersion) < 1) errors.expectedVersion = 'ไม่พบรุ่นข้อมูลล่าสุด';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.newRequiredDate || ''))) errors.newRequiredDate = 'ระบุวันนัดใหม่';
  if (!String(value.reason || '').trim()) errors.reason = 'ระบุเหตุผลในการเลื่อนนัด';
  return { valid: Object.keys(errors).length === 0, errors };
}

export async function submitReschedule(model, request = apiRequest, requestIdFactory = createRequestId) {
  const validation = validateRescheduleModel(model);
  if (!validation.valid) throw invalid(validation.errors);
  const payload = { reference: String(model.reference).trim(), expectedVersion: Number(model.expectedVersion), newRequiredDate: String(model.newRequiredDate).trim(), reason: String(model.reason).trim() };
  const key = operationKey('SUBMIT_APPOINTMENT_RESCHEDULE', payload);
  const requestId = rescheduleRequestIds.get(key) || requestIdFactory();
  rescheduleRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request('SUBMIT_APPOINTMENT_RESCHEDULE', payload, { requestId }));
    rescheduleRequestIds.delete(key);
    return result;
  } catch (error) {
    if (!ambiguous(error)) rescheduleRequestIds.delete(key);
    throw error;
  }
}

async function initialize() {
  const root = document.getElementById('reschedule-form-root');
  if (!root) return;
  const reference = rescheduleReferenceFromSearch(window.location.search) || savedRescheduleReference();
  const loading = document.getElementById('page-loading');
  const error = document.getElementById('page-error');
  const form = document.getElementById('reschedule-form');
  setLoading(loading, true, 'กำลังตรวจสอบสิทธิ์และโหลดนัดหมาย');
  let version = 0;
  try {
    const started = await beginReschedule(reference);
    if (!started) return;
    if (!requireAuth()) return;
    const order = dataOf(await apiRequest('GET_RESCHEDULE_ORDER', { reference: started.reference }));
    version = Number(order.Version || 0);
    document.getElementById('old-appointment-date').textContent = String(order.RequiredDate || '—');
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname);
  } catch (reason) {
    error.textContent = reason.message || 'ไม่สามารถโหลดข้อมูลเลื่อนนัดได้';
    form.querySelector('button').disabled = true;
    if (!ambiguous(reason)) clearRescheduleReference();
  }
  finally { setLoading(loading, false); }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const model = { reference, expectedVersion: version, newRequiredDate: form.elements.newRequiredDate.value, reason: form.elements.reason.value };
    const validation = validateRescheduleModel(model);
    if (!validation.valid) { showFieldErrors(validation.errors, form); return; }
    if (!await confirmAction({ title: 'ยืนยันการเลื่อนนัด', message: 'ยืนยันวันนัดใหม่และเหตุผลนี้หรือไม่', confirmLabel: 'ยืนยันเลื่อนนัด' })) return;
    submit.disabled = true; setLoading(loading, true, 'กำลังบันทึกการเลื่อนนัด');
    try { await submitReschedule(model); clearRescheduleReference(); form.replaceChildren(); showToast('บันทึกการเลื่อนนัดแล้ว', 'success'); }
    catch (reason) { if (reason.errors) showFieldErrors(reason.errors, form); showToast(reason.message || 'ไม่สามารถเลื่อนนัดได้', 'error'); }
    finally { submit.disabled = false; setLoading(loading, false); }
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
