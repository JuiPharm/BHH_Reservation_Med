const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const API_ROUTER_PATH = 'backend/ApiRouter.gs';
const SECURITY_PATH = 'backend/SecurityService.gs';
const RESPONSE_PATH = 'backend/ResponseService.gs';
const REQUIRED_FILES = [
  'backend/Code.gs',
  API_ROUTER_PATH,
  RESPONSE_PATH,
  SECURITY_PATH,
  'backend/ValidationService.gs',
  'backend/AuthService.gs',
  'backend/SessionService.gs',
  'backend/UserService.gs',
  'backend/AuthorizationService.gs',
];

function source(path) {
  return fs.readFileSync(path, 'utf8');
}

function loadValidationService() {
  const context = {
    ApiError_: function ApiError_(errorCode, safeMessage, errors) {
      this.name = 'ApiError';
      this.errorCode = errorCode;
      this.safeMessage = safeMessage;
      this.errors = errors;
    },
    Utilities: {
      newBlob: (value) => ({ getBytes: () => Array.from(Buffer.from(String(value), 'utf8')) }),
    },
  };
  return vm.runInNewContext(`${source('backend/ValidationService.gs')}\n({ parsePostRequest_, parseGetRequest_ });`, context);
}

function parseRegistryEntries(api, registryName) {
  const registry = api.match(new RegExp(`const\\s+${registryName}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  assert.ok(registry, `${registryName} must be a closed registry`);
  const entries = Array.from(registry[1].matchAll(/^\s{2}([A-Z_]+):\s+Object\.freeze\(\{([^}]*)\}\),?$/gm));
  assert.ok(entries.length > 0, `${registryName} must contain actions`);
  return entries.map((match) => ({ name: match[1], definition: match[2] }));
}

test('API entry points and trusted identity service files are present', () => {
  for (const path of REQUIRED_FILES) assert.ok(fs.existsSync(path), `missing ${path}`);
  const code = source('backend/Code.gs');
  for (const name of ['doPost', 'doGet']) assert.match(code, new RegExp(`function\\s+${name}\\s*\\(`));
  const auth = source('backend/AuthService.gs');
  assert.match(auth, /function\s+login_\s*\(/);
  assert.match(source('backend/SessionService.gs'), /function\s+requireSession_\s*\(/);
  assert.match(source('backend/AuthorizationService.gs'), /function\s+requireRole_\s*\(/);
  assert.match(source('backend/AuthorizationService.gs'), /function\s+requireOrderAccess_\s*\(/);
});

test('action registries allow auth:false only for explicitly named public actions', () => {
  const api = source(API_ROUTER_PATH);
  const publicActions = new Set(['LOGIN', 'CONFIRM_PATIENT_RECEIVED', 'SUBMIT_PATIENT_NO_SHOW', 'GET_APPOINTMENT_ACTION', 'GET_RESCHEDULE_REFERENCE']);
  const entries = [
    ...parseRegistryEntries(api, 'API_ACTIONS_'),
    ...parseRegistryEntries(api, 'GET_ACTIONS_'),
  ];

  for (const entry of entries) {
    const expectedAuth = publicActions.has(entry.name) ? 'false' : 'true';
    assert.match(entry.definition, new RegExp(`\\bauth:\\s*${expectedAuth}\\b`), `${entry.name} must declare auth:${expectedAuth}`);
  }

  assert.deepEqual(entries.filter((entry) => /\bauth:\s*false\b/.test(entry.definition)).map((entry) => entry.name), [
    'LOGIN', 'CONFIRM_PATIENT_RECEIVED', 'SUBMIT_PATIENT_NO_SHOW', 'GET_APPOINTMENT_ACTION', 'GET_RESCHEDULE_REFERENCE',
  ]);
});

test('GET requires a request ID and never registers a mutating appointment action', () => {
  const api = source(API_ROUTER_PATH);
  const getRegistry = parseRegistryEntries(api, 'GET_ACTIONS_');
  assert.deepEqual(getRegistry.map((entry) => entry.name), ['GET_APPOINTMENT_ACTION', 'GET_RESCHEDULE_REFERENCE']);
  assert.equal(getRegistry.every((entry) => /\bmutates:\s*false\b/.test(entry.definition)), true);
  assert.match(api, /request\.method\s*===\s*['"]GET['"][\s\S]*action\.mutates/);
  const { parseGetRequest_ } = loadValidationService();
  assert.throws(() => parseGetRequest_({ parameter: { action: 'GET_APPOINTMENT_ACTION' } }), (error) => error && error.errorCode === 'VALIDATION_ERROR');
});

test('POST size validation uses UTF-8 bytes, not JavaScript character count', () => {
  const { parsePostRequest_ } = loadValidationService();
  const emojiBody = JSON.stringify({
    action: 'LOGIN',
    requestId: 'utf8-limit',
    payload: { note: '🙂'.repeat(270000) },
  });

  assert.ok(emojiBody.length < 1024 * 1024, 'fixture must be below the character limit');
  assert.throws(() => parsePostRequest_({ postData: { contents: emojiBody } }), (error) => error && error.errorCode === 'VALIDATION_ERROR');
});

test('entry points never repair schema and login is explicitly exempt from replayable business mutations', () => {
  const code = source('backend/Code.gs');
  const api = source(API_ROUTER_PATH);
  const auth = source('backend/AuthService.gs');
  const tests = source('backend/Tests.gs');

  const postEntryPoint = code.match(/function doPost\(event\)[\s\S]*?\n\}/);
  const getEntryPoint = code.match(/function doGet\(event\)[\s\S]*?\n\}/);
  assert.ok(postEntryPoint, 'doPost entry point is present');
  assert.ok(getEntryPoint, 'doGet entry point is present');
  assert.doesNotMatch(postEntryPoint[0], /ensureApplicationReady_|initializeDatabase\s*\(|setupApplication/i);
  assert.doesNotMatch(getEntryPoint[0], /ensureApplicationReady_|initializeDatabase\s*\(|setupApplication/i);
  assert.doesNotMatch(api, /INITIALIZE_DATABASE|initializeDatabase\s*\(|ensureApplicationReady_|setupApplication/i);
  assert.match(api, /GET_DATABASE_HEALTH[\s\S]{0,160}mutates:\s*false/);
  assert.match(api, /actionName\s*===\s*['"]GET_DATABASE_HEALTH['"]\)\s*return\s+getDatabaseHealth\s*\(\s*\)/);
  assert.match(auth, /LOGIN is exempt from business-mutation idempotent replay/i);
  assert.match(tests, /repeatedLogin/);
  assert.match(tests, /repeatedLogin\.sessionToken !== loggedIn\.sessionToken/);
});

test('PIN hashes use the Apps Script bounded-work HMAC format and session storage only receives token hashes', () => {
  const security = source(SECURITY_PATH);
  const session = source('backend/SessionService.gs');
  const auth = source('backend/AuthService.gs');

  assert.match(security, /HMAC-SHA256\$v2\$/);
  assert.match(security, /computeHmacSha256Signature/);
  assert.doesNotMatch(security, /derivePbkdf2|PIN_PBKDF2_ITERATIONS|for\s*\([^)]*iteration/i);
  assert.match(security, /constantTimeEqual_/);
  assert.match(security, /salt\.length\s*!==\s*PIN_SALT_BYTES_/);
  assert.match(security, /expected\.length\s*!==\s*PIN_HASH_BYTES_/);
  assert.match(session, /SessionTokenHash/);
  assert.match(session, /sha256Hex_/);
  assert.doesNotMatch(session, /appendRecords_\s*\(\s*['"]Sessions['"][\s\S]{0,400}sessionToken\s*:/);
  assert.match(auth, /String\(payload\.staffId\s*\|\|\s*['"]['"]\)\.trim\(\)/);
  assert.match(auth, /delete\s+identity\.PINHash/);
});

test('live authentication test fixture uses a PIN accepted by the provisioning policy', () => {
  const tests = source('backend/Tests.gs');
  const fixture = tests.match(/const\s+pinHash\s*=\s*createPinHash_\((['"])([^'"]+)\1\)/);

  assert.ok(fixture, 'runAuthTests must provision its PIN through createPinHash_');
  assert.ok(fixture[2].length >= 8 && fixture[2].length <= 128, 'runAuthTests PIN fixture must contain 8 to 128 characters');
});

test('errors have a safe envelope and never serialize implementation details or credentials', () => {
  const response = source(RESPONSE_PATH);
  assert.match(response, /success:\s*false/);
  assert.match(response, /errorCode/);
  assert.doesNotMatch(response, /\.stack\b/);
  assert.doesNotMatch(response, /PINHash/);
  assert.doesNotMatch(response, /sessionToken/);
});

test('login throttling exposes only bounded retry metadata through the safe envelope', () => {
  const api = vm.runInNewContext(`${source(RESPONSE_PATH)}\n({ apiFailure_ });`);
  const error = new apiFailureError('LOGIN_THROTTLED', 'Invalid staff ID or PIN.', null, 87);
  function apiFailureError(errorCode, safeMessage, errors, retryAfterSeconds) {
    this.name = 'ApiError';
    this.errorCode = errorCode;
    this.safeMessage = safeMessage;
    this.errors = errors;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(api.apiFailure_(error, 'login-1'))), {
    success: false,
    message: 'Invalid staff ID or PIN.',
    errorCode: 'LOGIN_THROTTLED',
    requestId: 'login-1',
    retryAfterSeconds: 87,
  });
});

test('protected response envelopes expose only the refreshed session expiry hint', () => {
  const api = vm.runInNewContext(`${source(RESPONSE_PATH)}\n({ apiSuccess_ });`);
  assert.deepEqual(JSON.parse(JSON.stringify(api.apiSuccess_({ value: 1 }, 'read-1', '', {
    sessionExpiresAt: '2030-01-01T00:00:00.000Z',
    sessionToken: 'must-not-leak',
  }))), {
    success: true, message: 'OK', data: { value: 1 }, requestId: 'read-1',
    sessionExpiresAt: '2030-01-01T00:00:00.000Z',
  });
});
