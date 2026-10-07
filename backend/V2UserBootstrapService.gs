/**
 * V2 user/RBAC bootstrap helpers for the Drug Reservation Database.
 *
 * Operator-only. Nothing in this file is registered in ApiRouter.gs.
 * The initial UAT administrator is provisioned in T_Users using a server-side
 * HMAC-SHA256$v2 credential derived from APP_SECRET.
 */

const V2_ROLE_CODES_ = Object.freeze([
  'REQUESTER',
  'PHARMACY_OPERATOR',
  'PHARMACY_MANAGER',
  'SYSTEM_ADMIN',
  'REPORT_VIEWER',
]);

const V2_ACCOUNT_STATUSES_ = Object.freeze([
  'PENDING',
  'ACTIVE',
  'LOCKED',
  'DISABLED',
  'REJECTED',
]);

const V2_REQUIRED_USER_HEADERS_ = Object.freeze([
  'UserID','StaffID','StaffName','PersonalEmail','DepartmentID',
  'PasswordHash','PasswordSalt','PasswordAlgorithm','PasswordIterations',
  'Role','AccountStatus','FailedLoginCount','LockedUntil','RegisteredAt',
  'ApprovedBy','ApprovedAt','RejectedBy','RejectedAt','RejectReason',
  'LastLoginAt','PasswordChangedAt','CreatedAt','UpdatedAt','Version',
]);

const V2_REQUIRED_AUDIT_HEADERS_ = Object.freeze([
  'AuditID','Timestamp','UserID','StaffID','Action','EntityType','EntityID',
  'ReservationID','OldValueJSON','NewValueJSON','Reason','SessionID','RequestID',
]);

/**
 * Run this FIRST from the Apps Script editor.
 * It performs read-only validation and logs a safe result without secrets.
 */
function validateV2BootstrapConfig() {
  const result = inspectV2BootstrapConfig_();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Run only after validateV2BootstrapConfig() returns ok=true.
 */
function provisionInitialV2Admin() {
  const inspection = inspectV2BootstrapConfig_();

  // Idempotent re-run: if the account is already active with a credential,
  // do not require the temporary PIN again and do not rotate the credential.
  if (inspection.alreadyProvisioned) {
    cleanupV2BootstrapProperties_();
    return {
      success: true,
      alreadyProvisioned: true,
      userId: inspection.userId,
      staffId: inspection.staffId,
      role: 'SYSTEM_ADMIN',
      accountStatus: 'ACTIVE',
      departmentId: inspection.departmentId,
      version: inspection.version,
    };
  }

  if (!inspection.ok) {
    throw new Error(
      'V2 bootstrap preflight failed:\n- ' + inspection.errors.join('\n- ') +
      '\nRun validateV2BootstrapConfig() first and correct the listed settings.'
    );
  }

  const properties = PropertiesService.getScriptProperties();
  const bootstrapPin = getV2BootstrapPin_(properties);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Re-read under lock to prevent concurrent provisioning.
    const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID_V2') || '').trim();
    if (!spreadsheetId) throw new Error('SPREADSHEET_ID_V2 is required.');
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const usersSheet = requireV2Sheet_(spreadsheet, 'T_Users');
    const departmentsSheet = requireV2Sheet_(spreadsheet, 'M_Departments');
    assertV2DepartmentActive_(departmentsSheet, inspection.departmentId);

    const existing = findV2RowByValue_(usersSheet, 'StaffID', inspection.staffId);
    const existingValues = existing ? existing.record : {};

    if (
      String(existingValues.AccountStatus || '').toUpperCase() === 'ACTIVE' &&
      String(existingValues.PasswordHash || '').indexOf('HMAC-SHA256$v2$') === 0
    ) {
      cleanupV2BootstrapProperties_();
      return {
        success: true,
        alreadyProvisioned: true,
        userId: String(existingValues.UserID || ''),
        staffId: inspection.staffId,
        role: String(existingValues.Role || 'SYSTEM_ADMIN'),
        accountStatus: 'ACTIVE',
        departmentId: String(existingValues.DepartmentID || inspection.departmentId),
        version: Number(existingValues.Version || 1),
      };
    }

    const now = new Date().toISOString();
    const credentialHash = createV2BootstrapPinHash_(bootstrapPin);
    const nextVersion = Math.max(0, Number(existingValues.Version || 0)) + 1;
    const userId = String(existingValues.UserID || 'USR-UAT-ADMIN-001');
    const registeredAt = String(existingValues.RegisteredAt || now);
    const createdAt = String(existingValues.CreatedAt || now);

    const record = Object.assign({}, existingValues, {
      UserID: userId,
      StaffID: inspection.staffId,
      StaffName: inspection.staffName,
      PersonalEmail: String(existingValues.PersonalEmail || ''),
      DepartmentID: inspection.departmentId,
      PasswordHash: credentialHash,
      PasswordSalt: '',
      PasswordAlgorithm: 'HMAC-SHA256$v2',
      PasswordIterations: 1,
      Role: 'SYSTEM_ADMIN',
      AccountStatus: 'ACTIVE',
      FailedLoginCount: 0,
      LockedUntil: '',
      RegisteredAt: registeredAt,
      ApprovedBy: 'SYSTEM_BOOTSTRAP',
      ApprovedAt: now,
      RejectedBy: '',
      RejectedAt: '',
      RejectReason: '',
      LastLoginAt: String(existingValues.LastLoginAt || ''),
      PasswordChangedAt: now,
      CreatedAt: createdAt,
      UpdatedAt: now,
      Version: nextVersion,
    });

    upsertV2Record_(usersSheet, 'StaffID', inspection.staffId, record);

    appendV2Audit_(spreadsheet, {
      AuditID: 'AUD-' + Utilities.getUuid(),
      Timestamp: now,
      UserID: userId,
      StaffID: inspection.staffId,
      Action: 'PROVISION_INITIAL_SYSTEM_ADMIN',
      EntityType: 'USER',
      EntityID: userId,
      ReservationID: '',
      OldValueJSON: existing ? JSON.stringify(redactV2UserForAudit_(existingValues)) : '',
      NewValueJSON: JSON.stringify(redactV2UserForAudit_(record)),
      Reason: 'Controlled UAT bootstrap',
      SessionID: '',
      RequestID: '',
    });

    cleanupV2BootstrapProperties_();

    return {
      success: true,
      alreadyProvisioned: false,
      userId: userId,
      staffId: inspection.staffId,
      role: 'SYSTEM_ADMIN',
      accountStatus: 'ACTIVE',
      departmentId: inspection.departmentId,
      version: nextVersion,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Safe preflight. It never returns APP_SECRET or the temporary PIN.
 */
function inspectV2BootstrapConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID_V2') || '').trim();
  const staffId = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_STAFF_ID') || 'ADMIN01').trim();
  const staffName = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_NAME') || 'UAT System Administrator').trim();
  const departmentId = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_DEPARTMENT_ID') || 'DEPT-PHARMACY').trim();
  const enabled = String(properties.getProperty('V2_BOOTSTRAP_ENABLED') || '').toUpperCase() === 'TRUE';

  const errors = [];
  const warnings = [];

  if (!spreadsheetId) errors.push('Missing Script Property: SPREADSHEET_ID_V2.');
  if (!staffId) errors.push('V2 bootstrap admin StaffID is empty.');
  if (!staffName) errors.push('V2 bootstrap admin name is empty.');
  if (!departmentId) errors.push('V2 bootstrap admin DepartmentID is empty.');

  const secretCheck = validateV2AppSecret_();
  if (!secretCheck.ok) errors.push(secretCheck.message);

  let spreadsheet = null;
  let existing = null;
  let version = 0;
  let userId = '';

  if (spreadsheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(spreadsheetId);
      const usersSheet = requireV2Sheet_(spreadsheet, 'T_Users');
      const departmentsSheet = requireV2Sheet_(spreadsheet, 'M_Departments');
      const auditSheet = requireV2Sheet_(spreadsheet, 'L_AuditLog');

      assertV2Headers_(usersSheet, V2_REQUIRED_USER_HEADERS_);
      assertV2Headers_(auditSheet, V2_REQUIRED_AUDIT_HEADERS_);
      assertV2DepartmentActive_(departmentsSheet, departmentId);

      existing = findV2RowByValue_(usersSheet, 'StaffID', staffId);
      if (existing) {
        userId = String(existing.record.UserID || '');
        version = Number(existing.record.Version || 0);
      }
    } catch (error) {
      errors.push('Database validation failed: ' + String(error && error.message || error));
    }
  }

  const alreadyProvisioned = Boolean(
    existing &&
    String(existing.record.AccountStatus || '').toUpperCase() === 'ACTIVE' &&
    String(existing.record.Role || '').toUpperCase() === 'SYSTEM_ADMIN' &&
    String(existing.record.PasswordHash || '').indexOf('HMAC-SHA256$v2$') === 0
  );

  if (!alreadyProvisioned) {
    if (!enabled) errors.push('Set Script Property V2_BOOTSTRAP_ENABLED=TRUE for the one-time UAT bootstrap.');

    const pinInfo = getV2BootstrapPinInfo_(properties);
    if (!pinInfo.present) {
      errors.push(
        'Set Script Property V2_BOOTSTRAP_ADMIN_PIN to a temporary PIN of 8-128 characters. ' +
        'The older V2_BOOTSTRAP_ADMIN_PASSWORD name is accepted only for backward compatibility.'
      );
    } else if (!pinInfo.valid) {
      errors.push('V2_BOOTSTRAP_ADMIN_PIN must contain 8-128 characters.');
    } else if (pinInfo.legacyNameUsed) {
      warnings.push(
        'Legacy Script Property V2_BOOTSTRAP_ADMIN_PASSWORD is being used. ' +
        'Rename it to V2_BOOTSTRAP_ADMIN_PIN when convenient.'
      );
    }
  } else {
    warnings.push('ADMIN01 is already provisioned as an ACTIVE SYSTEM_ADMIN; no credential rotation is required.');
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    spreadsheetConfigured: Boolean(spreadsheetId),
    databaseValidated: Boolean(spreadsheet) && errors.filter(function (message) {
      return message.indexOf('Database validation failed:') === 0;
    }).length === 0,
    bootstrapEnabled: enabled,
    appSecretConfigured: secretCheck.ok,
    pinConfigured: alreadyProvisioned ? true : getV2BootstrapPinInfo_(properties).valid,
    alreadyProvisioned: alreadyProvisioned,
    userId: userId || 'USR-UAT-ADMIN-001',
    staffId: staffId,
    staffName: staffName,
    departmentId: departmentId,
    role: 'SYSTEM_ADMIN',
    accountStatus: alreadyProvisioned ? 'ACTIVE' : (existing ? String(existing.record.AccountStatus || 'PENDING') : 'PENDING'),
    version: version,
  };
}

function getV2BootstrapPinInfo_(properties) {
  const canonical = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_PIN') || '');
  const legacy = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_PASSWORD') || '');
  const value = canonical || legacy;
  return {
    present: value.length > 0,
    valid: value.length >= 8 && value.length <= 128,
    legacyNameUsed: !canonical && Boolean(legacy),
  };
}

function getV2BootstrapPin_(properties) {
  const info = getV2BootstrapPinInfo_(properties);
  if (!info.present) {
    throw new Error('Missing Script Property V2_BOOTSTRAP_ADMIN_PIN.');
  }
  const pin = String(
    properties.getProperty('V2_BOOTSTRAP_ADMIN_PIN') ||
    properties.getProperty('V2_BOOTSTRAP_ADMIN_PASSWORD') ||
    ''
  );
  assertV2BootstrapPinPolicy_(pin);
  return pin;
}

function cleanupV2BootstrapProperties_() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty('V2_BOOTSTRAP_ADMIN_PIN');
  properties.deleteProperty('V2_BOOTSTRAP_ADMIN_PASSWORD');
  properties.setProperty('V2_BOOTSTRAP_ENABLED', 'FALSE');
}

function requireV2Sheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing required v2 sheet: ' + sheetName);
  return sheet;
}

function v2HeaderMap_(sheet) {
  const width = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  const map = {};
  headers.forEach(function (header, index) {
    const key = String(header || '').trim();
    if (key) map[key] = index + 1;
  });
  return map;
}

function assertV2Headers_(sheet, requiredHeaders) {
  const headers = v2HeaderMap_(sheet);
  const missing = requiredHeaders.filter(function (header) {
    return !headers[header];
  });
  if (missing.length) {
    throw new Error(sheet.getName() + ' is missing columns: ' + missing.join(', '));
  }
}

function findV2RowByValue_(sheet, keyHeader, keyValue) {
  const headers = v2HeaderMap_(sheet);
  const keyColumn = headers[keyHeader];
  if (!keyColumn) throw new Error('Missing required column ' + keyHeader + ' in ' + sheet.getName() + '.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][keyColumn - 1] || '').trim() === String(keyValue || '').trim()) {
      const record = {};
      Object.keys(headers).forEach(function (header) {
        record[header] = values[index][headers[header] - 1];
      });
      return { rowNumber: index + 2, record: record };
    }
  }
  return null;
}

function upsertV2Record_(sheet, keyHeader, keyValue, record) {
  const headers = v2HeaderMap_(sheet);
  const existing = findV2RowByValue_(sheet, keyHeader, keyValue);
  const rowNumber = existing ? existing.rowNumber : Math.max(2, sheet.getLastRow() + 1);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(headers).forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(record, header)) {
      row[headers[header] - 1] = record[header];
    }
  });
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

function assertV2DepartmentActive_(sheet, departmentId) {
  const found = findV2RowByValue_(sheet, 'DepartmentID', departmentId);
  if (!found) throw new Error('V2 DepartmentID not found: ' + departmentId);
  const active = String(found.record.Active == null ? '' : found.record.Active).toUpperCase();
  if (active !== 'TRUE') throw new Error('V2 DepartmentID is not active: ' + departmentId);
}

function appendV2Audit_(spreadsheet, record) {
  const sheet = requireV2Sheet_(spreadsheet, 'L_AuditLog');
  assertV2Headers_(sheet, V2_REQUIRED_AUDIT_HEADERS_);
  const headers = v2HeaderMap_(sheet);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(headers).forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(record, header)) {
      row[headers[header] - 1] = record[header];
    }
  });
  sheet.getRange(Math.max(2, sheet.getLastRow() + 1), 1, 1, row.length).setValues([row]);
}

function redactV2UserForAudit_(record) {
  const safe = Object.assign({}, record || {});
  delete safe.PasswordHash;
  delete safe.PasswordSalt;
  return safe;
}

function assertV2BootstrapPinPolicy_(pin) {
  if (typeof pin !== 'string' || pin.length < 8 || pin.length > 128) {
    throw new Error('V2_BOOTSTRAP_ADMIN_PIN must contain 8 to 128 characters.');
  }
}

function createV2BootstrapPinHash_(pin) {
  assertV2BootstrapPinPolicy_(pin);
  const salt = v2BootstrapRandomBytes_(16);
  const mac = v2BootstrapComputePinMac_(pin, salt);
  return 'HMAC-SHA256$v2$' +
    v2BootstrapBase64WebSafeNoPadding_(salt) + '$' +
    v2BootstrapBase64WebSafeNoPadding_(mac);
}

function v2BootstrapComputePinMac_(pin, salt) {
  const domain = Array.prototype.slice.call(
    Utilities.newBlob('MEDICATION_RESERVATION_PIN_V2\u0000').getBytes()
  );
  const pinBytes = Array.prototype.slice.call(Utilities.newBlob(String(pin)).getBytes());
  return Array.prototype.slice.call(
    Utilities.computeHmacSha256Signature(
      domain.concat(salt, pinBytes),
      v2BootstrapAppSecretBytes_()
    )
  );
}

function validateV2AppSecret_() {
  try {
    v2BootstrapAppSecretBytes_();
    return { ok: true, message: '' };
  } catch (error) {
    return {
      ok: false,
      message: String(error && error.message || error),
    };
  }
}

function v2BootstrapAppSecretBytes_() {
  const encoded = String(
    PropertiesService.getScriptProperties().getProperty('APP_SECRET') || ''
  ).trim();

  if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded)) {
    throw new Error(
      'APP_SECRET is missing or invalid. It must be a 32-byte Base64URL secret ' +
      '(43 characters, optionally followed by =).'
    );
  }

  const bytes = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(encoded));
  if (bytes.length !== 32) {
    throw new Error('APP_SECRET is invalid because it does not decode to exactly 32 bytes.');
  }
  return bytes;
}

function v2BootstrapRandomBytes_(length) {
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

function v2BootstrapBase64WebSafeNoPadding_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
