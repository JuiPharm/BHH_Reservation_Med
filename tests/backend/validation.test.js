const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VALIDATION_LIMITS,
  validateHn,
  validateOrderPayload,
} = require('../../backend/shared/validation');

const masterData = Object.freeze({
  departments: [{ DepartmentCode: 'ER', Active: true }],
  medicationCategories: [{ Code: 'ANTIBIOTIC', Active: true }],
  medications: [{ Code: 'AMOX', Active: true }],
});

function validPayload(overrides = {}) {
  return {
    HN: '07-01-000001',
    PatientName: 'Ada Lovelace',
    DepartmentCode: 'ER',
    RequiredDate: '2026-07-19',
    Items: [{ OrderItemID: 'ITEM-1', MedicationCode: 'AMOX', CategoryCode: 'ANTIBIOTIC', Quantity: '2' }],
    ...overrides,
  };
}

test('HN preserves zeroes and rejects malformed input', () => {
  assert.equal(validateHn('07-01-000001'), true);
  for (const value of ['0712123456', '07-1-123456', '07-AA-123456', 701000001, null]) {
    assert.equal(validateHn(value), false);
  }
});

test('valid order payload accepts active master data and positive numeric item quantity', () => {
  assert.deepEqual(validateOrderPayload(validPayload(), masterData), { valid: true, errors: [] });
});

test('order payload returns field-specific errors without coercing HN or StaffID', () => {
  const result = validateOrderPayload(validPayload({ HN: 701000001, StaffID: 7 }), masterData);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), ['HN', 'StaffID']);
});

test('order payload rejects inactive codes and invalid item quantities using item field paths', () => {
  const result = validateOrderPayload(validPayload({
    DepartmentCode: 'WARD',
    Items: [{ MedicationCode: 'NOPE', CategoryCode: 'NONE', Quantity: 'Infinity' }],
  }), masterData);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), [
    'DepartmentCode',
    'Items[0].MedicationCode',
    'Items[0].CategoryCode',
    'Items[0].Quantity',
  ]);
});

test('order payload rejects empty item arrays and omission of persisted submitted items', () => {
  const empty = validateOrderPayload(validPayload({ Items: [] }), masterData);
  const omitted = validateOrderPayload(validPayload({ Items: [{ OrderItemID: 'ITEM-2', MedicationCode: 'AMOX', CategoryCode: 'ANTIBIOTIC', Quantity: 1 }] }), masterData, {
    persistedItems: [{ OrderItemID: 'ITEM-1', Status: 'SUBMITTED' }],
  });

  assert.equal(empty.valid, false);
  assert.deepEqual(empty.errors.map((error) => error.field), ['Items']);
  assert.equal(omitted.valid, false);
  assert.deepEqual(omitted.errors.map((error) => error.field), ['Items']);
});

test('order payload fails closed when active master data is unavailable', () => {
  const result = validateOrderPayload(validPayload(), {});

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), [
    'DepartmentCode',
    'Items[0].MedicationCode',
    'Items[0].CategoryCode',
  ]);
});

test('order payload requires a real calendar RequiredDate', () => {
  const missing = validateOrderPayload(validPayload({ RequiredDate: '' }), masterData);
  const malformed = validateOrderPayload(validPayload({ RequiredDate: '2026-02-29' }), masterData);
  const validLeapDay = validateOrderPayload(validPayload({ RequiredDate: '2028-02-29' }), masterData);

  assert.deepEqual(missing.errors.map((error) => error.field), ['RequiredDate']);
  assert.deepEqual(malformed.errors.map((error) => error.field), ['RequiredDate']);
  assert.deepEqual(validLeapDay, { valid: true, errors: [] });
});

test('order payload enforces exported maximum lengths for order and item text fields', () => {
  const result = validateOrderPayload(validPayload({
    PatientName: 'p'.repeat(VALIDATION_LIMITS.PatientName + 1),
    PatientPhone: 'p'.repeat(VALIDATION_LIMITS.PatientPhone + 1),
    PatientEmail: 'p'.repeat(VALIDATION_LIMITS.PatientEmail + 1),
    Notes: 'p'.repeat(VALIDATION_LIMITS.Notes + 1),
    Items: [{
      OrderItemID: 'i'.repeat(VALIDATION_LIMITS.OrderItemID + 1),
      MedicationCode: 'AMOX',
      CategoryCode: 'ANTIBIOTIC',
      Quantity: 1,
      MedicationName: 'm'.repeat(VALIDATION_LIMITS.MedicationName + 1),
      Instructions: 'i'.repeat(VALIDATION_LIMITS.Instructions + 1),
      Notes: 'n'.repeat(VALIDATION_LIMITS.ItemNotes + 1),
      Unit: 'u'.repeat(VALIDATION_LIMITS.Unit + 1),
    }],
  }), masterData);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), [
    'PatientName',
    'PatientPhone',
    'PatientEmail',
    'Notes',
    'Items[0].OrderItemID',
    'Items[0].MedicationName',
    'Items[0].Instructions',
    'Items[0].Notes',
    'Items[0].Unit',
  ]);
});
