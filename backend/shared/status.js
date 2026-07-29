'use strict';

const {
  ORDER_STATUS,
  ITEM_STATUS,
  ORDER_TRANSITIONS,
  ITEM_TRANSITIONS,
} = require('./constants');

function recordedPreviousStatus(options) {
  return options && typeof options === 'object' ? options.previousStatus : undefined;
}

function canTransitionOrder(from, to, options) {
  const allowed = ORDER_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;
  if (from === ORDER_STATUS.CANCEL_REJECTED) {
    const previousStatus = recordedPreviousStatus(options);
    return previousStatus === to && ORDER_TRANSITIONS[to] && ORDER_TRANSITIONS[to].includes(ORDER_STATUS.CANCEL_REQUESTED);
  }
  return true;
}

function canTransitionItem(from, to, options) {
  const allowed = ITEM_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;
  if (from === ITEM_STATUS.CANCEL_REQUESTED && to !== ITEM_STATUS.CANCELLED) {
    const previousStatus = recordedPreviousStatus(options);
    return previousStatus === to && ITEM_TRANSITIONS[to] && ITEM_TRANSITIONS[to].includes(ITEM_STATUS.CANCEL_REQUESTED);
  }
  return true;
}

function deriveReceivingOrderStatus(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const statuses = items.map((item) => item && item.Status).filter(Boolean);
  if (statuses.length !== items.length) return null;
  if (statuses.some((status) => !Object.values(ITEM_STATUS).includes(status))) return null;
  const all = (status) => statuses.every((value) => value === status);
  const active = statuses.filter((status) => status !== ITEM_STATUS.CANCELLED);
  const receivedOrCompleted = (status) => status === ITEM_STATUS.RECEIVED || status === ITEM_STATUS.COMPLETED;

  if (all(ITEM_STATUS.CANCELLED)) return ORDER_STATUS.CANCELLED;
  if (active.length > 0 && active.every(receivedOrCompleted)) {
    return statuses.length === active.length ? ORDER_STATUS.RECEIVED : ORDER_STATUS.PARTIALLY_CANCELLED;
  }
  if (statuses.some((status) => status === ITEM_STATUS.PARTIALLY_RECEIVED || receivedOrCompleted(status))) {
    return ORDER_STATUS.PARTIALLY_RECEIVED;
  }
  if (statuses.every((status) => status === ITEM_STATUS.UNDER_REVIEW)) return ORDER_STATUS.UNDER_REVIEW;
  if (statuses.every((status) => status === ITEM_STATUS.SUBMITTED)) return ORDER_STATUS.SUBMITTED;
  return ORDER_STATUS.ORDERED;
}

module.exports = Object.freeze({ canTransitionOrder, canTransitionItem, deriveReceivingOrderStatus });
