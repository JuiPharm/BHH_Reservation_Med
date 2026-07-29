const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('batch updates use one matrix write, preserve untouched formulas, and replace targeted formula cells', () => {
  const headers = { OrderItemID: 1, RequestedQuantity: 2, AdminNote: 3 };
  const values = [['item-1', 2, 'existing'], ['item-2', 4, 'existing two']];
  const formulas = [['', '=A2*2', ''], ['', '', '=A3&" note"']];
  let writes = 0;
  let formulaWrites = 0;
  const sheet = {
    getLastRow: () => 3,
    getLastColumn: () => 3,
    getRange(row, column, countRows, countColumns) {
      const rowOffset = row - 2;
      return {
        getDisplayValues: () => values.slice(rowOffset, rowOffset + countRows).map((record) => record.slice(column - 1, column - 1 + countColumns).map(String)),
        getValues: () => values.slice(rowOffset, rowOffset + countRows).map((record) => record.slice(column - 1, column - 1 + countColumns)),
        getFormulas: () => formulas.slice(rowOffset, rowOffset + countRows).map((record) => record.slice(column - 1, column - 1 + countColumns)),
        setValues(matrix) {
          writes += 1;
          matrix.forEach((record, r) => record.forEach((value, c) => {
            values[rowOffset + r][column - 1 + c] = value;
            formulas[rowOffset + r][column - 1 + c] = typeof value === 'string' && value.startsWith('=') ? value : '';
          }));
        },
        getCell() { return { setFormula() { formulaWrites += 1; } }; },
      };
    },
  };
  const context = { Object, String, Math, Set };
  const repo = vm.runInNewContext(`${fs.readFileSync('backend/SheetRepository.gs', 'utf8')}\ngetSheetOrThrow_ = () => sheet; getHeaderMap_ = () => headers; ({ batchUpdateRecordsByKeys_ });`, { ...context, sheet, headers });
  repo.batchUpdateRecordsByKeys_('OrderItems', 'OrderItemID', [
    { keyValue: 'item-1', updates: { AdminNote: 'changed' } },
    { keyValue: 'item-2', updates: { AdminNote: 'replace formula' } },
  ]);
  assert.equal(writes, 1);
  assert.equal(formulaWrites, 0);
  assert.equal(formulas[0][1], '=A2*2');
  assert.equal(formulas[1][2], '');
  assert.equal(values[1][2], 'replace formula');
});
