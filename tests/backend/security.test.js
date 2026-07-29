const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  neutralizeFormula,
  maskHn,
  maskPatientName,
  constantTimeEqual,
} = require('../../backend/shared/security');

test('sheet formulas and HTML are neutralized', () => {
  assert.equal(neutralizeFormula('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(neutralizeFormula('+1'), "'+1");
  assert.equal(neutralizeFormula('-1'), "'-1");
  assert.equal(neutralizeFormula('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(neutralizeFormula('  =not-a-formula'), '  =not-a-formula');
  assert.equal(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(escapeHtml(`&\"'`), '&amp;&quot;&#39;');
});

test('masking preserves only the minimum useful patient identifiers', () => {
  assert.equal(maskHn('07-01-000001'), '07-**-***001');
  assert.equal(maskHn('bad'), '***');
  assert.equal(maskPatientName('Ada Lovelace'), 'A** L*******');
  assert.equal(maskPatientName('Madonna'), 'M******');
  assert.equal(maskPatientName(''), '***');
});

test('constant-time comparison rejects different types and lengths', () => {
  assert.equal(constantTimeEqual('token', 'token'), true);
  assert.equal(constantTimeEqual('token', 'other'), false);
  assert.equal(constantTimeEqual('token', 'short'), false);
  assert.equal(constantTimeEqual('token', null), false);
});
