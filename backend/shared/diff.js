'use strict';

const { EDITABLE_ORDER_FIELDS, EDITABLE_ORDER_ITEM_FIELDS } = require('./constants');

function sameValue(left, right) {
  return Object.is(left, right);
}

function getItems(order) {
  if (!order || typeof order !== 'object') return [];
  return Array.isArray(order.Items) ? order.Items : (Array.isArray(order.items) ? order.items : []);
}

function itemId(item) {
  return item && typeof item === 'object' ? String(item.OrderItemID || item.orderItemId || '') : '';
}

function immutableChange(scope, id, field, oldValue, newValue) {
  return Object.freeze({ scope, itemId: id, field, oldValue, newValue });
}

function buildOrderDiff(current, proposed) {
  const previous = current && typeof current === 'object' ? current : {};
  const next = proposed && typeof proposed === 'object' ? proposed : {};
  const changes = [];

  for (const field of EDITABLE_ORDER_FIELDS) {
    if (!sameValue(previous[field], next[field])) {
      changes.push(immutableChange('order', null, field, previous[field], next[field]));
    }
  }

  const previousById = new Map(getItems(previous).map((item) => [itemId(item), item]).filter(([id]) => id));
  const nextById = new Map(getItems(next).map((item) => [itemId(item), item]).filter(([id]) => id));
  for (const [id, item] of previousById) {
    if (!nextById.has(id) && item.Status !== 'DRAFT') {
      throw new Error(`Persisted submitted item ${id} cannot be removed`);
    }
  }

  const ids = [...new Set([...previousById.keys(), ...nextById.keys()])].sort();
  for (const id of ids) {
    const oldItem = previousById.get(id) || {};
    const newItem = nextById.get(id) || {};
    for (const field of EDITABLE_ORDER_ITEM_FIELDS) {
      if (!sameValue(oldItem[field], newItem[field])) {
        changes.push(immutableChange('item', id, field, oldItem[field], newItem[field]));
      }
    }
  }

  changes.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === 'order' ? -1 : 1;
    if (left.scope === 'order') return left.field.localeCompare(right.field);
    return left.itemId.localeCompare(right.itemId) || left.field.localeCompare(right.field);
  });
  return Object.freeze(changes);
}

module.exports = Object.freeze({ buildOrderDiff });
