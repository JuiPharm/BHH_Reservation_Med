/**
 * V2 user/RBAC bootstrap helpers for the Drug Reservation Database.
 *
 * Operator-only: no function in this file is exposed through ApiRouter.gs.
 * The helper provisions the initial UAT SYSTEM_ADMIN using the existing
 * HMAC-SHA256$v2 credential implementation so APP_SECRET never leaves
 * Apps Script.
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

function provisionInitialV2Admin() {
  const properties = PropertiesService.getScriptProperties();
  if (String(properties.getProperty('V2_BOOTSTRAP_ENABLED') || '').toUpperCase() !== 'TRUE') {
    throw new Error('V2 bootstrap is disabled. Set V2_BOOTSTRAP_ENABLED=TRUE only for the controlled bootstrap run.');
  }

  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID_V2') || '').trim();
  const staffId = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_STAFF_ID') || 'ADMIN01').trim();
  const staffName = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_NAME') || 'UAT System Administrator').trim();
  const departmentId = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_DEPARTMENT_ID') || 'DEPT-PHARMACY').trim();
  const temporaryPassword = String(properties.getProperty('V2_BOOTSTRAP_ADMIN_PASSWORD') || '');

  if (!spreadsheetId) throw new Error('SPREADSHEET_ID_V2 is required.');
  if (!staffId) throw new Error('V2 bootstrap admin StaffID is required.');
  if (!staffName) throw new Error('V2 bootstrap admin name is required.');
  if (!departmentId) throw new Error('V2 bootstrap admin DepartmentID is required.');
  assertV2BootstrapPasswordPolicy_(temporaryPassword);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const usersSheet = requireV2Sheet_(spreadsheet, 'T_Users');
    const departmentsSheet = requireV2Sheet_(spreadsheet, 'M_Departments');

    assertV2DepartmentActive_(departmentsSheet, departmentId);

    const now = new Date().toISOString();
    const passwordHash = createV2BootstrapPasswordHash_(temporaryPassword);
    const existing = findV2RowByValue_(usersSheet, 'StaffID', staffId);
    const existingValues = existing ? existing.record : {};
    const nextVersion = Math.max(0, Number(existingValues.Version || 0)) + 1;
    const userId = String(existingValues.UserID || 'USR-UAT-ADMIN-001');
    const registeredAt = String(existingValues.RegisteredAt || now);
    const createdAt = String(existingValues.CreatedAt || now);

    const record = Object.assign({}, existingValues, {
      UserID: userId,
      StaffID: staffId,
      StaffName: staffName,
      PersonalEmail: String(existingValues.PersonalEmail || ''),
      DepartmentID: departmentId,
      PasswordHash: passwordHash,
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

    upsertV2Record_(usersSheet, 'StaffID', staffId, record);
    appendV2Audit_(spreadsheet, {
      AuditID: 'AUD-' + Utilities.getUuid(),
      Timestamp: now,
      UserID: userId,
      StaffID: staffId,
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

    // Remove the one-time password immediately after a successful write.
    properties.deleteProperty('V2_BOOTSTRAP_ADMIN_PASSWORD');
    properties.setProperty('V2_BOOTSTRAP_ENABLED', 'FALSE');

    return {
      success: true,
      userId: userId,
      staffId: staffId,
      role: 'SYSTEM_ADMIN',
      accountStatus: 'ACTIVE',
      departmentId: departmentId,
      version: nextVersion,
    };
  } finally {
    lock.releaseLock();
  }
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
    if (Object.prototype.hasOwnProperty.call(record, header)) row[headers[header] - 1] = record[header];
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
  const headers = v2HeaderMap_(sheet);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(headers).forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(record, header)) row[headers[header] - 1] = record[header];
  });
  sheet.getRange(Math.max(2, sheet.getLastRow() + 1), 1, 1, row.length).setValues([row]);
}

function redactV2UserForAudit_(record) {
  const safe = Object.assign({}, record || {});
  delete safe.PasswordHash;
  delete safe.PasswordSalt;
  return safe;
}


/**
 * Self-contained credential helpers for the one-time v2 bootstrap.
 * These deliberately use v2-specific names so this file can coexist with
 * SecurityService.gs without creating duplicate global function names.
 */
function assertV2BootstrapPasswordPolicy_(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('V2_BOOTSTRAP_ADMIN_PASSWORD must contain 8 to 128 characters.');
  }
}

function createV2BootstrapPasswordHash_(password) {
  assertV2BootstrapPasswordPolicy_(password);
  const salt = v2BootstrapRandomBytes_(16);
  const mac = v2BootstrapComputePasswordMac_(password, salt);
  return 'HMAC-SHA256$v2$' + v2BootstrapBase64WebSafeNoPadding_(salt) + '$' + v2BootstrapBase64WebSafeNoPadding_(mac);
}

function v2BootstrapComputePasswordMac_(password, salt) {
  const domain = Array.prototype.slice.call(
    Utilities.newBlob('MEDICATION_RESERVATION_PIN_V2\u0000').getBytes()
  );
  const passwordBytes = Array.prototype.slice.call(Utilities.newBlob(String(password)).getBytes());
  return Array.prototype.slice.call(
    Utilities.computeHmacSha256Signature(
      domain.concat(salt, passwordBytes),
      v2BootstrapAppSecretBytes_()
    )
  );
}

function v2BootstrapAppSecretBytes_() {
  const encoded = String(
    PropertiesService.getScriptProperties().getProperty('APP_SECRET') || ''
  ).trim();

  if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded)) {
    throw new Error('APP_SECRET is not configured correctly. It must be a 32-byte Base64URL secret.');
  }

  const bytes = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(encoded));
  if (bytes.length !== 32) {
    throw new Error('APP_SECRET is not configured correctly. It must decode to exactly 32 bytes.');
  }
  return bytes;
}

function v2BootstrapRandomBytes_(length) {
  let hex = '';
  while (hex.length < length * 2) hex += Utilities.getUuid().replace(/-/g, '');
  const bytes = [];
  for (let index = 0; index < length * 2; index += 2) {
    bytes.push(parseInt(hex.substr(index, 2), 16));
  }
  return bytes;
}

function v2BootstrapBase64WebSafeNoPadding_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
