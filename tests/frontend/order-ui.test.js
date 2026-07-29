const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const moduleUrl = (name) => pathToFileURL(path.join(root, 'frontend/js', name)).href;

async function orderModules() {
  const [validation, items, form, ui] = await Promise.all([
    import(moduleUrl('validation.js')),
    import(moduleUrl('medication-items.js')),
    import(moduleUrl('order-form.js')),
    import(moduleUrl('ui.js')),
  ]);
  return { validation, items, form, ui };
}

function validOrder() {
  return {
    RequesterPhone: '', HN: '07-12-345678', PatientName: 'Test Patient', WardClinic: 'OPD',
    RequiredDate: '2030-01-15', Priority: 'ROUTINE',
    Items: [{ GenericName: 'Medicine', BrandName: '', Strength: '10 mg', DosageForm: 'TABLET', RequestedQuantity: 2, Unit: 'TABLET', Prescriber: 'Dr Test' }],
  };
}

const masterData = {
  DOSAGE_FORM: [{ Code: 'TABLET', DisplayName: 'Tablet' }],
  UNIT: [{ Code: 'TABLET', DisplayName: 'Tablet' }],
  PRIORITY: [{ Code: 'ROUTINE', DisplayName: 'Routine' }],
};

test('HN input formats unpunctuated digits and preserves a valid HN', async () => {
  const { validation } = await orderModules();
  assert.equal(validation.formatHnInput('0712345678'), '07-12-345678');
  assert.equal(validation.formatHnInput('07-12-345678'), '07-12-345678');
});

test('order validation requires one medication and active dropdown codes', async () => {
  const { validation } = await orderModules();
  const missingItems = validation.validateOrderForm({ ...validOrder(), Items: [] }, masterData);
  const badCode = validation.validateOrderForm({ ...validOrder(), Items: [{ ...validOrder().Items[0], DosageForm: 'UNKNOWN' }] }, masterData);
  assert.equal(missingItems.valid, false);
  assert.ok(missingItems.errors.Items);
  assert.equal(badCode.valid, false);
  assert.ok(badCode.errors['Items[0].DosageForm']);
});

test('order validation rejects non-positive quantity and a missing prescriber', async () => {
  const { validation } = await orderModules();
  const result = validation.validateOrderForm({ ...validOrder(), Items: [{ ...validOrder().Items[0], RequestedQuantity: 0, Prescriber: '' }] }, masterData);
  assert.equal(result.valid, false);
  assert.ok(result.errors['Items[0].RequestedQuantity']);
  assert.ok(result.errors['Items[0].Prescriber']);
});

test('medication items retain supplied client keys and generate a distinct key for another row', async () => {
  const { items } = await orderModules();
  const first = items.createMedicationItem({ clientKey: 'item-a', GenericName: 'Medicine' });
  const second = items.createMedicationItem({ GenericName: 'Medicine' });
  assert.equal(first.clientKey, 'item-a');
  assert.notEqual(second.clientKey, first.clientKey);
});

test('serializing medication rows preserves client key and editable payload fields', async () => {
  const { items } = await orderModules();
  const rows = [{ dataset: { clientKey: 'item-a', orderItemId: 'ORD-1-01' }, fields: {
    GenericName: 'Medicine', BrandName: '', Strength: '10 mg', DosageForm: 'TABLET', RequestedQuantity: '2', Unit: 'TABLET', Prescriber: 'Dr Test',
  } }];
  const container = { querySelectorAll: () => rows };
  assert.deepEqual(items.serializeMedicationItems(container), [{
    clientKey: 'item-a', OrderItemID: 'ORD-1-01', GenericName: 'Medicine', BrandName: '', Strength: '10 mg', DosageForm: 'TABLET', RequestedQuantity: '2', Unit: 'TABLET', Prescriber: 'Dr Test',
  }]);
});

test('submitOrder blocks a concurrent submission and keeps its request id for an explicit retry', async () => {
  const { form } = await orderModules();
  const calls = [];
  let resolveFirst;
  const request = (_action, _payload, options) => {
    calls.push(options.requestId);
    return new Promise((resolve) => { resolveFirst = resolve; });
  };
  const first = form.submitOrder(validOrder(), 'request-1', request);
  await assert.rejects(() => form.submitOrder(validOrder(), 'request-1', request), { code: 'SUBMISSION_IN_PROGRESS' });
  resolveFirst({ data: { OrderID: 'ORD-1' } });
  await first;
  await form.submitOrder(validOrder(), 'request-1', async (_action, _payload, options) => { calls.push(options.requestId); return { data: { OrderID: 'ORD-1' } }; });
  assert.deepEqual(calls, ['request-1', 'request-1']);
});

test('indexed medication errors announce beside their row field and focus the first invalid control', async () => {
  const { ui } = await orderModules();
  const fieldError = { textContent: '' };
  const input = { invalid: '', focused: false, setAttribute: (_name, value) => { input.invalid = value; }, focus: () => { input.focused = true; } };
  const row = {
    querySelector: (selector) => selector.includes('data-medication-field-error') ? fieldError : input,
  };
  const root = {
    querySelectorAll: (selector) => selector === '[data-medication-item]' ? [row] : [],
    querySelector: () => null,
  };
  globalThis.CSS = { escape: (value) => value };
  ui.showFieldErrors({ 'Items[0].Prescriber': 'กรุณาระบุผู้สั่งใช้ยา' }, root);
  assert.equal(fieldError.textContent, 'กรุณาระบุผู้สั่งใช้ยา');
  assert.equal(input.invalid, 'true');
  assert.equal(input.focused, true);
});
