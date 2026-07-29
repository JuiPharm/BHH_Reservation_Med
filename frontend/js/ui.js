export function setLoading(element, active, message = 'กำลังดำเนินการ') {
  if (!element) return;
  element.hidden = !active;
  element.textContent = active ? message : '';
  element.setAttribute('aria-busy', String(Boolean(active)));
}

export function showFieldErrors(errors = {}, root = document) {
  root.querySelectorAll('[data-field-error]').forEach((node) => { node.textContent = ''; });
  root.querySelectorAll('[data-medication-field-error]').forEach((node) => { node.textContent = ''; });
  root.querySelectorAll('[aria-invalid="true"]').forEach((node) => { node.setAttribute('aria-invalid', 'false'); });
  const entries = Array.isArray(errors)
    ? errors.map((error) => [error.field, error.message])
    : Object.entries(errors);
  let first = null;
  for (const [field, message] of entries) {
    const escapedField = CSS.escape(String(field || ''));
    let target = root.querySelector(`[data-field-error="${escapedField}"]`);
    let input = root.querySelector(`[name="${escapedField}"]`);
    const medicationField = /^Items\[(\d+)\]\.([A-Za-z]+)$/.exec(String(field || ''));
    if (!target && medicationField) {
      const row = root.querySelectorAll('[data-medication-item]')[Number(medicationField[1])];
      if (row) {
        const name = CSS.escape(medicationField[2]);
        target = row.querySelector(`[data-medication-field-error="${name}"]`);
        input = row.querySelector(`[name="${name}"]`);
      }
    }
    if (!target) continue;
    target.textContent = String(message || 'ข้อมูลไม่ถูกต้อง');
    if (input) input.setAttribute('aria-invalid', 'true');
    if (!first) first = input;
  }
  if (first) first.focus();
}

export function clearFieldError(field, root = document) {
  const name = CSS.escape(String(field || ''));
  const target = root.querySelector(`[data-field-error="${name}"]`);
  const input = root.querySelector(`[name="${name}"]`);
  if (target) target.textContent = '';
  if (input) input.setAttribute('aria-invalid', 'false');
}

export function showToast(message, type = 'info') {
  const toast = document.getElementById('toast-region');
  if (!toast) return;
  toast.textContent = String(message || '');
  toast.dataset.type = type;
  toast.hidden = !message;
}

export function confirmAction(options = {}) {
  const title = options.title || 'ยืนยันการดำเนินการ';
  const message = options.message || 'ต้องการดำเนินการต่อหรือไม่';
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    const heading = document.createElement('h2');
    const detail = document.createElement('p');
    const form = document.createElement('form');
    const cancel = document.createElement('button');
    const confirm = document.createElement('button');
    heading.textContent = title;
    detail.textContent = message;
    form.method = 'dialog';
    cancel.value = 'cancel';
    cancel.textContent = 'ยกเลิก';
    confirm.value = 'confirm';
    confirm.textContent = options.confirmLabel || 'ยืนยัน';
    form.append(cancel, confirm);
    dialog.append(heading, detail, form);
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
