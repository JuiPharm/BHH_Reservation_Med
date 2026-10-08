const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) {
  return fs.readFileSync(path, 'utf8');
}

function ApiError(errorCode, message, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.message = message;
  this.errors = errors;
}

function userSandbox() {
  const secretBytes = Array.from(Buffer.alloc(32, 7));
  const encodedSecret = Buffer.from(secretBytes).toString('base64url');

  const records = {
    T_Users: [
      {
        UserID: 'USR-01',
        StaffID: 'ADMIN01',
        StaffName: 'UAT Administrator',
        PersonalEmail: 'admin@example.invalid',
        DepartmentID: 'DEPT-PHARMACY',
        PasswordHash: 'HMAC-SHA256$v2$dummy$dummy',
        Role: 'SYSTEM_ADMIN',
        AccountStatus: 'ACTIVE',
        FailedLoginCount: 0,
        LockedUntil: '',
        Version: 1,
      },
    ],
    M_Departments: [
      {
        DepartmentID: 'DEPT-PHARMACY',
        DepartmentCode: 'PHARMACY',
        DepartmentName: 'ศูนย์เภสัชกรรม',
        Active: 'TRUE',
      },
    ],
    L_AuditLog: [],
  };

  const runtime = {
    ApiError_: ApiError,
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    parseInt,
    isFinite,
    Utilities: {
      getUuid: (() => {
        let count = 0;
        return () => `uuid-${++count}`;
      })(),
      newBlob: (str) => ({
        getBytes: () => Array.from(Buffer.from(String(str), 'utf8')),
      }),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      base64DecodeWebSafe: (str) => Array.from(Buffer.from(str, 'base64url')),
      computeHmacSha256Signature: (bytes, keyBytes) => {
        const crypto = require('node:crypto');
        const hmac = crypto.createHmac('sha256', Buffer.from(keyBytes));
        hmac.update(Buffer.from(bytes));
        return Array.from(hmac.digest());
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key === 'APP_SECRET' ? encodedSecret : ''),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {},
        releaseLock: () => {},
      }),
    },
    readV2Records_: (sheetName, options) => {
      const rows = records[sheetName] || [];
      const chosen = options && options.predicate ? rows.filter(options.predicate) : rows;
      return JSON.parse(JSON.stringify(options && options.limit != null ? chosen.slice(0, options.limit) : chosen));
    },
    appendV2Records_: (sheetName, rows) => {
      (records[sheetName] || (records[sheetName] = [])).push(...JSON.parse(JSON.stringify(rows)));
    },
    updateV2RecordByKey_: (sheetName, key, value, updates) => {
      const row = (records[sheetName] || []).find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, JSON.parse(JSON.stringify(updates)));
      return row;
    },
    findV2UserByStaffId_: (staffId) => {
      const user = (records.T_Users || []).find((u) => String(u.StaffID) === String(staffId));
      return user ? JSON.parse(JSON.stringify(user)) : null;
    },
    v2AppSecretBytes_: () => secretBytes,
    v2PinMac_: (pin, salt) => {
      const crypto = require('node:crypto');
      const domain = Array.from(Buffer.from('MEDICATION_RESERVATION_PIN_V2\u0000', 'utf8'));
      const pinBytes = Array.from(Buffer.from(String(pin), 'utf8'));
      const hmac = crypto.createHmac('sha256', Buffer.from(secretBytes));
      hmac.update(Buffer.from(domain.concat(salt, pinBytes)));
      return Array.from(hmac.digest());
    },
  };

  const code = source('backend/V2UserService.gs');
  const service = vm.runInNewContext(`${code}\n({ listUsersV2_, createUserByAdminV2_, resetUserPinByAdminV2_, updateUserByAdminV2_ });`, runtime);
  return { service, records, runtime };
}

const adminContext = {
  user: {
    UserID: 'USR-01',
    StaffID: 'ADMIN01',
    Role: 'SYSTEM_ADMIN',
  },
};

const staffContext = {
  user: {
    UserID: 'USR-02',
    StaffID: 'STAFF01',
    Role: 'REQUESTER',
  },
};

test('listUsersV2_ rejects unauthorized role', () => {
  const { service } = userSandbox();
  assert.throws(() => service.listUsersV2_(staffContext), (err) => err.errorCode === 'FORBIDDEN');
});

test('listUsersV2_ returns user list with resolved department name', () => {
  const { service } = userSandbox();
  const result = service.listUsersV2_(adminContext);
  assert.equal(result.users.length, 1);
  assert.equal(result.users[0].StaffID, 'ADMIN01');
  assert.equal(result.users[0].FullName, 'UAT Administrator');
  assert.equal(result.users[0].Department, 'ศูนย์เภสัชกรรม');
  assert.equal(result.users[0].Active, true);
});

test('createUserByAdminV2_ creates a new user and auto-provisions department', () => {
  const { service, records } = userSandbox();
  const payload = {
    staffId: 'STAFF100',
    fullName: 'Somchai Jaidee',
    department: 'แผนกอุบัติเหตุฉุกเฉิน',
    email: 'somchai@example.invalid',
    role: 'REQUESTER',
    pin: 'pin-somchai-123',
  };

  const res = service.createUserByAdminV2_(adminContext, payload, 'req-create-1');
  assert.equal(res.success, true);
  assert.equal(res.staffId, 'STAFF100');

  const created = records.T_Users.find((u) => u.StaffID === 'STAFF100');
  assert.ok(created);
  assert.equal(created.StaffName, 'Somchai Jaidee');
  assert.equal(created.Role, 'REQUESTER');
  assert.equal(created.AccountStatus, 'ACTIVE');
  assert.match(created.PasswordHash, /^HMAC-SHA256\$v2\$/);

  // Department auto-provisioning
  const dept = records.M_Departments.find((d) => d.DepartmentName === 'แผนกอุบัติเหตุฉุกเฉิน');
  assert.ok(dept);
  assert.equal(created.DepartmentID, dept.DepartmentID);

  // Audit log
  const audit = records.L_AuditLog.find((a) => a.Action === 'CREATE_USER');
  assert.ok(audit);
  assert.equal(audit.RequestID, 'req-create-1');
});

test('createUserByAdminV2_ rejects duplicate staff ID and invalid PIN', () => {
  const { service } = userSandbox();
  assert.throws(
    () => service.createUserByAdminV2_(adminContext, { staffId: 'ADMIN01', fullName: 'Duplicate', department: 'DEPT-PHARMACY', pin: 'validpin123' }),
    (err) => err.errorCode === 'DUPLICATE_USER'
  );
  assert.throws(
    () => service.createUserByAdminV2_(adminContext, { staffId: 'NEW01', fullName: 'Short Pin', department: 'DEPT-PHARMACY', pin: 'short' }),
    (err) => err.errorCode === 'VALIDATION_ERROR'
  );
});

test('resetUserPinByAdminV2_ updates password hash and increments version', () => {
  const { service, records } = userSandbox();
  const res = service.resetUserPinByAdminV2_(adminContext, { staffId: 'ADMIN01', newPin: 'brand-new-pin-456' }, 'req-reset-1');
  assert.equal(res.success, true);

  const updated = records.T_Users.find((u) => u.StaffID === 'ADMIN01');
  assert.equal(updated.Version, 2);
  assert.match(updated.PasswordHash, /^HMAC-SHA256\$v2\$/);
});

test('updateUserByAdminV2_ updates active status and details', () => {
  const { service, records } = userSandbox();
  const res = service.updateUserByAdminV2_(adminContext, { staffId: 'ADMIN01', active: false }, 'req-update-1');
  assert.equal(res.success, true);

  const updated = records.T_Users.find((u) => u.StaffID === 'ADMIN01');
  assert.equal(updated.AccountStatus, 'DISABLED');
});
