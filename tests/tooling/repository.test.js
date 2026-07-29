const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('repository exposes all verification commands', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/**/*.test.js');
  assert.ok(pkg.scripts['check:secrets']);
  assert.ok(pkg.scripts['check:links']);
  assert.ok(pkg.scripts.verify);
});
