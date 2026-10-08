/**
 * User management service for BHH Reservation Med v2.
 * Operates on T_Users and M_Departments in SPREADSHEET_ID_V2.
 * Only SYSTEM_ADMIN, PHARMACY_MANAGER, or ADMIN can manage users.
 */

function listUsersV2_(context) {
  assertAdminRoleV2_(context);
  const rawUsers = readV2Records_('T_Users');
  const departments = readV2Records_('M_Departments');
  const deptMap = {};
  departments.forEach(function (dept) {
    const id = String(dept.DepartmentID || '');
    if (id) {
      deptMap[id] = String(dept.DepartmentName || dept.DepartmentCode || id);
    }
  });

  const users = rawUsers.map(function (u) {
    const deptId = String(u.DepartmentID || '');
    const deptName = deptMap[deptId] || deptId;
    const isActive = String(u.AccountStatus || '').toUpperCase() === 'ACTIVE';
    return {
      UserID: String(u.UserID || ''),
      StaffID: String(u.StaffID || ''),
      FullName: String(u.StaffName || ''),
      Department: deptName,
      DepartmentID: deptId,
      Email: String(u.PersonalEmail || ''),
      Role: String(u.Role || '').toUpperCase(),
      Active: isActive,
      AccountStatus: String(u.AccountStatus || '').toUpperCase(),
      CreatedAt: String(u.CreatedAt || u.RegisteredAt || ''),
      UpdatedAt: String(u.UpdatedAt || ''),
    };
  });

  return { users: users };
}

function createUserByAdminV2_(context, payload, requestId) {
  assertAdminRoleV2_(context);
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const fullName = String(payload.fullName || '').trim();
  const departmentInput = String(payload.department || payload.departmentId || '').trim();
  const email = String(payload.email || '').trim();
  let role = String(payload.role || 'REQUESTER').trim().toUpperCase();
  const pin = String(payload.pin || '').trim();

  if (role === 'STAFF') role = 'REQUESTER';
  if (role === 'ADMIN') role = 'SYSTEM_ADMIN';
  const allowedRoles = ['REQUESTER', 'PHARMACY_OPERATOR', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN', 'REPORT_VIEWER'];
  if (allowedRoles.indexOf(role) < 0) {
    throw new ApiError_('VALIDATION_ERROR', 'Invalid role: ' + role);
  }

  const errors = [];
  if (!staffId) errors.push({ field: 'staffId', message: 'Staff ID is required.' });
  else if (!/^[A-Za-z0-9_-]{1,50}$/.test(staffId)) errors.push({ field: 'staffId', message: 'Staff ID must be 1-50 alphanumeric characters or hyphens.' });
  if (!fullName) errors.push({ field: 'fullName', message: 'Full name is required.' });
  else if (fullName.length > 150) errors.push({ field: 'fullName', message: 'Full name cannot exceed 150 characters.' });
  if (!departmentInput) errors.push({ field: 'department', message: 'Department is required.' });
  if (!pin || pin.length < 8 || pin.length > 128) errors.push({ field: 'pin', message: 'PIN must be between 8 and 128 characters.' });
  if (email && email.length > 150) errors.push({ field: 'email', message: 'Email cannot exceed 150 characters.' });
  if (errors.length) throw new ApiError_('VALIDATION_ERROR', 'Invalid user data.', errors);

  const existing = findV2UserByStaffId_(staffId);
  if (existing) throw new ApiError_('DUPLICATE_USER', 'A user with this Staff ID already exists.');

  const resolvedDeptId = resolveOrProvisionDepartmentV2_(departmentInput);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existingUnderLock = findV2UserByStaffId_(staffId);
    if (existingUnderLock) throw new ApiError_('DUPLICATE_USER', 'A user with this Staff ID already exists.');

    const now = new Date().toISOString();
    const userId = 'USR-' + Utilities.getUuid();
    const pinHash = createV2UserPinHash_(pin);

    const newUser = {
      UserID: userId,
      StaffID: staffId,
      StaffName: fullName,
      PersonalEmail: email,
      DepartmentID: resolvedDeptId,
      PasswordHash: pinHash,
      PasswordSalt: '',
      PasswordAlgorithm: 'HMAC-SHA256$v2$',
      PasswordIterations: 1,
      Role: role,
      AccountStatus: 'ACTIVE',
      FailedLoginCount: 0,
      LockedUntil: '',
      RegisteredAt: now,
      ApprovedBy: context && context.user ? context.user.StaffID : 'ADMIN',
      ApprovedAt: now,
      RejectedBy: '',
      RejectedAt: '',
      RejectReason: '',
      LastLoginAt: '',
      PasswordChangedAt: now,
      CreatedAt: now,
      UpdatedAt: now,
      Version: 1,
    };

    appendV2Records_('T_Users', [newUser]);

    writeV2AuditSafe_({
      Action: 'CREATE_USER',
      EntityType: 'USER',
      EntityID: userId,
      OldValueJSON: '',
      NewValueJSON: JSON.stringify({ staffId: staffId, staffName: fullName, departmentId: resolvedDeptId, role: role }),
      Reason: 'Admin created user via Web App',
      UserID: context && context.user ? context.user.UserID : '',
      StaffID: context && context.user ? context.user.StaffID : '',
      RequestID: String(requestId || ''),
    });

    return {
      success: true,
      staffId: staffId,
      userId: userId,
      role: role,
    };
  } finally {
    lock.releaseLock();
  }
}

function resetUserPinByAdminV2_(context, payload, requestId) {
  assertAdminRoleV2_(context);
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const newPin = String(payload.newPin || '').trim();

  if (!staffId) throw new ApiError_('VALIDATION_ERROR', 'Staff ID is required.');
  if (!newPin || newPin.length < 8 || newPin.length > 128) throw new ApiError_('VALIDATION_ERROR', 'New PIN must be 8 to 128 characters.');

  const user = findV2UserByStaffId_(staffId);
  if (!user) throw new ApiError_('USER_NOT_FOUND', 'User not found.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const pinHash = createV2UserPinHash_(newPin);
    const now = new Date().toISOString();
    updateV2RecordByKey_('T_Users', 'StaffID', staffId, {
      PasswordHash: pinHash,
      FailedLoginCount: 0,
      LockedUntil: '',
      PasswordChangedAt: now,
      UpdatedAt: now,
      Version: Math.max(0, Number(user.Version || 0)) + 1,
    });

    writeV2AuditSafe_({
      Action: 'RESET_USER_PIN',
      EntityType: 'USER',
      EntityID: String(user.UserID || ''),
      OldValueJSON: '',
      NewValueJSON: JSON.stringify({ staffId: staffId }),
      Reason: 'Admin reset PIN via Web App',
      UserID: context && context.user ? context.user.UserID : '',
      StaffID: context && context.user ? context.user.StaffID : '',
      RequestID: String(requestId || ''),
    });

    return { success: true, staffId: staffId };
  } finally {
    lock.releaseLock();
  }
}

function updateUserByAdminV2_(context, payload, requestId) {
  assertAdminRoleV2_(context);
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  if (!staffId) throw new ApiError_('VALIDATION_ERROR', 'Staff ID is required.');
  const user = findV2UserByStaffId_(staffId);
  if (!user) throw new ApiError_('USER_NOT_FOUND', 'User not found.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date().toISOString();
    const updates = {
      UpdatedAt: now,
      Version: Math.max(0, Number(user.Version || 0)) + 1,
    };

    if (payload.fullName !== undefined) {
      const name = String(payload.fullName || '').trim();
      if (!name) throw new ApiError_('VALIDATION_ERROR', 'Full name cannot be empty.');
      updates.StaffName = name;
    }
    if (payload.email !== undefined) {
      updates.PersonalEmail = String(payload.email || '').trim();
    }
    if (payload.department !== undefined || payload.departmentId !== undefined) {
      const deptInput = String(payload.department || payload.departmentId || '').trim();
      if (deptInput) {
        updates.DepartmentID = resolveOrProvisionDepartmentV2_(deptInput);
      }
    }
    if (payload.role !== undefined) {
      let newRole = String(payload.role || '').trim().toUpperCase();
      if (newRole === 'STAFF') newRole = 'REQUESTER';
      if (newRole === 'ADMIN') newRole = 'SYSTEM_ADMIN';
      const allowedRoles = ['REQUESTER', 'PHARMACY_OPERATOR', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN', 'REPORT_VIEWER'];
      if (allowedRoles.indexOf(newRole) < 0) {
        throw new ApiError_('VALIDATION_ERROR', 'Invalid role: ' + newRole);
      }
      updates.Role = newRole;
    }
    if (payload.active !== undefined) {
      updates.AccountStatus = payload.active ? 'ACTIVE' : 'DISABLED';
    }
    if (payload.accountStatus !== undefined) {
      const status = String(payload.accountStatus).toUpperCase();
      if (['ACTIVE', 'DISABLED', 'LOCKED', 'PENDING', 'REJECTED'].indexOf(status) >= 0) {
        updates.AccountStatus = status;
      }
    }

    updateV2RecordByKey_('T_Users', 'StaffID', staffId, updates);

    writeV2AuditSafe_({
      Action: 'UPDATE_USER',
      EntityType: 'USER',
      EntityID: String(user.UserID || ''),
      OldValueJSON: JSON.stringify({ role: user.Role, status: user.AccountStatus, dept: user.DepartmentID }),
      NewValueJSON: JSON.stringify(updates),
      Reason: 'Admin updated user via Web App',
      UserID: context && context.user ? context.user.UserID : '',
      StaffID: context && context.user ? context.user.StaffID : '',
      RequestID: String(requestId || ''),
    });

    return { success: true, staffId: staffId };
  } finally {
    lock.releaseLock();
  }
}

function assertAdminRoleV2_(context) {
  const role = context && context.user ? String(context.user.Role || '').toUpperCase() : '';
  if (role !== 'SYSTEM_ADMIN' && role !== 'PHARMACY_MANAGER' && role !== 'ADMIN') {
    throw new ApiError_('FORBIDDEN', 'Only administrators can manage users.');
  }
}

function resolveOrProvisionDepartmentV2_(departmentInput) {
  const input = String(departmentInput || '').trim();
  if (!input) return 'DEPT-PHARMACY';

  const departments = readV2Records_('M_Departments');
  const matched = departments.find(function (d) {
    return String(d.DepartmentID || '').trim() === input ||
      String(d.DepartmentCode || '').trim().toUpperCase() === input.toUpperCase() ||
      String(d.DepartmentName || '').trim().toLowerCase() === input.toLowerCase();
  });

  if (matched) return String(matched.DepartmentID);

  // Auto-provision new department in M_Departments
  const cleanCode = input.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 20);
  let deptId = cleanCode ? ('DEPT-' + cleanCode) : ('DEPT-' + Utilities.getUuid().slice(0, 8));
  // Ensure uniqueness
  if (departments.some(function (d) { return String(d.DepartmentID) === deptId; })) {
    deptId += '-' + Utilities.getUuid().slice(0, 4);
  }

  const now = new Date().toISOString();
  appendV2Records_('M_Departments', [{
    DepartmentID: deptId,
    DepartmentCode: cleanCode || deptId,
    DepartmentName: input,
    DepartmentEmail: '',
    Active: 'TRUE',
    CreatedAt: now,
    UpdatedAt: now,
  }]);

  return deptId;
}

function createV2UserPinHash_(pin) {
  if (typeof pin !== 'string' || pin.length < 8 || pin.length > 128) {
    throw new ApiError_('VALIDATION_ERROR', 'PIN must contain 8 to 128 characters.');
  }
  const salt = v2RandomBytes_(16);
  const mac = v2PinMac_(pin, salt);
  return 'HMAC-SHA256$v2$' +
    Utilities.base64EncodeWebSafe(salt).replace(/=+$/, '') + '$' +
    Utilities.base64EncodeWebSafe(mac).replace(/=+$/, '');
}

function v2RandomBytes_(length) {
  let hex = '';
  while (hex.length < length * 2) {
    hex += Utilities.getUuid().replace(/-/g, '');
  }
  const bytes = [];
  for (let index = 0; index < length * 2; index += 2) {
    bytes.push(parseInt(hex.substr(index, 2), 16));
  }
  return bytes;
}

function writeV2AuditSafe_(record) {
  try {
    appendV2Records_('L_AuditLog', [{
      AuditID: 'AUD-' + Utilities.getUuid(),
      Timestamp: new Date().toISOString(),
      UserID: record.UserID || '',
      StaffID: record.StaffID || '',
      Action: record.Action || '',
      EntityType: record.EntityType || '',
      EntityID: record.EntityID || '',
      ReservationID: record.ReservationID || '',
      OldValueJSON: record.OldValueJSON || '',
      NewValueJSON: record.NewValueJSON || '',
      Reason: record.Reason || '',
      SessionID: record.SessionID || '',
      RequestID: record.RequestID || '',
    }]);
  } catch (_ignored) {}
}
