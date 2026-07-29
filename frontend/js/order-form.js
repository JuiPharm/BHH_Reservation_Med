import { apiRequest, createRequestId } from './api.js';
import { loadMasterData } from './master-data.js';
import { appendMedicationItem, serializeMedicationItems } from './medication-items.js';
import { formatHnInput, validateOrderForm } from './validation.js';
import { clearFieldError, setLoading, showFieldErrors, showToast } from './ui.js';

let submitting = false;

function requestError() {
  const error = new Error('กำลังส่งคำขออยู่');
  error.code = 'SUBMISSION_IN_PROGRESS';
  return error;
}

function createPayload(model) {
  return {
    RequesterPhone: String(model.RequesterPhone || '').trim(), HN: String(model.HN || '').trim(), PatientName: String(model.PatientName || '').trim(),
    WardClinic: String(model.WardClinic || '').trim(), RequiredDate: String(model.RequiredDate || '').trim(), Priority: String(model.Priority || '').trim(),
    Items: (model.Items || []).map(({ GenericName, BrandName, Strength, DosageForm, RequestedQuantity, Unit, Prescriber }) => ({ GenericName, BrandName, Strength, DosageForm, RequestedQuantity: Number(RequestedQuantity), Unit, Prescriber })),
  };
}

export async function submitOrder(model, clientRequestId, request = apiRequest) {
  if (submitting) throw requestError();
  submitting = true;
  try {
    const result = await request('CREATE_ORDER', createPayload(model), { requestId: clientRequestId });
    return result && result.data ? result.data : result;
  } finally {
    submitting = false;
  }
}

function formModel(form) {
  return {
    RequesterPhone: form.elements.RequesterPhone.value, HN: form.elements.HN.value, PatientName: form.elements.PatientName.value,
    WardClinic: form.elements.WardClinic.value, RequiredDate: form.elements.RequiredDate.value, Priority: form.elements.Priority.value,
    Items: serializeMedicationItems(form.querySelector('[data-medication-items]')),
  };
}

function addOptions(select, entries) {
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'เลือก';
  select.append(placeholder);
  entries.forEach((entry) => {
    const option = document.createElement('option');
    option.value = String(entry.Code || '');
    option.textContent = String(entry.DisplayName || entry.Code || '');
    select.append(option);
  });
}

async function initialize() {
  const form = document.getElementById('order-form');
  if (!form) return;
  const loading = document.getElementById('page-loading');
  const items = form.querySelector('[data-medication-items]');
  const submit = form.querySelector('[type="submit"]');
  let masterData;
  try {
    setLoading(loading, true, 'กำลังโหลดข้อมูลแบบฟอร์ม');
    masterData = await loadMasterData(['DOSAGE_FORM', 'UNIT', 'PRIORITY']);
    addOptions(form.elements.Priority, masterData.PRIORITY || []);
    appendMedicationItem(items, {}, masterData);
  } catch (error) {
    showToast(error.message || 'ไม่สามารถโหลดข้อมูลแบบฟอร์ม', 'error');
    submit.disabled = true;
    return;
  } finally { setLoading(loading, false); }
  form.elements.HN.addEventListener('input', () => { form.elements.HN.value = formatHnInput(form.elements.HN.value); clearFieldError('HN', form); });
  form.querySelector('[data-add-medication]').addEventListener('click', () => appendMedicationItem(items, {}, masterData));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const model = formModel(form);
    const validation = validateOrderForm(model, masterData);
    if (!validation.valid) { showFieldErrors(validation.errors, form); return; }
    const requestId = form.dataset.requestId || createRequestId();
    form.dataset.requestId = requestId;
    submit.disabled = true;
    setLoading(loading, true, 'กำลังส่งคำขอ');
    try {
      const result = await submitOrder(model, requestId);
      form.dataset.requestId = '';
      showToast(`บันทึกคำขอ ${result.OrderID || ''} แล้ว`, 'success');
      window.location.assign(`order-detail.html?orderId=${encodeURIComponent(result.OrderID || '')}`);
    } catch (error) {
      if (error.errors) showFieldErrors(error.errors, form);
      showToast(error.message || 'ไม่สามารถส่งคำขอได้', 'error');
    } finally { submit.disabled = false; setLoading(loading, false); }
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
