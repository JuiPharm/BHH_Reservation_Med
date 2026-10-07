const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../../backend/V2UserBootstrapService.gs');
const source = fs.readFileSync(sourcePath, 'utf8');
const v2AuthSource = fs.readFileSync(path.resolve(__dirname, '../../backend/V2AuthService.gs'), 'utf8');
const v2SessionSource = fs.readFileSync(path.resolve(__dirname, '../../backend/V2SessionService.gs'), 'utf8');
const v2RepositorySource = fs.readFileSync(path.resolve(__dirname, '../../backend/V2Repository.gs'), 'utf8');
const v2DashboardSource = fs.readFileSync(path.resolve(__dirname, '../../backend/V2DashboardService.gs'), 'utf8');
const apiRouterSource = fs.readFileSync(path.resolve(__dirname, '../../backend/ApiRouter.gs'), 'utf8');

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


test('provision reads SPREADSHEET_ID_V2 directly during the locked write phase', () => {
  const spreadsheetId = '1FVKsANXa97QsXORrmcXbCmxaoCmpJFvvmhp5piKqcVA';
  const secret = Buffer.alloc(32, 1).toString('base64url');
  const loaded = load({ properties: {
    SPREADSHEET_ID_V2: spreadsheetId,
    V2_BOOTSTRAP_ENABLED: 'TRUE',
    V2_BOOTSTRAP_ADMIN_PIN: 'TestPin123',
    APP_SECRET: secret,
  } });

  // Deliberately omit spreadsheetId from preflight to reproduce the real failure
  // that previously caused SpreadsheetApp.openById(undefined).
  loaded.sandbox.inspectV2BootstrapConfig_ = () => ({
    ok: true,
    errors: [],
    warnings: [],
    alreadyProvisioned: false,
    userId: 'USR-UAT-ADMIN-001',
    staffId: 'ADMIN01',
    staffName: 'UAT System Administrator',
    departmentId: 'DEPT-PHARMACY',
    role: 'SYSTEM_ADMIN',
    accountStatus: 'PENDING',
    version: 1,
  });

  let openedId = null;
  loaded.sandbox.SpreadsheetApp.openById = (id) => {
    openedId = id;
    return { fake: true };
  };
  loaded.sandbox.requireV2Sheet_ = (_spreadsheet, name) => ({ name });
  loaded.sandbox.assertV2DepartmentActive_ = () => {};
  loaded.sandbox.findV2RowByValue_ = () => ({
    rowNumber: 2,
    record: {
      UserID: 'USR-UAT-ADMIN-001',
      StaffID: 'ADMIN01',
      StaffName: 'UAT System Administrator',
      DepartmentID: 'DEPT-PHARMACY',
      Role: 'SYSTEM_ADMIN',
      AccountStatus: 'PENDING',
      Version: 1,
      RegisteredAt: '2026-10-07T10:00:00.000Z',
      CreatedAt: '2026-10-07T10:00:00.000Z',
    },
  });
  loaded.sandbox.createV2BootstrapPinHash_ = () => 'HMAC-SHA256$v2$testsalt$testhash';
  loaded.sandbox.upsertV2Record_ = () => 2;
  loaded.sandbox.appendV2Audit_ = () => {};

  const result = loaded.sandbox.provisionInitialV2Admin();

  assert.equal(openedId, spreadsheetId);
  assert.equal(result.success, true);
  assert.equal(result.staffId, 'ADMIN01');
  assert.equal(result.accountStatus, 'ACTIVE');
  assert.equal(result.version, 2);
  assert.equal(loaded.props.get('V2_BOOTSTRAP_ENABLED'), 'FALSE');
  assert.equal(loaded.props.has('V2_BOOTSTRAP_ADMIN_PIN'), false);
});


test('v2 runtime uses the v2 spreadsheet and never falls back to the v1 SPREADSHEET_ID', () => {
  assert.match(v2RepositorySource, /getProperty\('SPREADSHEET_ID_V2'\)/);
  assert.doesNotMatch(v2RepositorySource, /getProperty\('SPREADSHEET_ID'\)/);
  assert.match(v2AuthSource, /readV2Records_\('T_Users'/);
  assert.match(v2SessionSource, /readV2Records_\('S_Sessions'/);
  assert.match(v2DashboardSource, /readV2Records_\('T_Reservations'/);
});

test('v2 login and session functions are wired into ApiRouter without replacing v1 LOGIN', () => {
  assert.match(apiRouterSource, /LOGIN:\s*Object\.freeze\(\{ auth: false, mutates: true, handler: 'login_' \}\)/);
  assert.match(apiRouterSource, /LOGIN_V2:\s*Object\.freeze\(\{[^}]*v2:\s*true/);
  assert.match(apiRouterSource, /LOGOUT_V2:\s*Object\.freeze\(\{[^}]*v2:\s*true/);
  assert.match(apiRouterSource, /GET_V2_DASHBOARD:\s*Object\.freeze\(\{[^}]*v2:\s*true/);
  assert.match(apiRouterSource, /if \(action\.v2\)/);
  assert.match(apiRouterSource, /requireV2Session_\(request\.sessionToken/);
});

test('v2 login verifies bootstrap-compatible HMAC-SHA256 v2 hashes', () => {
  assert.match(v2AuthSource, /HMAC-SHA256\$v2\$/);
  assert.match(v2AuthSource, /MEDICATION_RESERVATION_PIN_V2\\u0000/);
  assert.match(v2AuthSource, /Utilities\.computeHmacSha256Signature/);
  assert.match(v2AuthSource, /PropertiesService\.getScriptProperties\(\)\.getProperty\('APP_SECRET'\)/);
  assert.match(v2AuthSource, /function v2ConstantTimeEqual_/);
});

test('v2 session stores only TokenHash and supports revoke and expiry', () => {
  assert.match(v2SessionSource, /TokenHash:\s*tokenHash/);
  assert.doesNotMatch(v2SessionSource, /RawToken:/);
  assert.match(v2SessionSource, /Revoked:\s*false/);
  assert.match(v2SessionSource, /SESSION_EXPIRED/);
  assert.match(v2SessionSource, /RevokeReason:\s*'USER_LOGOUT'/);
});

test('v2 dashboard exposes the compatibility fields required by the current frontend', () => {
  for (const field of ['OrderID','PatientName','WardClinic','Status','RequiredDate','ItemCount','CreatedAt']) {
    assert.match(v2DashboardSource, new RegExp(field));
  }
  assert.match(v2DashboardSource, /apiVersion:\s*'v2'/);
});
