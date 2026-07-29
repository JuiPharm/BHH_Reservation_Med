const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canTransitionOrder,
  canTransitionItem,
  deriveReceivingOrderStatus,
} = require('../../backend/shared/status');

const orderMatrix = Object.freeze({
  SUBMITTED: ['UNDER_REVIEW', 'ORDERED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED'],
  UNDER_REVIEW: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'PARTIALLY_CANCELLED', 'CANCEL_REQUESTED', 'CANCELLED'],
  RECEIVED: ['NOTIFIED', 'CANCEL_REQUESTED', 'CANCELLED'],
  NOTIFIED: ['PATIENT_RECEIVED', 'PATIENT_NO_SHOW', 'APPOINTMENT_RESCHEDULED', 'CANCEL_REQUESTED'],
  PATIENT_NO_SHOW: ['APPOINTMENT_RESCHEDULED', 'PATIENT_RECEIVED', 'CANCEL_REQUESTED'],
  APPOINTMENT_RESCHEDULED: ['NOTIFIED', 'PATIENT_RECEIVED', 'PATIENT_NO_SHOW', 'CANCEL_REQUESTED'],
  CANCEL_REQUESTED: ['CANCELLED', 'CANCEL_REJECTED'],
  CANCEL_REJECTED: ['UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'NOTIFIED'],
  PARTIALLY_CANCELLED: ['RECEIVED', 'NOTIFIED', 'COMPLETED'],
  PATIENT_RECEIVED: ['COMPLETED'],
  CANCELLED: [],
  COMPLETED: [],
  REJECTED: [],
});

const itemMatrix = Object.freeze({
  SUBMITTED: ['UNDER_REVIEW', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED'],
  UNDER_REVIEW: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCEL_REQUESTED', 'CANCELLED'],
  RECEIVED: ['COMPLETED', 'CANCEL_REQUESTED', 'CANCELLED'],
  CANCEL_REQUESTED: ['CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
});

test('order transition matrix permits only approved non-restoration transitions', () => {
  const statuses = Object.keys(orderMatrix);
  for (const [from, allowed] of Object.entries(orderMatrix)) {
    for (const to of statuses) {
      const expected = from === 'CANCEL_REJECTED' ? false : allowed.includes(to);
      assert.equal(canTransitionOrder(from, to), expected, `${from} -> ${to}`);
    }
  }
  assert.equal(canTransitionOrder('UNKNOWN', 'ORDERED'), false);
  assert.equal(canTransitionOrder('ORDERED', 'ORDERED'), false);
});

test('submitted item can progress but cannot transition backward or disappear', () => {
  assert.equal(canTransitionItem('SUBMITTED', 'ORDERED'), true);
  assert.equal(canTransitionItem('RECEIVED', 'SUBMITTED'), false);
  assert.equal(canTransitionItem('CANCELLED', 'ORDERED'), false);
});

test('item transition matrix permits only approved non-restoration transitions', () => {
  const statuses = Object.keys(itemMatrix);
  for (const [from, allowed] of Object.entries(itemMatrix)) {
    for (const to of statuses) {
      const expected = from === 'CANCEL_REQUESTED' ? to === 'CANCELLED' : allowed.includes(to);
      assert.equal(canTransitionItem(from, to), expected, `${from} -> ${to}`);
    }
  }
});

test('cancellation restoration requires the exact recorded prior status and handles null options', () => {
  assert.equal(canTransitionOrder('CANCEL_REJECTED', 'NOTIFIED'), false);
  assert.equal(canTransitionOrder('CANCEL_REJECTED', 'NOTIFIED', null), false);
  assert.equal(canTransitionOrder('CANCEL_REJECTED', 'NOTIFIED', { previousStatus: 'NOTIFIED' }), true);
  assert.equal(canTransitionOrder('CANCEL_REJECTED', 'ORDERED', { previousStatus: 'NOTIFIED' }), false);
  assert.equal(canTransitionOrder('CANCEL_REJECTED', 'UNDER_REVIEW', { previousStatus: 'SUBMITTED' }), false);

  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'ORDERED'), false);
  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'ORDERED', null), false);
  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'ORDERED', { previousStatus: 'ORDERED' }), true);
  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'RECEIVED', { previousStatus: 'ORDERED' }), false);
  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'ORDERED', { previousStatus: 'CANCELLED' }), false);
  assert.equal(canTransitionItem('CANCEL_REQUESTED', 'CANCELLED', null), true);
});

test('receiving aggregation derives partial and fully received order states without hiding cancelled items', () => {
  assert.equal(deriveReceivingOrderStatus([{ Status: 'ORDERED' }, { Status: 'PARTIALLY_RECEIVED' }]), 'PARTIALLY_RECEIVED');
  assert.equal(deriveReceivingOrderStatus([{ Status: 'RECEIVED' }, { Status: 'CANCELLED' }]), 'PARTIALLY_CANCELLED');
  assert.equal(deriveReceivingOrderStatus([{ Status: 'RECEIVED' }, { Status: 'RECEIVED' }]), 'RECEIVED');
  assert.equal(deriveReceivingOrderStatus([{ Status: 'CANCELLED' }]), 'CANCELLED');
});

test('receiving aggregation rejects empty or unknown item states', () => {
  assert.equal(deriveReceivingOrderStatus([]), null);
  assert.equal(deriveReceivingOrderStatus([{ Status: 'UNKNOWN' }]), null);
});
