import { apiRequest, createRequestId } from './api.js';
import { loadMasterData } from './master-data.js';
import { appendMedicationItem, serializeMedicationItems } from './medication-items.js';
import { loadOrderDetail } from './order-detail.js';
import { formatHnInput, validateOrderForm } from './validation.js';
import { setLoading, showFieldErrors, showToast } from './ui.js';

export function versionConflictMessage(error) {
  return error && error.errorCode === 'ORDER_VERSION_CONFLICT'
    ? { reload: true, text: 'ข้อมูลถูกแก้ไขโดยผู้อื่น กรุณาโหลดข้อมูลล่าสุดก่อนลองอีกครั้ง' }
    : { reload: false, text: error && error.message ? error.message : 'ไม่สามารถบันทึกการแก้ไขได้' };
}

function isAmbiguousNetworkFailure(error) {
  return ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE'].includes(String(error && error.errorCode || ''));
}

export function createUpdateSubmitter(request = apiRequest, requestIdFactory = createRequestId) {
  let requestId = '';
  const submit = async (payload) => {
    requestId = requestId || requestIdFactory();
    try {
      const response = await request('UPDATE_ORDER', payload, { requestId });
      requestId = '';
      return response && response.data ? response.data : response;
    } catch (error) {
      if (!isAmbiguousNetworkFailure(error)) requestId = '';
      throw error;
    }
  };
  submit.resetAfterReload = () => { requestId = ''; };
  return submit;
}

function addOptions(select, entries, selected) {
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'เลือก';
  select.append(blank);
  (entries || []).forEach((entry) => {
    const option = document.createElement('option');
    option.value = String(entry.Code || '');
    option.textContent = String(entry.DisplayName || entry.Code || '');
    option.selected = option.value === selected;
    select.append(option);
  });
}

function model(form) {
  return {
    RequesterPhone: form.elements.RequesterPhone.value, HN: form.elements.HN.value, PatientName: form.elements.PatientName.value,
    WardClinic: form.elements.WardClinic.value, RequiredDate: form.elements.RequiredDate.value, Priority: form.elements.Priority.value,
    Items: serializeMedicationItems(form.querySelector('[data-medication-items]')),
  };
}

export function editableOrderValues(order) {
  const value = order && typeof order === 'object' ? order : {};
  return {
    RequesterPhone: String(value.RequesterPhone || ''), HN: String(value.HN || ''),
    PatientName: String(value.PatientName || ''), WardClinic: String(value.WardClinic || ''),
    RequiredDate: String(value.RequiredDate || ''), Priority: String(value.Priority || ''),
  };
}

export function buildUpdatePayload(orderId, expectedVersion, value) {
  return {
    OrderID: orderId, expectedVersion, RequesterPhone: value.RequesterPhone, HN: value.HN, PatientName: value.PatientName,
    WardClinic: value.WardClinic, RequiredDate: value.RequiredDate, Priority: value.Priority,
    Items: value.Items.map(({ OrderItemID, GenericName, BrandName, Strength, DosageForm, RequestedQuantity, Unit, Prescriber }) => ({ ...(OrderItemID ? { OrderItemID } : {}), GenericName, BrandName, Strength, DosageForm, RequestedQuantity: Number(RequestedQuantity), Unit, Prescriber })),
  };
}

async function initialize() {
  const form = document.getElementById('edit-order-form');
  if (!form) return;
  const loading = document.getElementById('page-loading');
  const submit = form.querySelector('[type="submit"]');
  const items = form.querySelector('[data-medication-items]');
  const conflict = document.getElementById('version-conflict');
  const orderId = new URLSearchParams(window.location.search).get('orderId') || '';
  let masterData;
  let version = 0;
  const submitUpdate = createUpdateSubmitter();
  const load = async () => {
    setLoading(loading, true, 'กำลังโหลดคำขอ');
    try {
      const data = await loadOrderDetail(orderId);
      const order = data.order || {};
      version = Number(order.Version);
      const editable = editableOrderValues(order);
      ['RequesterPhone', 'HN', 'PatientName', 'WardClinic', 'RequiredDate'].forEach((field) => { form.elements[field].value = editable[field]; });
      addOptions(form.elements.Priority, masterData.PRIORITY, String(order.Priority || ''));
      items.replaceChildren();
      (data.items || []).forEach((item) => appendMedicationItem(items, item, masterData, { lockPersisted: true }));
      if (!data.items || !data.items.length) appendMedicationItem(items, {}, masterData, { lockPersisted: true });
      conflict.hidden = true;
      submitUpdate.resetAfterReload();
    } catch (error) { showToast(error.message || 'ไม่สามารถโหลดคำขอได้', 'error'); submit.disabled = true; }
    finally { setLoading(loading, false); }
  };
  try { masterData = await loadMasterData(['DOSAGE_FORM', 'UNIT', 'PRIORITY']); await load(); }
  catch (error) { showToast(error.message || 'ไม่สามารถโหลดข้อมูลแบบฟอร์ม', 'error'); submit.disabled = true; }
  form.elements.HN.addEventListener('input', () => { form.elements.HN.value = formatHnInput(form.elements.HN.value); });
  form.querySelector('[data-add-medication]').addEventListener('click', () => appendMedicationItem(items, {}, masterData, { lockPersisted: true }));
  conflict.querySelector('button').addEventListener('click', load);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = model(form);
    const validation = validateOrderForm(value, masterData);
    if (!validation.valid) { showFieldErrors(validation.errors, form); return; }
    submit.disabled = true;
    setLoading(loading, true, 'กำลังบันทึกการแก้ไข');
    try {
      await submitUpdate(buildUpdatePayload(orderId, version, value));
      showToast('บันทึกการแก้ไขแล้ว', 'success');
      window.location.assign(`order-detail.html?orderId=${encodeURIComponent(orderId)}`);
    } catch (error) {
      const message = versionConflictMessage(error);
      if (message.reload) { conflict.hidden = false; conflict.querySelector('p').textContent = message.text; }
      else { if (error.errors) showFieldErrors(error.errors, form); showToast(message.text, 'error'); }
    } finally { submit.disabled = false; setLoading(loading, false); }
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
