import { apiRequest, createRequestId } from './api.js';
import { confirmAction, setLoading, showFieldErrors, showToast } from './ui.js';

const AMBIGUOUS_FAILURES = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE']);
const actionRequestIds = new Map();
function dataOf(response) { return response && response.data ? response.data : response; }
function ambiguous(error) { return AMBIGUOUS_FAILURES.has(String(error && error.errorCode || '')); }
function invalid(errors) { const error = new Error('ข้อมูลการตอบรับไม่ถูกต้อง'); error.errorCode = 'VALIDATION_ERROR'; error.errors = Object.entries(errors).map(([field, message]) => ({ field, message })); return error; }
function operationKey(action, payload) { return `${action}:${JSON.stringify(payload)}`; }

export function tokenFromSearch(search = '') {
  return String(new URLSearchParams(search).get('token') || '').trim();
}

export async function loadAppointmentAction(token, request = apiRequest) {
  return dataOf(await request('GET_APPOINTMENT_ACTION', { token: String(token || '').trim() }, { method: 'GET' }));
}

export function noShowReasonOptions(model) {
  const entries = model && Array.isArray(model.noShowReasons) ? model.noShowReasons : [];
  return entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)).map((entry) => {
    const code = entry.code == null ? '' : String(entry.code);
    const label = entry.label == null || !String(entry.label).trim() ? code : String(entry.label);
    return { code, label };
  }).filter((entry) => !!entry.code.trim());
}

function renderNoShowReasonOptions(select, model) {
  const options = noShowReasonOptions(model);
  select.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'เลือกเหตุผล'; select.append(blank);
  options.forEach((entry) => { const option = document.createElement('option'); option.value = entry.code; option.textContent = entry.label; select.append(option); });
  select.disabled = options.length === 0;
  return options.length > 0;
}

export function validateAppointmentAction(model) {
  const value = model && typeof model === 'object' ? model : {};
  const errors = {};
  if (!String(value.token || '').trim()) errors.token = 'ลิงก์นัดไม่ถูกต้อง';
  const action = String(value.actionType || '').toUpperCase();
  if (!['RECEIVED', 'NO_SHOW'].includes(action)) errors.actionType = 'การดำเนินการไม่ถูกต้อง';
  if (action === 'NO_SHOW') {
    if (!String(value.reasonCode || '').trim()) errors.reasonCode = 'เลือกเหตุผลที่ไม่มาตามนัด';
    if (String(value.reasonCode || '').trim().toUpperCase() === 'OTHER' && !String(value.reasonDetail || '').trim()) errors.reasonDetail = 'ระบุรายละเอียดเหตุผล';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export async function confirmAppointmentAction(model, request = apiRequest, confirm = confirmAction, requestIdFactory = createRequestId) {
  const validation = validateAppointmentAction(model);
  if (!validation.valid) throw invalid(validation.errors);
  if (!await confirm({ title: 'ยืนยันการตอบรับนัด', message: 'ยืนยันการดำเนินการนี้หรือไม่', confirmLabel: 'ยืนยัน' })) return null;
  const action = String(model.actionType).toUpperCase();
  const payload = action === 'NO_SHOW'
    ? { token: String(model.token).trim(), reasonCode: String(model.reasonCode == null ? '' : model.reasonCode), reasonDetail: String(model.reasonDetail || '').trim() }
    : { token: String(model.token).trim() };
  const requestAction = action === 'NO_SHOW' ? 'SUBMIT_PATIENT_NO_SHOW' : 'CONFIRM_PATIENT_RECEIVED';
  const key = operationKey(requestAction, payload);
  const requestId = actionRequestIds.get(key) || requestIdFactory();
  actionRequestIds.set(key, requestId);
  try {
    const result = dataOf(await request(requestAction, payload, { requestId }));
    actionRequestIds.delete(key);
    return result;
  } catch (error) {
    if (!ambiguous(error)) actionRequestIds.delete(key);
    throw error;
  }
}

function actionModel(form, token, action) {
  return { token, actionType: action, reasonCode: form.elements.reasonCode ? form.elements.reasonCode.value : '', reasonDetail: form.elements.reasonDetail ? form.elements.reasonDetail.value : '' };
}

function noShowFields(form, visible) {
  const panel = form.querySelector('[data-no-show-fields]');
  panel.hidden = !visible;
  panel.querySelectorAll('select, input').forEach((input) => { input.disabled = !visible; });
}

async function initialize() {
  const root = document.getElementById('appointment-action');
  if (!root) return;
  const token = tokenFromSearch(window.location.search);
  const form = document.getElementById('appointment-action-form');
  const loading = document.getElementById('page-loading');
  const error = document.getElementById('page-error');
  let action = '';
  setLoading(loading, true, 'กำลังตรวจสอบลิงก์นัด');
  try {
    const detail = await loadAppointmentAction(token);
    action = String(detail.actionType || '').toUpperCase();
    document.getElementById('appointment-date').textContent = String(detail.appointmentDate || '—');
    document.getElementById('appointment-mode').textContent = action === 'NO_SHOW' ? 'แจ้งไม่มาตามนัด' : 'ยืนยันรับยา';
    if (detail.requiresReason && !renderNoShowReasonOptions(form.elements.reasonCode, detail)) throw new Error('ไม่มีเหตุผลที่ไม่มาตามนัดที่ใช้งานได้');
    noShowFields(form, Boolean(detail.requiresReason));
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname);
  } catch (reason) { error.textContent = reason.message || 'ลิงก์นัดไม่สามารถใช้งานได้'; form.querySelector('button').disabled = true; }
  finally { setLoading(loading, false); }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const model = actionModel(form, token, action);
    const validation = validateAppointmentAction(model);
    if (!validation.valid) { showFieldErrors(validation.errors, form); return; }
    submit.disabled = true; setLoading(loading, true, 'กำลังบันทึกการตอบรับ');
    try {
      const result = await confirmAppointmentAction(model);
      if (result) { form.replaceChildren(); showToast('บันทึกการตอบรับแล้ว', 'success'); }
    }
    catch (reason) { if (reason.errors) showFieldErrors(reason.errors, form); showToast(reason.message || 'ไม่สามารถบันทึกได้', 'error'); }
    finally { submit.disabled = false; setLoading(loading, false); }
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
