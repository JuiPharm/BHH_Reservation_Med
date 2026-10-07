const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const router = fs.readFileSync(path.resolve(__dirname, '../../backend/ApiRouter.gs'), 'utf8');
const health = fs.readFileSync(path.resolve(__dirname, '../../backend/V2HealthService.gs'), 'utf8');

test('HEALTH_V2 is a public read-only v2 GET action', () => {
  assert.match(router, /HEALTH_V2:\s*Object\.freeze\(\{\s*auth:\s*false,\s*mutates:\s*false,[^}]*v2:\s*true/);
  assert.match(router, /if \(actionName === 'HEALTH_V2'\) return healthV2_\(\)/);
});

test('health response exposes only deployment and schema readiness flags', () => {
  for (const field of ['healthy', 'apiVersion', 'deploymentReachable', 'databaseConfigured', 'requiredSheetsPresent', 'timestamp']) {
    assert.match(health, new RegExp(field));
  }
  assert.match(health, /T_Users/);
  assert.match(health, /S_Sessions/);
  assert.match(health, /T_Reservations/);
});
