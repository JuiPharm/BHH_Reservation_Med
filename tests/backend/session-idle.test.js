const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }
function ApiError(errorCode, safeMessage) { this.name = 'ApiError'; this.errorCode = errorCode; this.safeMessage = safeMessage; }

function sessionSandbox(lastActiveMinutesAgo, options = {}) {
  const now = Date.now();
  const records = {
    Sessions: [{
      SessionTokenHash: 'hash:token', StaffID: '00123', CreatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
      LastActiveAt: new Date(now - lastActiveMinutesAgo * 60 * 1000).toISOString(),
      ExpiresAt: new Date(now + (32 - lastActiveMinutesAgo) * 60 * 1000).toISOString(), Active: 'TRUE',
    }],
  };
  const updates = [];
  let sessionReads = 0;
  const runtime = {
    ApiError_: ApiError, Date, Math, Number, String, isFinite,
    getSetting_: (key, fallback) => ({
      SESSION_TIMEOUT_MINUTES: String(options.timeoutMinutes || 30),
      SESSION_TOUCH_INTERVAL_MINUTES: String(options.touchIntervalMinutes || 2),
    }[key] || fallback),
    sha256Hex_: (value) => `hash:${value}`,
    readRecords_: (name, query = {}) => {
      if (name === 'Sessions') {
        sessionReads += 1;
        if (options.refreshBeforeTouch && sessionReads === 2) {
          records.Sessions[0].LastActiveAt = new Date(now - 30 * 1000).toISOString();
          records.Sessions[0].ExpiresAt = new Date(now + 31.5 * 60 * 1000).toISOString();
        }
      }
      const rows = records[name] || [];
      const filtered = query.predicate ? rows.filter(query.predicate) : rows.slice();
      return query.limit == null ? filtered.map((row) => ({ ...row })) : filtered.slice(0, query.limit).map((row) => ({ ...row }));
    },
    updateRecordByKey_: (name, key, value, changes) => {
      updates.push({ name, changes: { ...changes } });
      if (options.failTouchUpdate && name === 'Sessions' && Object.prototype.hasOwnProperty.call(changes, 'LastActiveAt')) return null;
      const row = records[name].find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, changes);
      return { ...row };
    },
    findUserByStaffId_: () => ({ StaffID: '00123', FullName: 'Ada', Department: 'ER', Email: 'staff@example.invalid', Role: 'STAFF', Active: 'TRUE' }),
    userIsActive_: () => true,
    trustedIdentity_: (user) => ({ ...user }),
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ...(options.runtime || {}),
  };
  const service = vm.runInNewContext(`${source('backend/SessionService.gs')}\n({ requireSession_ });`, runtime);
  return { service, records, updates, now, getSessionReads: () => sessionReads };
}

test('protected activity refreshes the client idle expiry while bounding Sheet touches', () => {
  const recent = sessionSandbox(1);
  const recentContext = recent.service.requireSession_('token');
  assert.equal(recent.updates.length, 0, 'activity inside the touch interval must not amplify Sheet writes');
  assert.ok(Date.parse(recentContext.expiresAt) >= recent.now + 29 * 60 * 1000);

  const due = sessionSandbox(3);
  const dueContext = due.service.requireSession_('token');
  assert.equal(due.updates.length, 1);
  assert.match(due.updates[0].changes.LastActiveAt, /^\d{4}-/);
  assert.match(due.updates[0].changes.ExpiresAt, /^\d{4}-/);
  assert.ok(Date.parse(dueContext.expiresAt) >= due.now + 29 * 60 * 1000);
  assert.ok(Date.parse(due.updates[0].changes.ExpiresAt) > Date.parse(dueContext.expiresAt), 'durable expiry includes only the bounded touch grace');
});

test('idle sessions expire server-side after timeout plus only the documented touch grace', () => {
  const expired = sessionSandbox(33);
  assert.throws(() => expired.service.requireSession_('token'), (error) => error.errorCode === 'SESSION_EXPIRED');
  assert.equal(expired.records.Sessions[0].Active, 'FALSE');
});

test('GET activity is touched and route metadata carries the refreshed expiry contract', () => {
  const metadata = {};
  const calls = [];
  const api = vm.runInNewContext(`${source('backend/ApiRouter.gs')}\n({ routeApiRequest_ });`, {
    ApiError_: ApiError,
    requireSession_: (_token, options) => {
      calls.push(options);
      return { user: { StaffID: '00123' }, expiresAt: '2030-01-01T00:00:00.000Z' };
    },
    getMasterData_: () => ({}),
  });
  api.routeApiRequest_({ action: 'GET_MASTER_DATA', method: 'POST', sessionToken: 'token', requestId: 'read-1', payload: { types: [] } }, metadata);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ touch: true }]);
  assert.equal(metadata.sessionExpiresAt, '2030-01-01T00:00:00.000Z');
});

test('a failed durable touch does not advertise an unpersisted idle extension', () => {
  const sandbox = sessionSandbox(3, { failTouchUpdate: true });
  const before = Date.parse(sandbox.records.Sessions[0].LastActiveAt) + 30 * 60 * 1000;
  const context = sandbox.service.requireSession_('token');
  assert.equal(Date.parse(context.expiresAt), before);
});

test('touch rechecks the session under lock and never overwrites newer activity', () => {
  const sandbox = sessionSandbox(3, { refreshBeforeTouch: true });
  const context = sandbox.service.requireSession_('token');
  assert.equal(sandbox.getSessionReads(), 2);
  assert.equal(sandbox.updates.length, 0);
  assert.ok(Date.parse(context.expiresAt) > sandbox.now + 29 * 60 * 1000);
});

test('client expiry never exceeds the durable session expiry after a timeout setting increase', () => {
  const sandbox = sessionSandbox(1, { timeoutMinutes: 60 });
  const durableExpiry = Date.parse(sandbox.records.Sessions[0].ExpiresAt);
  const context = sandbox.service.requireSession_('token');
  assert.equal(Date.parse(context.expiresAt), durableExpiry);
});
