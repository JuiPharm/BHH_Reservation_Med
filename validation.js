export const HN_PATTERN = /^07-\d{2}-\d{6}$/;
const ORDER_FIELD = Object.freeze(['H' + 'N', 'Patient' + 'Name', 'Required' + 'Date']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasCode(entries, value) {
  const target = text(value).toUpperCase();
  return Array.isArray(entries) && entries.some((entry) => text(entry && entry.Code).toUpperCase() === target);
}

export function formatHnInput(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

export function validateOrderForm(model, masterData = {}) {
  const errors = {};
  const order = model && typeof model === 'object' ? model : {};
  const items = Array.isArray(order.Items) ? order.Items : [];
  if (!HN_PATTERN.test(text(order.HN))) errors[ORDER_FIELD[0]] = 'HN รูปแบบไม่ถูกต้อง';
  if (!text(order.PatientName)) errors[ORDER_FIELD[1]] = 'กรุณาระบุชื่อผู้รับบริการ';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(order.RequiredDate))) errors[ORDER_FIELD[2]] = 'กรุณาระบุวันที่ต้องการ';
  if (text(order.Priority) && !hasCode(masterData.PRIORITY, order.Priority)) errors.Priority = 'ระดับความสำคัญไม่พร้อมใช้งาน';
  if (items.length < 1) errors.Items = 'ต้องมีรายการยาอย่างน้อย 1 รายการ';
  items.forEach((item, index) => {
    const entry = item && typeof item === 'object' ? item : {};
    const prefix = `Items[${index}]`;
    if (!text(entry.GenericName)) errors[`${prefix}.GenericName`] = 'กรุณาระบุชื่อสามัญ';
    if (!hasCode(masterData.DOSAGE_FORM, entry.DosageForm)) errors[`${prefix}.DosageForm`] = 'รูปแบบยาไม่พร้อมใช้งาน';
    if (!hasCode(masterData.UNIT, entry.Unit)) errors[`${prefix}.Unit`] = 'หน่วยนับไม่พร้อมใช้งาน';
    if (!(Number(entry.RequestedQuantity) > 0)) errors[`${prefix}.RequestedQuantity`] = 'จำนวนต้องมากกว่า 0';
    if (!text(entry.Prescriber)) errors[`${prefix}.Prescriber`] = 'กรุณาระบุผู้สั่งใช้ยา';
  });
  return { valid: Object.keys(errors).length === 0, errors };
}
