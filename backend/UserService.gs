function findUserByStaffId_(staffId) {
  const normalized = String(staffId || '').trim();
  if (!normalized) return null;
  const users = readRecords_('Users', { predicate: function (user) { return String(user.StaffID || '') === normalized; }, limit: 1 });
  return users.length ? users[0] : null;
}

function userIsActive_(user) {
  return !!user && String(user.Active || '').toUpperCase() === 'TRUE';
}

function trustedIdentity_(user) {
  if (!user) return null;
  const identity = {
    StaffID: String(user.StaffID || ''),
    FullName: String(user.FullName || ''),
    Department: String(user.Department || ''),
    Email: String(user.Email || ''),
    Role: String(user.Role || '').toUpperCase(),
    PINHash: user.PINHash,
  };
  delete identity.PINHash;
  return identity;
}

function listUsers_(context) {
  if (!context || !context.user || String(context.user.Role || '').toUpperCase() !== 'ADMIN') {
    throw new ApiError_('FORBIDDEN', 'Only administrators can manage users.');
  }
  const users = readRecords_('Users');
  return {
    users: users.map(function (u) {
      return {
        StaffID: String(u.StaffID || ''),
        FullName: String(u.FullName || ''),
        Department: String(u.Department || ''),
        Email: String(u.Email || ''),
        Role: String(u.Role || '').toUpperCase(),
        Active: String(u.Active || '').toUpperCase() === 'TRUE',
        CreatedAt: String(u.CreatedAt || ''),
        UpdatedAt: String(u.UpdatedAt || ''),
      };
    }),
  };
}

function createUserByAdmin_(context, payload) {
  if (!context || !context.user || String(context.user.Role || '').toUpperCase() !== 'ADMIN') {
    throw new ApiError_('FORBIDDEN', 'Only administrators can create users.');
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const fullName = String(payload.fullName || '').trim();
  const department = String(payload.department || '').trim();
  const email = String(payload.email || '').trim();
  const role = String(payload.role || 'STAFF').toUpperCase();
  const pin = String(payload.pin || '').trim();

  if (!staffId) throw new ApiError_('VALIDATION_ERROR', 'Staff ID is required.');
  if (!fullName) throw new ApiError_('VALIDATION_ERROR', 'Full Name is required.');
  if (!department) throw new ApiError_('VALIDATION_ERROR', 'Department is required.');
  if (['STAFF', 'ADMIN'].indexOf(role) < 0) throw new ApiError_('VALIDATION_ERROR', 'Role must be STAFF or ADMIN.');
  if (!pin || pin.length < 8 || pin.length > 128) throw new ApiError_('VALIDATION_ERROR', 'PIN must be 8 to 128 characters.');

  const existing = findUserByStaffId_(staffId);
  if (existing) throw new ApiError_('DUPLICATE_USER', 'A user with this Staff ID already exists.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const pinHash = createPinHash_(pin);
    const now = new Date().toISOString();
    const newUser = {
      StaffID: staffId,
      FullName: fullName,
      Department: department,
      Email: email,
      Role: role,
      PINHash: pinHash,
      Active: 'TRUE',
      CreatedAt: now,
      UpdatedAt: now,
      FailedLoginWindowStartedAt: '',
      FailedLoginCount: 0,
      LoginLockedUntil: '',
      LastFailedLoginAt: '',
    };
    appendRecords_('Users', [newUser]);
    writeAudit_({ StaffID: context.user.StaffID, Role: context.user.Role, Department: context.user.Department, Action: 'CREATE_USER', Result: 'SUCCESS', Detail: JSON.stringify({ createdStaffId: staffId, role: role }) });
    return { success: true, staffId: staffId };
  } finally {
    lock.releaseLock();
  }
}

function resetUserPinByAdmin_(context, payload) {
  if (!context || !context.user || String(context.user.Role || '').toUpperCase() !== 'ADMIN') {
    throw new ApiError_('FORBIDDEN', 'Only administrators can reset user PINs.');
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const newPin = String(payload.newPin || '').trim();

  if (!staffId) throw new ApiError_('VALIDATION_ERROR', 'Staff ID is required.');
  if (!newPin || newPin.length < 8 || newPin.length > 128) throw new ApiError_('VALIDATION_ERROR', 'New PIN must be 8 to 128 characters.');

  const user = findUserByStaffId_(staffId);
  if (!user) throw new ApiError_('USER_NOT_FOUND', 'User not found.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const pinHash = createPinHash_(newPin);
    const now = new Date().toISOString();
    updateRecordByKey_('Users', 'StaffID', staffId, {
      PINHash: pinHash,
      FailedLoginWindowStartedAt: '',
      FailedLoginCount: 0,
      LoginLockedUntil: '',
      LastFailedLoginAt: '',
      UpdatedAt: now,
    });
    writeAudit_({ StaffID: context.user.StaffID, Role: context.user.Role, Department: context.user.Department, Action: 'RESET_USER_PIN', Result: 'SUCCESS', Detail: JSON.stringify({ targetStaffId: staffId }) });
    return { success: true, staffId: staffId };
  } finally {
    lock.releaseLock();
  }
}

function updateUserByAdmin_(context, payload) {
  if (!context || !context.user || String(context.user.Role || '').toUpperCase() !== 'ADMIN') {
    throw new ApiError_('FORBIDDEN', 'Only administrators can update users.');
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  if (!staffId) throw new ApiError_('VALIDATION_ERROR', 'Staff ID is required.');
  const user = findUserByStaffId_(staffId);
  if (!user) throw new ApiError_('USER_NOT_FOUND', 'User not found.');

  const updates = { UpdatedAt: new Date().toISOString() };
  if (payload.fullName !== undefined) updates.FullName = String(payload.fullName).trim();
  if (payload.department !== undefined) updates.Department = String(payload.department).trim();
  if (payload.email !== undefined) updates.Email = String(payload.email).trim();
  if (payload.role !== undefined && ['STAFF', 'ADMIN'].indexOf(String(payload.role).toUpperCase()) >= 0) updates.Role = String(payload.role).toUpperCase();
  if (payload.active !== undefined) updates.Active = payload.active ? 'TRUE' : 'FALSE';

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    updateRecordByKey_('Users', 'StaffID', staffId, updates);
    writeAudit_({ StaffID: context.user.StaffID, Role: context.user.Role, Department: context.user.Department, Action: 'UPDATE_USER', Result: 'SUCCESS', Detail: JSON.stringify({ targetStaffId: staffId }) });
    return { success: true, staffId: staffId };
  } finally {
    lock.releaseLock();
  }
}

function seedDefaultAdminUser_() {
  const users = readRecords_('Users');
  const hasAdmin = users.some(function (u) { return String(u.Role || '').toUpperCase() === 'ADMIN'; });
  if (hasAdmin) return { seeded: false };

  const defaultAdmin = {
    StaffID: 'ADMIN01',
    FullName: 'System Administrator',
    Department: 'PHARMACY',
    Email: 'admin@hospital.com',
    Role: 'ADMIN',
    PINHash: createPinHash_('12345678'),
    Active: 'TRUE',
    CreatedAt: new Date().toISOString(),
    UpdatedAt: new Date().toISOString(),
    FailedLoginWindowStartedAt: '',
    FailedLoginCount: 0,
    LoginLockedUntil: '',
    LastFailedLoginAt: '',
  };
  appendRecords_('Users', [defaultAdmin]);
  return { seeded: true, staffId: 'ADMIN01', defaultPin: '12345678' };
}
