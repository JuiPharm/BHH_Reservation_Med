const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }

function ApiError(errorCode, safeMessage, errors, metadata) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage;
  this.errors = errors || null;
  Object.assign(this, metadata || {});
}

function authSandbox(options = {}) {
  const records = {
    Users: [{ StaffID: '00123', PINHash: 'hash', Active: 'TRUE', FullName: 'Ada', Department: 'ER', Email: 'staff@example.invalid', Role: 'STAFF' }],
    Settings: [{ Key: 'LOGIN_GLOBAL_THROTTLE_STATE', Value: '' }],
    AuditLog: [],
  };
  const events = [];
  let lockHeld = false;
  const settings = {
    LOGIN_IDENTITY_FAILURE_LIMIT: '3',
    LOGIN_GLOBAL_FAILURE_LIMIT: '50',
    LOGIN_FAILURE_WINDOW_MINUTES: '15',
    LOGIN_LOCKOUT_MINUTES: '15',
    ...(options.settings || {}),
  };
  const runtime = {
    ApiError_: ApiError, Array, Date, JSON, Math, Number, Object, String, isFinite,
    Utilities: { getUuid: (() => { let value = 0; return () => `uuid-${++value}`; })() },
    LockService: { getScriptLock: () => ({
      waitLock: () => { assert.equal(lockHeld, false); lockHeld = true; events.push('lock'); },
      releaseLock: () => { assert.equal(lockHeld, true); lockHeld = false; events.push('unlock'); },
    }) },
    getSetting_: (key, fallback) => Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback,
    sha256Hex_: (value) => `sha:${value}`,
    findUserByStaffId_: (staffId) => records.Users.find((row) => row.StaffID === staffId) || null,
    userIsActive_: (user) => !!user && user.Active === 'TRUE',
    verifyPinHash_: (pin) => {
      assert.equal(lockHeld, false, 'PBKDF2 verification must never run while a script lock is held');
      events.push('verify');
      return pin === 'correct-pin';
    },
    createSession_: () => ({ rawToken: 'raw-session', expiresAt: '2030-01-01T00:00:00.000Z' }),
    trustedIdentity_: (user) => ({ ...user }),
    readRecords_: (name, query = {}) => {
      if (options.failThrottleRead && (name === 'Users' || name === 'Settings')) throw new Error('throttle read failed');
      const rows = records[name] || [];
      const filtered = query.predicate ? rows.filter(query.predicate) : rows.slice();
      return query.limit == null ? filtered.map((row) => ({ ...row })) : filtered.slice(0, query.limit).map((row) => ({ ...row }));
    },
    appendRecords_: (name, rows) => {
      const target = records[name] || (records[name] = []);
      rows.forEach((row) => target.push({ ...row }));
      return { startRow: target.length - rows.length + 2, rowCount: rows.length };
    },
    updateRecordByKey_: (name, key, value, updates) => {
      const row = (records[name] || []).find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, { ...updates });
      return { ...row };
    },
    writeAudit_: (entry) => records.AuditLog.push({ ...entry }),
  };
  const api = vm.runInNewContext(`${source('backend/AuthService.gs')}\n({ login_, unlockLoginIdentity });`, runtime);
  return { api, records, events };
}

test('durable per-identity throttling returns generic retry metadata and never records the PIN', () => {
  const { api, records, events } = authSandbox();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(
      () => api.login_({ staffId: '00123', pin: 'wrong-pin' }, `login-${attempt}`),
      (error) => error.errorCode === 'INVALID_CREDENTIALS' && error.safeMessage === 'Invalid staff ID or PIN.',
    );
  }
  assert.throws(
    () => api.login_({ staffId: '00123', pin: 'wrong-pin' }, 'login-throttled'),
    (error) => error.errorCode === 'LOGIN_THROTTLED'
      && error.safeMessage === 'Invalid staff ID or PIN.'
      && Number(error.retryAfterSeconds) > 0,
  );
  assert.equal(events.filter((event) => event === 'verify').length, 3, 'locked requests must not run PBKDF2');
  assert.equal(JSON.parse(records.Settings[0].Value || '{"failureCount":0}').failureCount, 0);
  assert.equal(records.Users[0].FailedLoginCount, 3);
  assert.match(records.Users[0].LoginLockedUntil, /^\d{4}-/);
  assert.doesNotMatch(JSON.stringify(records), /wrong-pin|correct-pin/);
  assert.equal(records.AuditLog.some((row) => row.Action === 'LOGIN' && row.Result === 'THROTTLED' && row.RequestID === 'login-throttled'), true);
});

test('unknown identities consume only the single bounded global Settings row and operator recovery clears a known identity', () => {
  const { api, records, events } = authSandbox({ settings: { LOGIN_GLOBAL_FAILURE_LIMIT: '10' } });
  for (let index = 0; index < 10; index += 1) {
    const staffId = `unknown-${index}`;
    assert.throws(() => api.login_({ staffId, pin: 'wrong-pin' }, `login-${staffId}`), (error) => error.errorCode === 'INVALID_CREDENTIALS');
  }
  assert.equal(events.filter((event) => event === 'verify').length, 10, 'unknown identities must run the same PBKDF2 verification path');
  assert.equal(records.Settings.length, 1);
  assert.equal(JSON.parse(records.Settings[0].Value).failureCount, 10);
  assert.throws(() => api.login_({ staffId: 'unknown-c', pin: 'wrong-pin' }, 'global-throttled'), (error) => error.errorCode === 'LOGIN_THROTTLED' && error.retryAfterSeconds > 0);
  assert.equal(api.login_({ staffId: '00123', pin: 'correct-pin' }, 'known-after-unknown-flood').sessionToken, 'raw-session', 'unknown-identity flooding must not lock known active users');

  Object.assign(records.Users[0], { FailedLoginCount: 3, LoginLockedUntil: '2030-01-01T00:00:00.000Z' });
  const result = api.unlockLoginIdentity('00123');
  assert.equal(result.unlocked, true);
  assert.equal(records.Users[0].FailedLoginCount, 0);
  assert.equal(records.Users[0].LoginLockedUntil, '');
  assert.equal(records.AuditLog.at(-1).Action, 'UNLOCK_LOGIN_IDENTITY');
});

test('known identity failures do not consume the unknown-identity throttle bucket', () => {
  const { api, records } = authSandbox();
  assert.throws(() => api.login_({ staffId: '00123', pin: 'wrong-pin' }, 'known-failure'), (error) => error.errorCode === 'INVALID_CREDENTIALS');
  assert.equal(records.Users[0].FailedLoginCount, 1);
  assert.equal(JSON.parse(records.Settings[0].Value || '{"failureCount":0}').failureCount, 0);
});

test('throttle storage failures fail closed with the same generic login message', () => {
  const { api, events } = authSandbox({ failThrottleRead: true });
  assert.throws(
    () => api.login_({ staffId: '00123', pin: 'correct-pin' }, 'storage-failure'),
    (error) => error.errorCode === 'LOGIN_THROTTLED' && error.safeMessage === 'Invalid staff ID or PIN.',
  );
  assert.equal(events.includes('verify'), false);
});
