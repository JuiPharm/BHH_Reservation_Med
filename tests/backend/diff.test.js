const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderDiff } = require('../../backend/shared/diff');

function order(items) {
  return {
    OrderID: 'ORD-1',
    HN: '07-01-000001',
    PatientName: 'Ada Lovelace',
    DepartmentCode: 'ER',
    Status: 'SUBMITTED',
    Items: items,
  };
}

test('order diff compares only allowlisted editable fields', () => {
  const changes = buildOrderDiff(order([]), {
    ...order([]),
    PatientName: 'Grace Hopper',
    DepartmentCode: 'ICU',
    Status: 'CANCELLED',
    OrderID: 'ORD-2',
  });

  assert.deepEqual(changes, [
    { scope: 'order', itemId: null, field: 'DepartmentCode', oldValue: 'ER', newValue: 'ICU' },
    { scope: 'order', itemId: null, field: 'PatientName', oldValue: 'Ada Lovelace', newValue: 'Grace Hopper' },
  ]);
  assert.equal(Object.isFrozen(changes), true);
  assert.equal(Object.isFrozen(changes[0]), true);
});

test('item diffs sort by OrderItemID then field name and ignore unallowlisted fields', () => {
  const changes = buildOrderDiff(order([
    { OrderItemID: 'ITEM-2', MedicationCode: 'AMOX', Quantity: 1, Status: 'SUBMITTED' },
    { OrderItemID: 'ITEM-1', MedicationCode: 'AMOX', Quantity: 2, Status: 'SUBMITTED' },
  ]), order([
    { OrderItemID: 'ITEM-1', MedicationCode: 'CIPRO', Quantity: 3, Status: 'CANCELLED' },
    { OrderItemID: 'ITEM-2', MedicationCode: 'AMOX', Quantity: 2, Status: 'RECEIVED' },
  ]));

  assert.deepEqual(changes, [
    { scope: 'item', itemId: 'ITEM-1', field: 'MedicationCode', oldValue: 'AMOX', newValue: 'CIPRO' },
    { scope: 'item', itemId: 'ITEM-1', field: 'Quantity', oldValue: 2, newValue: 3 },
    { scope: 'item', itemId: 'ITEM-2', field: 'Quantity', oldValue: 1, newValue: 2 },
  ]);
});

test('order diff rejects removal of persisted submitted item instead of silently omitting it', () => {
  assert.throws(() => buildOrderDiff(order([
    { OrderItemID: 'ITEM-1', MedicationCode: 'AMOX', Quantity: 1, Status: 'SUBMITTED' },
  ]), order([])), /submitted item/i);
});

test('new item differences preserve absent old values for an auditable addition', () => {
  const changes = buildOrderDiff(order([]), order([
    { OrderItemID: 'ITEM-3', MedicationCode: 'AMOX', Quantity: 1 },
  ]));

  assert.deepEqual(changes, [
    { scope: 'item', itemId: 'ITEM-3', field: 'MedicationCode', oldValue: undefined, newValue: 'AMOX' },
    { scope: 'item', itemId: 'ITEM-3', field: 'Quantity', oldValue: undefined, newValue: 1 },
  ]);
});

test('order diff treats null and undefined as distinct values', () => {
  const changes = buildOrderDiff(order([]), { ...order([]), Notes: null });

  assert.deepEqual(changes, [
    { scope: 'order', itemId: null, field: 'Notes', oldValue: undefined, newValue: null },
  ]);
});
