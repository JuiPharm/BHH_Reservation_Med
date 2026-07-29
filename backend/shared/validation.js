'use strict';

const { MASTER_DATA_DEFAULTS } = require('./constants');

const HN_PATTERN = /^07-\d{2}-\d{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const VALIDATION_LIMITS = Object.freeze({
  StaffID: 64,
  PatientName: 200,
  DepartmentCode: 64,
  RequiredDate: 10,
  PatientPhone: 32,
  PatientEmail: 254,
  Notes: 2000,
  OrderItemID: 128,
  MedicationCode: 64,
  CategoryCode: 64,
  MedicationName: 200,
  Instructions: 1000,
  ItemNotes: 2000,
  Unit: 64,
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateHn(value) {
  return typeof value === 'string' && HN_PATTERN.test(value.trim());
}

function addError(errors, field, message) {
  errors.push(Object.freeze({ field, message }));
}

function activeCodeSet(masterData, keys) {
  const sources = keys.flatMap((key) => {
    const source = masterData && masterData[key];
    return Array.isArray(source) ? source : [];
  });
  return new Set(sources
    .filter((entry) => entry && entry.Active !== false && entry.IsActive !== false && entry.active !== false)
    .map((entry) => normalizeString(entry.Code || entry.code || entry.DepartmentCode || entry.MedicationCode || entry.CategoryCode))
    .filter(Boolean));
}

function validateActiveCode(errors, field, value, values, label) {
  const normalized = normalizeString(value);
  if (!normalized) {
    addError(errors, field, `${label} is required`);
  } else if (values.size === 0 || !values.has(normalized)) {
    addError(errors, field, `${label} is unavailable or inactive`);
  }
}

function validateTextLength(errors, field, value, limit) {
  if (value == null || value === '') return;
  if (typeof value !== 'string') {
    addError(errors, field, `${field} must be a string`);
  } else if (value.length > limit) {
    addError(errors, field, `${field} must not exceed ${limit} characters`);
  }
}

function isValidCalendarDate(value) {
  const dateText = normalizeString(value);
  if (!DATE_PATTERN.test(dateText)) return false;
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateOrderPayload(payload, masterData = MASTER_DATA_DEFAULTS, options = {}) {
  const errors = [];
  const order = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

  if (!validateHn(order.HN)) addError(errors, 'HN', 'HN must use the format 07-00-000000');
  if ('StaffID' in order && typeof order.StaffID !== 'string') addError(errors, 'StaffID', 'StaffID must be a string');
  if (!normalizeString(order.PatientName)) addError(errors, 'PatientName', 'Patient name is required');
  if (typeof order.StaffID === 'string') validateTextLength(errors, 'StaffID', order.StaffID, VALIDATION_LIMITS.StaffID);
  validateTextLength(errors, 'PatientName', order.PatientName, VALIDATION_LIMITS.PatientName);
  validateTextLength(errors, 'PatientPhone', order.PatientPhone, VALIDATION_LIMITS.PatientPhone);
  validateTextLength(errors, 'PatientEmail', order.PatientEmail, VALIDATION_LIMITS.PatientEmail);
  validateTextLength(errors, 'Notes', order.Notes, VALIDATION_LIMITS.Notes);
  validateTextLength(errors, 'DepartmentCode', order.DepartmentCode, VALIDATION_LIMITS.DepartmentCode);
  if (!isValidCalendarDate(order.RequiredDate)) addError(errors, 'RequiredDate', 'RequiredDate must be a valid YYYY-MM-DD calendar date');

  const departmentCodes = activeCodeSet(masterData, ['departments', 'Departments', 'departmentCodes']);
  validateActiveCode(errors, 'DepartmentCode', order.DepartmentCode, departmentCodes, 'Department');

  const items = Array.isArray(order.Items) ? order.Items : (Array.isArray(order.items) ? order.items : null);
  if (!items || items.length === 0) {
    addError(errors, 'Items', 'At least one medication item is required');
  } else {
    const medicationCodes = activeCodeSet(masterData, ['medications', 'Medications', 'medicationCodes']);
    const categoryCodes = activeCodeSet(masterData, ['medicationCategories', 'MedicationCategories', 'categories', 'CategoryCodes']);
    const seenIds = new Set();
    items.forEach((item, index) => {
      const entry = item && typeof item === 'object' ? item : {};
      const prefix = `Items[${index}]`;
      const itemId = normalizeString(entry.OrderItemID || entry.orderItemId);
      if (itemId) {
        if (seenIds.has(itemId)) addError(errors, `${prefix}.OrderItemID`, 'Order item ID must be unique');
        seenIds.add(itemId);
      }
      validateTextLength(errors, `${prefix}.OrderItemID`, entry.OrderItemID || entry.orderItemId, VALIDATION_LIMITS.OrderItemID);
      validateTextLength(errors, `${prefix}.MedicationCode`, entry.MedicationCode || entry.medicationCode, VALIDATION_LIMITS.MedicationCode);
      validateTextLength(errors, `${prefix}.CategoryCode`, entry.CategoryCode || entry.categoryCode, VALIDATION_LIMITS.CategoryCode);
      validateTextLength(errors, `${prefix}.MedicationName`, entry.MedicationName, VALIDATION_LIMITS.MedicationName);
      validateTextLength(errors, `${prefix}.Instructions`, entry.Instructions, VALIDATION_LIMITS.Instructions);
      validateTextLength(errors, `${prefix}.Notes`, entry.Notes, VALIDATION_LIMITS.ItemNotes);
      validateTextLength(errors, `${prefix}.Unit`, entry.Unit, VALIDATION_LIMITS.Unit);
      validateActiveCode(errors, `${prefix}.MedicationCode`, entry.MedicationCode || entry.medicationCode, medicationCodes, 'Medication');
      validateActiveCode(errors, `${prefix}.CategoryCode`, entry.CategoryCode || entry.categoryCode, categoryCodes, 'Medication category');
      const quantity = entry.Quantity === '' ? NaN : Number(entry.Quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) addError(errors, `${prefix}.Quantity`, 'Quantity must be a finite positive number');
    });
  }

  const persistedItems = Array.isArray(options.persistedItems) ? options.persistedItems : [];
  if (persistedItems.length > 0 && items) {
    const proposedIds = new Set(items.map((item) => normalizeString(item && (item.OrderItemID || item.orderItemId))).filter(Boolean));
    const missingSubmittedItem = persistedItems.some((item) => {
      const id = normalizeString(item && (item.OrderItemID || item.orderItemId));
      const status = normalizeString(item && item.Status);
      return id && status !== 'DRAFT' && !proposedIds.has(id);
    });
    if (missingSubmittedItem) addError(errors, 'Items', 'Persisted submitted items cannot be removed');
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

module.exports = Object.freeze({
  HN_PATTERN,
  DATE_PATTERN,
  VALIDATION_LIMITS,
  normalizeString,
  isValidCalendarDate,
  validateHn,
  validateOrderPayload,
});
