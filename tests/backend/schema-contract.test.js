const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SCHEMA_PATH = 'backend/SchemaService.gs';
const REQUIRED_SETTING_KEYS = [
  'ORDER_PREFIX', 'SESSION_TIMEOUT_MINUTES', 'SESSION_TOUCH_INTERVAL_MINUTES', 'UPDATE_EMAIL_ENABLED', 'CANCEL_EMAIL_ENABLED',
  'STAFF_CAN_EDIT_ORDERED', 'STAFF_CAN_CANCEL_ORDERED', 'DASHBOARD_CACHE_SECONDS',
  'UPCOMING_REQUIRED_DATE_DAYS', 'TIMEZONE', 'LOGO_URL', 'ADMIN_NOTIFICATION_EMAIL',
  'UPDATE_NOTIFICATION_CC', 'APPOINTMENT_REMINDER_ENABLED', 'APPOINTMENT_REMINDER_HOUR',
  'APPOINTMENT_ACTION_TOKEN_HOURS', ['ALLOW_EMAIL_RECEIVED_ACTION', '_WITHOUT_LOGIN'].join(''),
  ['ALLOW_EMAIL_NO_SHOW_ACTION', '_WITHOUT_LOGIN'].join(''), 'RESCHEDULE_REQUIRES_LOGIN',
  'APPOINTMENT_REMINDER_RETRY_LIMIT', 'DEPARTMENT_EMAIL_REQUIRED',
  'PATIENT_RECEIVED_AUTO_COMPLETE', ['CANCELLATION_REQUIRES_ADMIN', '_APPROVAL'].join(''),
  'LOGIN_IDENTITY_FAILURE_LIMIT', 'LOGIN_GLOBAL_FAILURE_LIMIT', 'LOGIN_FAILURE_WINDOW_MINUTES',
  'LOGIN_LOCKOUT_MINUTES', 'LOGIN_GLOBAL_THROTTLE_STATE',
];

const REQUIRED_SETTINGS = [
  ['ORDER_PREFIX', 'MED'], ['SESSION_TIMEOUT_MINUTES', '30'], ['SESSION_TOUCH_INTERVAL_MINUTES', '2'], ['UPDATE_EMAIL_ENABLED', 'TRUE'],
  ['CANCEL_EMAIL_ENABLED', 'TRUE'], ['STAFF_CAN_EDIT_ORDERED', 'TRUE'], ['STAFF_CAN_CANCEL_ORDERED', 'TRUE'],
  ['DASHBOARD_CACHE_SECONDS', '60'], ['UPCOMING_REQUIRED_DATE_DAYS', '7'], ['TIMEZONE', 'Asia/Bangkok'],
  ['LOGO_URL', ''], ['ADMIN_NOTIFICATION_EMAIL', ''], ['UPDATE_NOTIFICATION_CC', ''],
  ['APPOINTMENT_REMINDER_ENABLED', 'TRUE'], ['APPOINTMENT_REMINDER_HOUR', '7'],
  ['APPOINTMENT_ACTION_TOKEN_HOURS', '168'], [['ALLOW_EMAIL_RECEIVED_ACTION', '_WITHOUT_LOGIN'].join(''), 'TRUE'],
  [['ALLOW_EMAIL_NO_SHOW_ACTION', '_WITHOUT_LOGIN'].join(''), 'TRUE'], ['RESCHEDULE_REQUIRES_LOGIN', 'TRUE'],
  ['APPOINTMENT_REMINDER_RETRY_LIMIT', '3'], ['DEPARTMENT_EMAIL_REQUIRED', 'TRUE'],
  ['PATIENT_RECEIVED_AUTO_COMPLETE', 'TRUE'], [['CANCELLATION_REQUIRES_ADMIN', '_APPROVAL'].join(''), 'FALSE'],
  ['LOGIN_IDENTITY_FAILURE_LIMIT', '5'], ['LOGIN_GLOBAL_FAILURE_LIMIT', '50'],
  ['LOGIN_FAILURE_WINDOW_MINUTES', '15'], ['LOGIN_LOCKOUT_MINUTES', '15'],
  ['LOGIN_GLOBAL_THROTTLE_STATE', ''],
];

const REQUIRED_MASTER_DATA = {
  DOSAGE_FORM: ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'ORAL_SOLUTION', 'INJECTION', 'CREAM', 'OINTMENT', 'GEL', 'EYE_DROPS', 'EAR_DROPS', 'NASAL_SPRAY', 'INHALER', 'SUPPOSITORY', 'PATCH', 'POWDER', 'GRANULE', 'SOLUTION', 'OTHER'],
  UNIT: ['TABLET', 'CAPSULE', 'BOTTLE', 'VIAL', 'AMPOULE', 'TUBE', 'BOX', 'PACK', 'SACHET', 'PIECE', 'ML', 'G', 'MG', 'DOSE', 'INHALER', 'PATCH', 'SUPPOSITORY', 'OTHER'],
  PRIORITY: ['NORMAL', 'URGENT', 'CRITICAL'],
  CANCEL_REASON: ['PATIENT_CANCELLED', 'TREATMENT_CHANGED', 'MEDICATION_CHANGED', 'TRANSFERRED', 'DUPLICATE_ORDER', 'DECEASED', 'OTHER'],
  NO_SHOW_REASON: ['UNREACHABLE', 'PATIENT_UNAVAILABLE', 'TREATED_ELSEWHERE', 'REFUSED_MEDICATION', 'DECEASED', 'UNKNOWN', 'OTHER'],
};

const REQUIRED_HEADERS = Object.freeze({
  Users: ['StaffID', 'FullName', 'Department', 'Email', 'Role', 'PINHash', 'Active', 'CreatedAt', 'UpdatedAt', 'FailedLoginWindowStartedAt', 'FailedLoginCount', 'LoginLockedUntil', 'LastFailedLoginAt'],
  Departments: ['DepartmentCode', 'DepartmentName', 'DepartmentEmail', 'CCEmail', 'Active', 'UpdatedAt', 'UpdatedBy'],
  OrderHeaders: ['OrderID', 'ClientRequestID', 'CreatedAt', 'CreatedByStaffID', 'CreatedByName', 'Department', 'RequesterEmail', 'RequesterPhone', 'HN', 'PatientName', 'WardClinic', 'RequiredDate', 'Priority', 'Status', 'ItemCount', 'Version', 'CreatedSource', 'UpdatedAt', 'UpdatedBy', 'LastChangeSetID', 'LastChangeType', 'LastChangeReason', 'LastChangedAt', 'LastChangedBy', 'CancelledAt', 'CancelledBy', 'CancelReason', 'NotificationStatus', 'LastEmailSentAt', 'LastEmailSentBy', 'UpdateNotificationStatus', 'LastUpdateEmailSentAt', 'AppointmentSequence', 'LastAppointmentReminderAt', 'LastAppointmentReminderSequence', 'AppointmentResponseStatus', 'AppointmentRespondedAt', 'AppointmentRespondedBy', 'PatientReceivedAt', 'NoShowReasonCode', 'NoShowReasonDetail', 'NoShowRecordedAt', 'NoShowCount', 'LastRequiredDate', 'LastRescheduledAt', 'LastRescheduledBy', 'LastRescheduleReason', 'CancellationPreviousStatus', 'CancellationRequestID', 'CancellationRequestedAt', 'CancellationRequestedBy', 'CancellationDecision', 'CancellationDecisionAt', 'CancellationDecisionBy', 'CancellationDecisionReason'],
  OrderItems: ['OrderItemID', 'OrderID', 'ItemNo', 'GenericName', 'BrandName', 'Strength', 'DosageForm', 'RequestedQuantity', 'Unit', 'Prescriber', 'ItemStatus', 'ReceivedDate', 'ReceivedQuantity', 'ReceivedUnit', 'AdminNote', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Active', 'CancellationPreviousStatus'],
  OrderChangeLog: ['ChangeLogID', 'ChangeSetID', 'OrderID', 'OrderItemID', 'ChangedAt', 'ChangedByStaffID', 'ChangedByName', 'Department', 'ChangedByRole', 'ActionType', 'FieldName', 'FieldLabel', 'OldValue', 'NewValue', 'ChangeReason', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Source', 'Result'],
  EmailLog: ['EmailLogID', 'OrderID', 'ChangeSetID', 'EmailType', 'Recipient', 'CC', 'Subject', 'SentAt', 'SentBy', 'Result', 'ErrorMessage', 'RetryCount'],
  AuditLog: ['AuditID', 'Timestamp', 'StaffID', 'Role', 'Department', 'Action', 'OrderID', 'OrderItemID', 'RequestID', 'OldValue', 'NewValue', 'Result', 'Detail'],
  Settings: ['Key', 'Value', 'Description', 'UpdatedAt', 'UpdatedBy'],
  MasterData: ['Type', 'Code', 'DisplayName', 'SortOrder', 'Active', 'UpdatedAt'],
  Sessions: ['SessionTokenHash', 'StaffID', 'CreatedAt', 'ExpiresAt', 'LastActiveAt', 'Active'],
  RequestLog: ['RequestID', 'Action', 'OrderID', 'StaffID', 'CreatedAt', 'Result', 'ResponseData'],
  AppointmentResponseLog: ['ResponseLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ActionType', 'ResponseAt', 'ResponseSource', 'RespondedByStaffID', 'RespondedByName', 'Department', 'ReasonCode', 'ReasonDetail', 'OldRequiredDate', 'NewRequiredDate', 'ActionTokenID', 'ChangeSetID', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Result', 'ErrorMessage'],
  AppointmentReminderLog: ['ReminderLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ReminderType', 'Recipient', 'CC', 'SentAt', 'Result', 'ErrorMessage', 'ActionTokenGroupID', 'RetryCount'],
  ActionTokens: ['TokenID', 'TokenHash', 'OrderID', 'AppointmentSequence', 'ActionType', 'Department', 'CreatedAt', 'ExpiresAt', 'UsedAt', 'UsedBy', 'Status', 'ReminderLogID', 'RequestID', 'CancellationRequestID', 'CancellationPreviousStatus'],
});

function schemaSource() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function parsedSchemaDeclarations() {
  return vm.runInNewContext(`${schemaSource()}\n({ SCHEMA_, DEFAULT_SETTINGS_, DEFAULT_MASTER_DATA_ });`);
}

test('schema service declares every required sheet with exact ordered headers', () => {
  const { SCHEMA_ } = parsedSchemaDeclarations();

  for (const [sheetName, headers] of Object.entries(REQUIRED_HEADERS)) {
    assert.ok(SCHEMA_[sheetName], `missing ${sheetName} schema`);
    assert.deepEqual(Array.from(SCHEMA_[sheetName].headers), headers, `${sheetName} headers differ from the approved schema`);
  }
  assert.deepEqual(Object.keys(SCHEMA_), Object.keys(REQUIRED_HEADERS), 'schema sheets must be exact and ordered');
});

test('schema service is additive and avoids fixed business column indexes', () => {
  const source = schemaSource();

  for (const name of ['initializeDatabase', 'getDatabaseHealth', 'scheduledSchemaCheck', 'getHeaderMap_']) {
    assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`));
  }
  assert.doesNotMatch(source, /ensureApplicationReady_/);
  assert.match(source, /append only missing headers/i);
  assert.match(source, /setNumberFormat\(['\"]@['\"]\)/);
  assert.match(source, /setFrozenRows\(1\)/);
  assert.doesNotMatch(source, /getRange\s*\(\s*[^,]+\s*,\s*[2-9]\d*\s*(?:,|\))/);
});

test('schema service defines exact Settings and MasterData seed arrays', () => {
  const { DEFAULT_SETTINGS_, DEFAULT_MASTER_DATA_ } = parsedSchemaDeclarations();

  assert.deepEqual(Array.from(DEFAULT_SETTINGS_, (setting) => Array.from(setting).slice(0, 2)), REQUIRED_SETTINGS);
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_MASTER_DATA_)), REQUIRED_MASTER_DATA);
  assert.deepEqual(Array.from(DEFAULT_SETTINGS_, (setting) => setting[0]), REQUIRED_SETTING_KEYS);
});

test('repository limits zero explicitly and updates only contiguous mapped cells', () => {
  const source = fs.readFileSync('backend/SheetRepository.gs', 'utf8');

  assert.match(source, /hasOwnProperty\.call\(options, ['\"]limit['\"]\)/, 'limit: 0 must be distinguished from an omitted limit');
  assert.match(source, /writeContiguousUpdateRanges_/, 'updates must be grouped into contiguous column ranges');
  assert.doesNotMatch(source, /getRange\(rowNumber, 1, 1, lastColumn\)[\s\S]*?setValues\(\[row\]\)/, 'whole-row writes destroy formulas and concurrent custom-column changes');
});

test('Apps Script schema runner checks seed idempotency and repository formula safety', () => {
  const source = fs.readFileSync('backend/Tests.gs', 'utf8');

  assert.match(source, /settingsRowsBeforeRepeat/);
  assert.match(source, /masterDataRowsBeforeRepeat/);
  assert.match(source, /getFormula\(/);
  assert.match(source, /custom column/i);
});
