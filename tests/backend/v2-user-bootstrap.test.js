const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../../backend/V2UserBootstrapService.gs');
const source = fs.readFileSync(sourcePath, 'utf8');

function load(overrides = {}) {
  const props = new Map(Object.entries(overrides.properties || {}));
  const propertyApi = {
    getProperty(key) { return props.has(key) ? props.get(key) : null; },
    setProperty(key, value) { props.set(key, value); },
    deleteProperty(key) { props.delete(key); },
  };
  const sandbox = {
    console: { log() {} },
    PropertiesService: {
      getScriptProperties() { return propertyApi; },
    },
    Utilities: {
      getUuid() { return '12345678-1234-1234-1234-123456789abc'; },
      newBlob(value) { return { getBytes() { return Array.from(Buffer.from(String(value), 'utf8')); } }; },
      base64EncodeWebSafe(bytes) { return Buffer.from(bytes).toString('base64url'); },
      base64DecodeWebSafe(value) { return Array.from(Buffer.from(String(value).replace(/=/g, ''), 'base64url')); },
      computeHmacSha256Signature() { return new Array(32).fill(7); },
    },
    LockService: {
      getScriptLock() { return { waitLock() {}, releaseLock() {} }; },
    },
    SpreadsheetApp: {},
    Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Error, Buffer,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'V2UserBootstrapService.gs' });
  return { sandbox, props };
}

test('bootstrap service is self-contained and does not depend on old SecurityService helpers', () => {
  assert.doesNotMatch(source, /assertProvisionedPinPolicy_\s*\(/);
  assert.doesNotMatch(source, /createPinHash_\s*\(/);
  assert.match(source, /function validateV2BootstrapConfig\s*\(/);
  assert.match(source, /function createV2BootstrapPinHash_\s*\(/);
});

test('canonical bootstrap setting is PIN and old PASSWORD setting is backward compatible', () => {
  const canonical = load({ properties: { V2_BOOTSTRAP_ADMIN_PIN: 'TestPin123' } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(canonical.sandbox.getV2BootstrapPinInfo_(canonical.sandbox.PropertiesService.getScriptProperties()))),
    { present: true, valid: true, legacyNameUsed: false },
  );

  const legacy = load({ properties: { V2_BOOTSTRAP_ADMIN_PASSWORD: 'LegacyPin123' } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(legacy.sandbox.getV2BootstrapPinInfo_(legacy.sandbox.PropertiesService.getScriptProperties()))),
    { present: true, valid: true, legacyNameUsed: true },
  );
});

test('missing and too-short PIN values are rejected before provisioning', () => {
  const missing = load();
  const missingInfo = missing.sandbox.getV2BootstrapPinInfo_(missing.sandbox.PropertiesService.getScriptProperties());
  assert.equal(missingInfo.present, false);
  assert.equal(missingInfo.valid, false);

  const short = load({ properties: { V2_BOOTSTRAP_ADMIN_PIN: '1234567' } });
  const shortInfo = short.sandbox.getV2BootstrapPinInfo_(short.sandbox.PropertiesService.getScriptProperties());
  assert.equal(shortInfo.present, true);
  assert.equal(shortInfo.valid, false);
  assert.throws(() => short.sandbox.assertV2BootstrapPinPolicy_('1234567'), /8 to 128/);
  assert.doesNotThrow(() => short.sandbox.assertV2BootstrapPinPolicy_('12345678'));
});

test('cleanup deletes both temporary credential property names and disables bootstrap', () => {
  const loaded = load({ properties: {
    V2_BOOTSTRAP_ENABLED: 'TRUE',
    V2_BOOTSTRAP_ADMIN_PIN: 'TestPin123',
    V2_BOOTSTRAP_ADMIN_PASSWORD: 'LegacyPin123',
  } });
  loaded.sandbox.cleanupV2BootstrapProperties_();
  assert.equal(loaded.props.has('V2_BOOTSTRAP_ADMIN_PIN'), false);
  assert.equal(loaded.props.has('V2_BOOTSTRAP_ADMIN_PASSWORD'), false);
  assert.equal(loaded.props.get('V2_BOOTSTRAP_ENABLED'), 'FALSE');
});

test('credential hash format matches the existing HMAC-SHA256 v2 contract', () => {
  const secret = Buffer.alloc(32, 1).toString('base64url');
  const loaded = load({ properties: {
    APP_SECRET: secret,
    V2_BOOTSTRAP_ADMIN_PIN: 'TestPin123',
  } });
  const hash = loaded.sandbox.createV2BootstrapPinHash_('TestPin123');
  assert.match(hash, /^HMAC-SHA256\$v2\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
});

test('source contains the verified current Drug Reservation Database header contracts', () => {
  for (const header of [
    'UserID','StaffID','StaffName','DepartmentID','PasswordHash','PasswordAlgorithm',
    'Role','AccountStatus','FailedLoginCount','LockedUntil','ApprovedBy','ApprovedAt','Version',
  ]) assert.match(source, new RegExp("'" + header + "'"));

  for (const header of [
    'AuditID','Timestamp','UserID','StaffID','Action','EntityType','EntityID',
    'OldValueJSON','NewValueJSON','Reason','SessionID','RequestID',
  ]) assert.match(source, new RegExp("'" + header + "'"));
});
