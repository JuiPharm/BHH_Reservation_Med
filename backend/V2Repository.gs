/**
 * Repository helpers for the Drug Reservation Database (v2).
 * These functions never read SPREADSHEET_ID / the v1 database.
 */
function openV2Spreadsheet_() {
  const id = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID_V2') || '').trim();
  if (!id) throw new Error('SPREADSHEET_ID_V2 is not configured.');
  return SpreadsheetApp.openById(id);
}

function getV2SheetOrThrow_(sheetName) {
  const sheet = openV2Spreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Unknown v2 sheet: ' + sheetName);
  return sheet;
}

function getV2HeaderMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) throw new Error('V2 sheet has no headers: ' + sheet.getName());
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return headers.reduce(function (map, header, index) {
    const key = String(header || '').trim();
    if (key) map[key] = index + 1;
    return map;
  }, {});
}

function readV2Records_(sheetName, options) {
  const sheet = getV2SheetOrThrow_(sheetName);
  const headers = getV2HeaderMap_(sheet);
  const names = Object.keys(headers);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  let records = values.map(function (row) {
    return names.reduce(function (record, name) {
      record[name] = row[headers[name] - 1];
      return record;
    }, {});
  });
  if (options && typeof options.predicate === 'function') records = records.filter(options.predicate);
  if (options && Object.prototype.hasOwnProperty.call(options, 'limit')) {
    records = records.slice(0, Math.max(0, Number(options.limit) || 0));
  }
  return records;
}

function appendV2Records_(sheetName, records) {
  const rows = Array.isArray(records) ? records : [];
  if (!rows.length) return { startRow: null, rowCount: 0 };
  const sheet = getV2SheetOrThrow_(sheetName);
  const headers = getV2HeaderMap_(sheet);
  const headerNames = Object.keys(headers).sort(function (a, b) { return headers[a] - headers[b]; });
  const values = rows.map(function (record) {
    return headerNames.map(function (header) {
      return safeV2SheetValue_(record && record[header]);
    });
  });
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(startRow, 1, values.length, headerNames.length).setValues(values);
  return { startRow: startRow, rowCount: values.length };
}

function updateV2RecordByKey_(sheetName, keyName, keyValue, updates) {
  const sheet = getV2SheetOrThrow_(sheetName);
  const headers = getV2HeaderMap_(sheet);
  const keyColumn = headers[keyName];
  if (!keyColumn) throw new Error('Unknown v2 key column: ' + keyName);
  const unknown = Object.keys(updates || {}).filter(function (field) { return !headers[field]; });
  if (unknown.length) throw new Error('Unknown v2 update columns: ' + unknown.join(', '));
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const keys = sheet.getRange(2, keyColumn, lastRow - 1, 1).getDisplayValues();
  const index = keys.findIndex(function (row) { return String(row[0]) === String(keyValue); });
  if (index < 0) return null;
  const rowNumber = index + 2;
  Object.keys(updates || {}).forEach(function (field) {
    sheet.getRange(rowNumber, headers[field]).setValue(safeV2SheetValue_(updates[field]));
  });
  return readV2RecordAtRow_(sheet, rowNumber, headers);
}

function readV2RecordAtRow_(sheet, rowNumber, headers) {
  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  return Object.keys(headers).reduce(function (record, header) {
    record[header] = row[headers[header] - 1];
    return record;
  }, {});
}

function getV2Config_(key, fallbackValue) {
  const rows = readV2Records_('M_SystemConfig', {
    predicate: function (row) { return String(row.ConfigKey || '') === String(key); },
    limit: 1,
  });
  return rows.length ? rows[0].ConfigValue : fallbackValue;
}

function safeV2SheetValue_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) return "'" + value;
  return value;
}
