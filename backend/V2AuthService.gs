/**
 * Authentication for BHH Reservation Med v2.
 * Reads only T_Users in SPREADSHEET_ID_V2.
 */
function loginV2_(payload, requestId) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const pin = typeof payload.pin === 'string' ? payload.pin : '';
  if (!staffId || !pin) {
    throw new ApiError_('INVALID_CREDENTIALS', 'Invalid staff ID or PIN.');
  }

  const user = findV2UserByStaffId_(staffId);
  const activeUser = user && String(user.AccountStatus || '').toUpperCase() === 'ACTIVE' ? user : null;
  const now = new Date();

  if (activeUser) {
    const lockedUntil = new Date(activeUser.LockedUntil || 0);
    if (isFinite(lockedUntil.getTime()) && lockedUntil > now) {
      const error = new ApiError_('LOGIN_THROTTLED', 'Invalid staff ID or PIN.');
      error.retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
      throw error;
    }
  }

  const storedHash = activeUser ? String(activeUser.PasswordHash || '') : v2DummyPinHash_();
  const verified = verifyV2PinHash_(pin, storedHash);

  if (!verified) {
    if (activeUser) recordV2FailedLogin_(activeUser, now);
    writeV2LoginAuditSafe_(activeUser, requestId, 'FAILURE');
    throw new ApiError_('INVALID_CREDENTIALS', 'Invalid staff ID or PIN.');
  }

  updateV2RecordByKey_('T_Users', 'StaffID', staffId, {
    FailedLoginCount: 0,
    LockedUntil: '',
    LastLoginAt: now.toISOString(),
    UpdatedAt: now.toISOString(),
    Version: Math.max(0, Number(activeUser.Version || 0)) + 1,
  });

  const session = createV2Session_(activeUser.UserID);
  const identity = trustedV2Identity_(activeUser);
  writeV2LoginAuditSafe_(activeUser, requestId, 'SUCCESS');

  return {
    sessionToken: session.rawToken,
    expiresAt: session.expiresAt,
    user: identity,
    requestId: requestId,
    apiVersion: 'v2',
  };
}

function findV2UserByStaffId_(staffId) {
  const rows = readV2Records_('T_Users', {
    predicate: function (row) { return String(row.StaffID || '') === String(staffId || ''); },
    limit: 1,
  });
  return rows.length ? rows[0] : null;
}

function findV2UserById_(userId) {
  const rows = readV2Records_('T_Users', {
    predicate: function (row) { return String(row.UserID || '') === String(userId || ''); },
    limit: 1,
  });
  return rows.length ? rows[0] : null;
}

function trustedV2Identity_(user) {
  if (!user) return null;
  const departmentId = String(user.DepartmentID || '');
  const departments = readV2Records_('M_Departments', {
    predicate: function (row) { return String(row.DepartmentID || '') === departmentId; },
    limit: 1,
  });
  const department = departments.length
    ? String(departments[0].DepartmentName || departments[0].DepartmentCode || departmentId)
    : departmentId;
  return {
    UserID: String(user.UserID || ''),
    StaffID: String(user.StaffID || ''),
    FullName: String(user.StaffName || ''),
    StaffName: String(user.StaffName || ''),
    DepartmentID: departmentId,
    Department: department,
    Role: String(user.Role || '').toUpperCase(),
    AccountStatus: String(user.AccountStatus || '').toUpperCase(),
  };
}

function recordV2FailedLogin_(user, now) {
  const maxFailed = boundedV2IntegerConfig_('LOGIN_MAX_FAILED', 5, 2, 20);
  const lockMinutes = boundedV2IntegerConfig_('ACCOUNT_LOCK_MINUTES', 15, 1, 1440);
  const nextCount = Math.max(0, Number(user.FailedLoginCount || 0)) + 1;
  const lockedUntil = nextCount >= maxFailed
    ? new Date(now.getTime() + lockMinutes * 60 * 1000).toISOString()
    : '';
  updateV2RecordByKey_('T_Users', 'StaffID', user.StaffID, {
    FailedLoginCount: nextCount >= maxFailed ? 0 : nextCount,
    LockedUntil: lockedUntil,
    UpdatedAt: now.toISOString(),
    Version: Math.max(0, Number(user.Version || 0)) + 1,
  });
}

function boundedV2IntegerConfig_(key, fallback, minimum, maximum) {
  const value = Number(getV2Config_(key, fallback));
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? Math.floor(value) : fallback;
}

function verifyV2PinHash_(pin, storedHash) {
  const prefix = 'HMAC-SHA256$v2$';
  if (typeof storedHash !== 'string' || storedHash.indexOf(prefix) !== 0) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'HMAC-SHA256' || parts[1] !== 'v2') return false;
  try {
    const salt = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[2]));
    const expected = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[3]));
    if (salt.length !== 16 || expected.length !== 32) return false;
    const actual = v2PinMac_(pin, salt);
    return v2ConstantTimeEqual_(actual, expected);
  } catch (_ignored) {
    return false;
  }
}

function v2PinMac_(pin, salt) {
  const domain = Array.prototype.slice.call(
    Utilities.newBlob('MEDICATION_RESERVATION_PIN_V2\u0000').getBytes()
  );
  const pinBytes = Array.prototype.slice.call(Utilities.newBlob(String(pin)).getBytes());
  return Array.prototype.slice.call(
    Utilities.computeHmacSha256Signature(
      domain.concat(salt, pinBytes),
      v2AppSecretBytes_()
    )
  );
}

function v2AppSecretBytes_() {
  const encoded = String(PropertiesService.getScriptProperties().getProperty('APP_SECRET') || '').trim();
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded)) throw new Error('APP_SECRET is not configured correctly.');
  const bytes = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(encoded));
  if (bytes.length !== 32) throw new Error('APP_SECRET is not configured correctly.');
  return bytes;
}

function v2ConstantTimeEqual_(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] & 255) ^ (right[index] & 255);
  }
  return difference === 0;
}

function v2DummyPinHash_() {
  return 'HMAC-SHA256$v2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
}

function writeV2LoginAuditSafe_(user, requestId, result) {
  try {
    appendV2Records_('L_AuditLog', [{
      AuditID: 'AUD-' + Utilities.getUuid(),
      Timestamp: new Date().toISOString(),
      UserID: user ? String(user.UserID || '') : '',
      StaffID: user ? String(user.StaffID || '') : '',
      Action: 'LOGIN_V2',
      EntityType: 'SESSION',
      EntityID: '',
      ReservationID: '',
      OldValueJSON: '',
      NewValueJSON: '',
      Reason: result,
      SessionID: '',
      RequestID: String(requestId || ''),
    }]);
  } catch (_ignored) {}
}
