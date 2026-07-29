import { createRequestId } from './api.js';

const FIELDS = ['GenericName', 'BrandName', 'Strength', 'DosageForm', 'RequestedQuantity', 'Unit', 'Prescriber'];

export function createMedicationItem(initial = {}) {
  const item = initial && typeof initial === 'object' ? initial : {};
  return {
    clientKey: typeof item.clientKey === 'string' && item.clientKey ? item.clientKey : createRequestId(),
    ...(typeof item.OrderItemID === 'string' && item.OrderItemID ? { OrderItemID: item.OrderItemID } : {}),
    GenericName: String(item.GenericName || ''), BrandName: String(item.BrandName || ''), Strength: String(item.Strength || ''),
    DosageForm: String(item.DosageForm || ''), RequestedQuantity: item.RequestedQuantity == null ? '' : String(item.RequestedQuantity),
    Unit: String(item.Unit || ''), Prescriber: String(item.Prescriber || ''),
  };
}

function rowValue(row, field) {
  if (row.fields) return String(row.fields[field] == null ? '' : row.fields[field]);
  const input = row.querySelector(`[name="${field}"]`);
  return input ? String(input.value || '') : '';
}

export function serializeMedicationItems(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return [];
  return Array.from(container.querySelectorAll('[data-medication-item], .medication-item')).map((row) => {
    const result = { clientKey: String((row.dataset && row.dataset.clientKey) || '') };
    const orderItemId = String((row.dataset && row.dataset.orderItemId) || '');
    if (orderItemId) result.OrderItemID = orderItemId;
    FIELDS.forEach((field) => { result[field] = rowValue(row, field); });
    return result;
  });
}

function option(select, entry, selected) {
  const node = document.createElement('option');
  node.value = String(entry.Code || '');
  node.textContent = String(entry.DisplayName || entry.Code || '');
  node.selected = node.value === selected;
  select.append(node);
}

function inputFor(field, item, masterData) {
  const input = document.createElement(field === 'DosageForm' || field === 'Unit' ? 'select' : 'input');
  input.name = field;
  input.id = `${item.clientKey}-${field}`;
  if (input.tagName === 'SELECT') {
    option(input, { Code: '', DisplayName: 'เลือก' }, String(item[field] || ''));
    const type = field === 'DosageForm' ? 'DOSAGE_FORM' : 'UNIT';
    (masterData[type] || []).forEach((entry) => option(input, entry, String(item[field] || '')));
  } else {
    input.value = String(item[field] || '');
    if (field === 'RequestedQuantity') { input.type = 'number'; input.min = '0.01'; input.step = 'any'; }
  }
  return input;
}

export function appendMedicationItem(container, initial, masterData = {}, options = {}) {
  const item = createMedicationItem(initial);
  const row = document.createElement('fieldset');
  row.className = 'medication-item';
  row.dataset.medicationItem = 'true';
  row.dataset.clientKey = item.clientKey;
  if (item.OrderItemID) row.dataset.orderItemId = item.OrderItemID;
  const legend = document.createElement('legend');
  legend.textContent = 'รายการยา';
  row.append(legend);
  FIELDS.forEach((field) => {
    const label = document.createElement('label');
    const input = inputFor(field, item, masterData);
    label.htmlFor = input.id;
    label.textContent = field === 'GenericName' ? 'ชื่อสามัญ' : field === 'BrandName' ? 'ชื่อการค้า' : field === 'Strength' ? 'ความแรง' : field === 'DosageForm' ? 'รูปแบบยา' : field === 'RequestedQuantity' ? 'จำนวน' : field === 'Unit' ? 'หน่วย' : 'ผู้สั่งใช้ยา';
    label.append(input);
    const error = document.createElement('span');
    error.dataset.medicationFieldError = field;
    error.setAttribute('role', 'alert');
    label.append(error);
    row.append(label);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary';
  remove.textContent = 'ลบรายการ';
  remove.addEventListener('click', () => { if (container.querySelectorAll('[data-medication-item]').length > 1) row.remove(); });
  if (options.lockPersisted && item.OrderItemID) remove.hidden = true;
  row.append(remove);
  container.append(row);
  return row;
}
