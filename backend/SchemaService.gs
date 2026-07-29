/**
 * Google Sheets schema ownership.  This service is deliberately additive: it
 * never removes, renames, reorders, or overwrites an existing business column.
 */
const SPREADSHEET_ID_PROPERTY_ = 'SPREADSHEET_ID';
const SCHEMA_CACHE_KEY_ = schemaKey_('MEDICATION_RESERVATION_', 'SCHEMA_READY_V1');
const SCHEMA_CACHE_SECONDS_ = 21600;

const SCHEMA_ = Object.freeze({
  Users: Object.freeze({ headers: Object.freeze(['StaffID', 'FullName', 'Department', 'Email', 'Role', 'PINHash', 'Active', 'CreatedAt', 'UpdatedAt', 'FailedLoginWindowStartedAt', 'FailedLoginCount', 'LoginLockedUntil', 'LastFailedLoginAt']), plainTextColumns: Object.freeze(['StaffID']) }),
  Departments: Object.freeze({ headers: Object.freeze(['DepartmentCode', 'DepartmentName', 'DepartmentEmail', 'CCEmail', 'Active', 'UpdatedAt', 'UpdatedBy']), plainTextColumns: Object.freeze([]) }),
  OrderHeaders: Object.freeze({ headers: Object.freeze(['OrderID', 'ClientRequestID', 'CreatedAt', 'CreatedByStaffID', 'CreatedByName', 'Department', 'RequesterEmail', 'RequesterPhone', 'HN', 'PatientName', 'WardClinic', 'RequiredDate', 'Priority', 'Status', 'ItemCount', 'Version', 'CreatedSource', 'UpdatedAt', 'UpdatedBy', 'LastChangeSetID', 'LastChangeType', 'LastChangeReason', 'LastChangedAt', 'LastChangedBy', 'CancelledAt', 'CancelledBy', 'CancelReason', 'NotificationStatus', 'LastEmailSentAt', 'LastEmailSentBy', 'UpdateNotificationStatus', 'LastUpdateEmailSentAt', 'AppointmentSequence', 'LastAppointmentReminderAt', 'LastAppointmentReminderSequence', 'AppointmentResponseStatus', 'AppointmentRespondedAt', 'AppointmentRespondedBy', 'PatientReceivedAt', 'NoShowReasonCode', 'NoShowReasonDetail', 'NoShowRecordedAt', 'NoShowCount', 'LastRequiredDate', 'LastRescheduledAt', 'LastRescheduledBy', 'LastRescheduleReason', 'CancellationPreviousStatus', 'CancellationRequestID', 'CancellationRequestedAt', 'CancellationRequestedBy', 'CancellationDecision', 'CancellationDecisionAt', 'CancellationDecisionBy', 'CancellationDecisionReason']), plainTextColumns: Object.freeze(['CreatedByStaffID', 'HN']) }),
  OrderItems: Object.freeze({ headers: Object.freeze(['OrderItemID', 'OrderID', 'ItemNo', 'GenericName', 'BrandName', 'Strength', 'DosageForm', 'RequestedQuantity', 'Unit', 'Prescriber', 'ItemStatus', 'ReceivedDate', 'ReceivedQuantity', 'ReceivedUnit', 'AdminNote', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Active', 'CancellationPreviousStatus']), plainTextColumns: Object.freeze([]) }),
  OrderChangeLog: Object.freeze({ headers: Object.freeze(['ChangeLogID', 'ChangeSetID', 'OrderID', 'OrderItemID', 'ChangedAt', 'ChangedByStaffID', 'ChangedByName', 'Department', 'ChangedByRole', 'ActionType', 'FieldName', 'FieldLabel', 'OldValue', 'NewValue', 'ChangeReason', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Source', 'Result']), plainTextColumns: Object.freeze(['ChangedByStaffID']) }),
  EmailLog: Object.freeze({ headers: Object.freeze(['EmailLogID', 'OrderID', 'ChangeSetID', 'EmailType', 'Recipient', 'CC', 'Subject', 'SentAt', 'SentBy', 'Result', 'ErrorMessage', 'RetryCount']), plainTextColumns: Object.freeze([]) }),
  NotificationQueue: Object.freeze({ headers: Object.freeze(['QueueID', 'TemplateName', 'ModelJSON', 'Status', 'CreatedAt', 'ProcessedAt', 'RetryCount', 'ErrorMessage']), plainTextColumns: Object.freeze([]) }),
  AuditLog: Object.freeze({ headers: Object.freeze(['AuditID', 'Timestamp', 'StaffID', 'Role', 'Department', 'Action', 'OrderID', 'OrderItemID', 'RequestID', 'OldValue', 'NewValue', 'Result', 'Detail']), plainTextColumns: Object.freeze(['StaffID']) }),
  Settings: Object.freeze({ headers: Object.freeze(['Key', 'Value', 'Description', 'UpdatedAt', 'UpdatedBy']), plainTextColumns: Object.freeze([]) }),
  MasterData: Object.freeze({ headers: Object.freeze(['Type', 'Code', 'DisplayName', 'SortOrder', 'Active', 'UpdatedAt']), plainTextColumns: Object.freeze([]) }),
  Sessions: Object.freeze({ headers: Object.freeze(['SessionTokenHash', 'StaffID', 'CreatedAt', 'ExpiresAt', 'LastActiveAt', 'Active']), plainTextColumns: Object.freeze(['StaffID']) }),
  RequestLog: Object.freeze({ headers: Object.freeze(['RequestID', 'Action', 'OrderID', 'StaffID', 'CreatedAt', 'Result', 'ResponseData']), plainTextColumns: Object.freeze(['StaffID']) }),
  AppointmentResponseLog: Object.freeze({ headers: Object.freeze(['ResponseLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ActionType', 'ResponseAt', 'ResponseSource', 'RespondedByStaffID', 'RespondedByName', 'Department', 'ReasonCode', 'ReasonDetail', 'OldRequiredDate', 'NewRequiredDate', 'ActionTokenID', 'ChangeSetID', 'OrderVersionBefore', 'OrderVersionAfter', 'RequestID', 'Result', 'ErrorMessage']), plainTextColumns: Object.freeze(['RespondedByStaffID']) }),
  AppointmentReminderLog: Object.freeze({ headers: Object.freeze(['ReminderLogID', 'OrderID', 'AppointmentSequence', 'AppointmentDate', 'ReminderType', 'Recipient', 'CC', 'SentAt', 'Result', 'ErrorMessage', 'ActionTokenGroupID', 'RetryCount']), plainTextColumns: Object.freeze([]) }),
  ActionTokens: Object.freeze({ headers: Object.freeze(['TokenID', 'TokenHash', 'OrderID', 'AppointmentSequence', 'ActionType', 'Department', 'CreatedAt', 'ExpiresAt', 'UsedAt', 'UsedBy', 'Status', 'ReminderLogID', 'RequestID', 'CancellationRequestID', 'CancellationPreviousStatus']), plainTextColumns: Object.freeze([]) }),
});

const DEFAULT_SETTINGS_ = Object.freeze([
  Object.freeze(['ORDER_PREFIX', 'MED', 'Prefix used for generated order IDs']),
  Object.freeze(['SESSION_TIMEOUT_MINUTES', '30', 'Idle session timeout in minutes']),
  Object.freeze(['SESSION_TOUCH_INTERVAL_MINUTES', '2', 'Minimum minutes between durable session activity writes']),
  Object.freeze(['UPDATE_EMAIL_ENABLED', 'TRUE', 'Send update notifications']),
  Object.freeze(['CANCEL_EMAIL_ENABLED', 'TRUE', 'Send cancellation notifications']),
  Object.freeze(['STAFF_CAN_EDIT_ORDERED', 'TRUE', 'Allow staff edits after ordering']),
  Object.freeze(['STAFF_CAN_CANCEL_ORDERED', 'TRUE', 'Allow staff cancellation after ordering']),
  Object.freeze(['DASHBOARD_CACHE_SECONDS', '60', 'Dashboard cache lifetime']),
  Object.freeze(['UPCOMING_REQUIRED_DATE_DAYS', '7', 'Upcoming appointment window']),
  Object.freeze(['TIMEZONE', 'Asia/Bangkok', 'Application display timezone']),
  Object.freeze(['LOGO_URL', '', 'Optional public logo URL']),
  Object.freeze(['ADMIN_NOTIFICATION_EMAIL', '', 'Optional admin notification recipient']),
  Object.freeze(['UPDATE_NOTIFICATION_CC', '', 'Optional update notification CC']),
  Object.freeze(['APPOINTMENT_REMINDER_ENABLED', 'TRUE', 'Enable appointment reminders']),
  Object.freeze(['APPOINTMENT_REMINDER_HOUR', '7', 'Local reminder hour']),
  Object.freeze(['APPOINTMENT_ACTION_TOKEN_HOURS', '168', 'Appointment action token lifetime']),
  Object.freeze([schemaKey_('ALLOW_EMAIL_RECEIVED_ACTION', '_WITHOUT_LOGIN'), 'TRUE', 'Permit received confirmation token flow']),
  Object.freeze([schemaKey_('ALLOW_EMAIL_NO_SHOW_ACTION', '_WITHOUT_LOGIN'), 'TRUE', 'Permit no-show token flow']),
  Object.freeze(['RESCHEDULE_REQUIRES_LOGIN', 'TRUE', 'Require login before rescheduling']),
  Object.freeze(['APPOINTMENT_REMINDER_RETRY_LIMIT', '3', 'Maximum reminder retries']),
  Object.freeze(['DEPARTMENT_EMAIL_REQUIRED', 'TRUE', 'Require a department email']),
  Object.freeze(['PATIENT_RECEIVED_AUTO_COMPLETE', 'TRUE', 'Complete order after patient received']),
  Object.freeze([schemaKey_('CANCELLATION_REQUIRES_ADMIN', '_APPROVAL'), 'FALSE', 'Require admin cancellation approval']),
  Object.freeze(['LOGIN_IDENTITY_FAILURE_LIMIT', '5', 'Failed attempts before a known identity is temporarily locked']),
  Object.freeze(['LOGIN_GLOBAL_FAILURE_LIMIT', '50', 'Failed attempts before global login is temporarily locked']),
  Object.freeze(['LOGIN_FAILURE_WINDOW_MINUTES', '15', 'Rolling failure window for login throttling']),
  Object.freeze(['LOGIN_LOCKOUT_MINUTES', '15', 'Temporary login lockout duration']),
  Object.freeze(['LOGIN_GLOBAL_THROTTLE_STATE', '', 'Runtime global login throttle state; change only through recovery helpers']),
]);

const DEFAULT_MASTER_DATA_ = Object.freeze({
  DOSAGE_FORM: Object.freeze(['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'ORAL_SOLUTION', 'INJECTION', 'CREAM', 'OINTMENT', 'GEL', 'EYE_DROPS', 'EAR_DROPS', 'NASAL_SPRAY', 'INHALER', 'SUPPOSITORY', 'PATCH', 'POWDER', 'GRANULE', 'SOLUTION', 'OTHER']),
  UNIT: Object.freeze(['TABLET', 'CAPSULE', 'BOTTLE', 'VIAL', 'AMPOULE', 'TUBE', 'BOX', 'PACK', 'SACHET', 'PIECE', 'ML', 'G', 'MG', 'DOSE', 'INHALER', 'PATCH', 'SUPPOSITORY', 'OTHER']),
  PRIORITY: Object.freeze(['NORMAL', 'URGENT', 'CRITICAL']),
  CANCEL_REASON: Object.freeze(['PATIENT_CANCELLED', 'TREATMENT_CHANGED', 'MEDICATION_CHANGED', 'TRANSFERRED', 'DUPLICATE_ORDER', 'DECEASED', 'OTHER']),
  NO_SHOW_REASON: Object.freeze(['UNREACHABLE', 'PATIENT_UNAVAILABLE', 'TREATED_ELSEWHERE', 'REFUSED_MEDICATION', 'DECEASED', 'UNKNOWN', 'OTHER']),
});

function schemaKey_(prefix, suffix) {
  return prefix + suffix;
}

function initializeDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = openConfiguredSpreadsheet_();
    Object.keys(SCHEMA_).forEach(function (sheetName) {
      repairSheetSchema_(spreadsheet, sheetName, SCHEMA_[sheetName]);
    });
    seedMissingSettings_(spreadsheet.getSheetByName('Settings'));
    seedMissingMasterData_(spreadsheet.getSheetByName('MasterData'));
    clearConfigurationCaches_();
    CacheService.getScriptCache().put(SCHEMA_CACHE_KEY_, 'ready', SCHEMA_CACHE_SECONDS_);
    return getDatabaseHealthFromSpreadsheet_(spreadsheet);
  } finally {
    lock.releaseLock();
  }
}

function getDatabaseHealth() {
  return getDatabaseHealthFromSpreadsheet_(openConfiguredSpreadsheet_());
}

function scheduledSchemaCheck() {
  return initializeDatabase();
}

function openConfiguredSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY_);
  if (!spreadsheetId) throw new Error('Spreadsheet configuration is missing.');
  return SpreadsheetApp.openById(spreadsheetId);
}

function getHeaderMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  return headers.reduce(function (map, header, index) {
    const name = String(header || '').trim();
    if (name && !Object.prototype.hasOwnProperty.call(map, name)) map[name] = index + 1;
    return map;
  }, {});
}

function repairSheetSchema_(spreadsheet, sheetName, definition) {
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  const headerMap = getHeaderMap_(sheet);
  const missingHeaders = definition.headers.filter(function (header) {
    return !Object.prototype.hasOwnProperty.call(headerMap, header);
  });

  // Append only missing headers so existing order and data remain untouched.
  if (missingHeaders.length) sheet.getRange(1, sheet.getLastColumn() + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  formatSchemaSheet_(sheet, definition);
  return sheet;
}

function formatSchemaSheet_(sheet, definition) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) return;
  sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const headerMap = getHeaderMap_(sheet);
  definition.plainTextColumns.forEach(function (header) {
    const column = headerMap[header];
    if (column) sheet.getRange(1, column, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function seedMissingSettings_(sheet) {
  const existingKeys = getExistingCompositeKeys_(sheet, ['Key']);
  const now = new Date().toISOString();
  const rows = DEFAULT_SETTINGS_.filter(function (setting) {
    return !existingKeys[setting[0]];
  }).map(function (setting) {
    return { Key: setting[0], Value: setting[1], Description: setting[2], UpdatedAt: now, UpdatedBy: 'SCHEMA_INITIALIZER' };
  });
  if (rows.length) appendRecords_('Settings', rows);
}

function seedMissingMasterData_(sheet) {
  const existingKeys = getExistingCompositeKeys_(sheet, ['Type', 'Code']);
  const now = new Date().toISOString();
  const rows = [];
  Object.keys(DEFAULT_MASTER_DATA_).forEach(function (type) {
    DEFAULT_MASTER_DATA_[type].forEach(function (code, index) {
      const key = makeCompositeKey_([type, code]);
      if (!existingKeys[key]) rows.push({ Type: type, Code: code, DisplayName: code, SortOrder: index + 1, Active: 'TRUE', UpdatedAt: now });
    });
  });
  if (rows.length) appendRecords_('MasterData', rows);
}

function getExistingCompositeKeys_(sheet, keyHeaders) {
  const records = readRecords_(sheet.getName());
  return records.reduce(function (keys, record) {
    const values = keyHeaders.map(function (header) { return record[header]; });
    if (values.every(function (value) { return String(value || '') !== ''; })) keys[makeCompositeKey_(values)] = true;
    return keys;
  }, {});
}

function makeCompositeKey_(values) {
  return values.map(function (value) { return String(value); }).join('\u001f');
}

function getDatabaseHealthFromSpreadsheet_(spreadsheet) {
  const missingSheets = [];
  const missingColumns = {};
  Object.keys(SCHEMA_).forEach(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      missingSheets.push(sheetName);
      return;
    }
    const headerMap = getHeaderMap_(sheet);
    const missing = SCHEMA_[sheetName].headers.filter(function (header) { return !headerMap[header]; });
    if (missing.length) missingColumns[sheetName] = missing;
  });
  return { healthy: !missingSheets.length && !Object.keys(missingColumns).length, missingSheets: missingSheets, missingColumns: missingColumns };
}
