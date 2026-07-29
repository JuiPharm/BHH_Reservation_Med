/** Header-based repository helpers. All data access uses whole ranges. */
function getSheetOrThrow_(sheetName) {
  const sheet = openConfiguredSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Unknown sheet: ' + sheetName);
  return sheet;
}

function readRecords_(sheetName, options) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const headerNames = Object.keys(headers);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || !lastColumn) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const requestedFields = options && options.fields ? options.fields : headerNames;
  const records = values.map(function (row) {
    const record = {};
    requestedFields.forEach(function (field) {
      const column = headers[field];
      if (column) record[field] = row[column - 1];
    });
    return record;
  });
  const filtered = options && typeof options.predicate === 'function' ? records.filter(options.predicate) : records;
  const hasLimit = options && Object.prototype.hasOwnProperty.call(options, 'limit');
  const limit = hasLimit ? Math.max(0, options.limit) : filtered.length;
  return filtered.slice(0, limit);
}

function appendRecords_(sheetName, records) {
  if (!records || !records.length) return { startRow: null, rowCount: 0 };
  const sheet = getSheetOrThrow_(sheetName);
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  if (!headers.length) throw new Error('Sheet has no headers: ' + sheetName);
  const rows = records.map(function (record) {
    return headers.map(function (header) { return toSafeSheetValue_(record[String(header || '').trim()]); });
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
  return { startRow: startRow, rowCount: rows.length };
}

function updateRecordByKey_(sheetName, keyName, keyValue, updates) {
  const sheet = getSheetOrThrow_(sheetName);
  const headerMap = getHeaderMap_(sheet);
  const keyColumn = headerMap[keyName];
  if (!keyColumn) throw new Error('Unknown key column: ' + keyName);
  const unknownFields = Object.keys(updates || {}).filter(function (field) { return !headerMap[field]; });
  if (unknownFields.length) throw new Error('Unknown update columns: ' + unknownFields.join(', '));
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const keyValues = sheet.getRange(2, keyColumn, lastRow - 1, 1).getDisplayValues();
  const matchIndex = keyValues.findIndex(function (row) { return row[0] === String(keyValue); });
  if (matchIndex < 0) return null;
  const rowNumber = matchIndex + 2;
  const updateEntries = Object.keys(updates || {}).map(function (field) {
    return { column: headerMap[field], value: toSafeSheetValue_(updates[field]) };
  }).sort(function (left, right) {
    return left.column - right.column;
  });
  writeContiguousUpdateRanges_(sheet, rowNumber, updateEntries);
  return readRecordAtRow_(sheet, rowNumber, headerMap);
}

function updateRecordByCompositeKey_(sheetName, keyValues, updates) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const keys = keyValues && typeof keyValues === 'object' ? Object.keys(keyValues) : [];
  if (!keys.length || keys.some(function (key) { return !headers[key]; })) throw new Error('Unknown composite key column.');
  const rows = readRecords_(sheetName);
  const matches = rows.map(function (row, index) { return { row: row, rowNumber: index + 2 }; }).filter(function (entry) {
    return keys.every(function (key) { return String(entry.row[key] || '') === String(keyValues[key] || ''); });
  });
  if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
  const unknown = Object.keys(updates || {}).filter(function (field) { return !headers[field]; });
  if (unknown.length) throw new Error('Unknown update columns: ' + unknown.join(', '));
  const entries = Object.keys(updates || {}).map(function (field) { return { column: headers[field], value: toSafeSheetValue_(updates[field]) }; }).sort(function (a, b) { return a.column - b.column; });
  writeContiguousUpdateRanges_(sheet, matches[0].rowNumber, entries);
  return readRecordAtRow_(sheet, matches[0].rowNumber, headers);
}

function batchUpdateRecordsByKeys_(sheetName, keyName, records) {
  const updates = Array.isArray(records) ? records : [];
  if (!updates.length) return [];
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaderMap_(sheet);
  const keyColumn = headers[keyName];
  if (!keyColumn) throw new Error('Unknown key column: ' + keyName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Batch update keys were not found.');
  const keyRows = sheet.getRange(2, keyColumn, lastRow - 1, 1).getDisplayValues();
  const rowByKey = {};
  keyRows.forEach(function (row, index) { const key = String(row[0]); if (key) rowByKey[key] = index + 2; });
  const rowNumbers = updates.map(function (entry) {
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'keyValue')) throw new Error('Batch update requires keyValue.');
    const row = rowByKey[String(entry.keyValue)];
    if (!row) throw new Error('Batch update key was not found.');
    const unknown = Object.keys(entry.updates || {}).filter(function (field) { return !headers[field]; });
    if (unknown.length) throw new Error('Unknown update columns: ' + unknown.join(', '));
    return row;
  });
  if (new Set(rowNumbers).size !== rowNumbers.length) throw new Error('Batch update keys must be unique.');
  const columns = updates.reduce(function (all, entry) { return all.concat(Object.keys(entry.updates || {}).map(function (field) { return headers[field]; })); }, []);
  const firstRow = Math.min.apply(null, rowNumbers), lastTargetRow = Math.max.apply(null, rowNumbers);
  const firstColumn = Math.min.apply(null, columns), lastColumn = Math.max.apply(null, columns);
  const range = sheet.getRange(firstRow, firstColumn, lastTargetRow - firstRow + 1, lastColumn - firstColumn + 1);
  const values = range.getValues();
  const formulas = range.getFormulas();
  formulas.forEach(function (row, rowIndex) { row.forEach(function (formula, columnIndex) { if (formula) values[rowIndex][columnIndex] = formula; }); });
  updates.forEach(function (entry, index) {
    const rowOffset = rowNumbers[index] - firstRow;
    Object.keys(entry.updates || {}).forEach(function (field) { values[rowOffset][headers[field] - firstColumn] = toSafeSheetValue_(entry.updates[field]); });
  });
  range.setValues(values);
  return rowNumbers.map(function (rowNumber) { return readRecordAtRow_(sheet, rowNumber, headers); });
}

function writeContiguousUpdateRanges_(sheet, rowNumber, entries) {
  let group = [];
  entries.forEach(function (entry) {
    if (group.length && entry.column !== group[group.length - 1].column + 1) {
      writeUpdateRange_(sheet, rowNumber, group);
      group = [];
    }
    group.push(entry);
  });
  if (group.length) writeUpdateRange_(sheet, rowNumber, group);
}

function writeUpdateRange_(sheet, rowNumber, entries) {
  const firstColumn = entries[0].column;
  sheet.getRange(rowNumber, firstColumn, 1, entries.length).setValues([entries.map(function (entry) { return entry.value; })]);
}

function readRecordAtRow_(sheet, rowNumber, headerMap) {
  const lastColumn = sheet.getLastColumn();
  const row = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
  return recordFromRow_(row, headerMap);
}

function recordFromRow_(row, headerMap) {
  return Object.keys(headerMap).reduce(function (record, header) {
    record[header] = row[headerMap[header] - 1];
    return record;
  }, {});
}

function toSafeSheetValue_(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : null;
  return text && /^[=+\-@]/.test(text) ? "'" + text : value;
}
