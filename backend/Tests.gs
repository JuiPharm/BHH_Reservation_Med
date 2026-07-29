/**
 * Manual Apps Script integration checks. Run runSchemaTests from the editor.
 * It uses a disposable spreadsheet and restores the configured ID afterwards.
 */
function runSchemaTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Schema Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);

    assertSchemaTest_(!sandbox.getSheetByName('Users'), 'test fixture must begin without Users');
    initializeDatabase();
    assertSchemaTest_(sandbox.getSheetByName('Users'), 'missing sheet was not created');

    const users = sandbox.getSheetByName('Users');
    const userHeaders = getHeaderMap_(users);
    users.getRange(2, userHeaders.StaffID, 1, 1).setValue('00123');
    users.getRange(2, userHeaders.FullName, 1, 1).setValue('sentinel row');
    users.deleteColumn(userHeaders.UpdatedAt);
    assertSchemaTest_(!getHeaderMap_(users).UpdatedAt, 'fixture did not remove a required column');
    initializeDatabase();

    const repairedUsers = sandbox.getSheetByName('Users');
    const repairedHeaders = getHeaderMap_(repairedUsers);
    assertSchemaTest_(repairedHeaders.UpdatedAt, 'missing column was not appended');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getDisplayValue() === '00123', 'sentinel StaffID was overwritten');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.FullName, 1, 1).getDisplayValue() === 'sentinel row', 'sentinel row was overwritten');

    const columnsBeforeRepeat = repairedUsers.getLastColumn();
    const settingsRowsBeforeRepeat = sandbox.getSheetByName('Settings').getLastRow() - 1;
    const masterDataRowsBeforeRepeat = sandbox.getSheetByName('MasterData').getLastRow() - 1;
    initializeDatabase();
    assertSchemaTest_(repairedUsers.getLastColumn() === columnsBeforeRepeat, 'repeated initialization appended columns');
    assertSchemaTest_(sandbox.getSheetByName('Settings').getLastRow() - 1 === settingsRowsBeforeRepeat, 'repeated initialization duplicated Settings keys');
    assertSchemaTest_(sandbox.getSheetByName('MasterData').getLastRow() - 1 === masterDataRowsBeforeRepeat, 'repeated initialization duplicated MasterData Type+Code pairs');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getNumberFormat() === '@', 'StaffID is not plain text');
    assertSchemaTest_(readRecords_('Users', { limit: 0 }).length === 0, 'limit: 0 must return zero records');
    const orderHeaders = getHeaderMap_(sandbox.getSheetByName('OrderHeaders'));
    assertSchemaTest_(sandbox.getSheetByName('OrderHeaders').getRange(2, orderHeaders.HN, 1, 1).getNumberFormat() === '@', 'HN is not plain text');

    const customColumn = repairedUsers.getLastColumn() + 1;
    repairedUsers.getRange(1, customColumn, 1, 1).setValue('Custom Formula');
    const customFormulaCell = repairedUsers.getRange(2, customColumn, 1, 1);
    const staffIdA1 = repairedUsers.getRange(2, repairedHeaders.StaffID, 1, 1).getA1Notation();
    customFormulaCell.setFormula('=' + staffIdA1 + '&"-custom"');
    const formulaBeforeUpdate = customFormulaCell.getFormula();
    updateRecordByKey_('Users', 'StaffID', '00123', { FullName: 'updated sentinel' });
    assertSchemaTest_(customFormulaCell.getFormula() === formulaBeforeUpdate, 'custom column formula was overwritten during mapped update');
    assertSchemaTest_(repairedUsers.getRange(2, repairedHeaders.FullName, 1, 1).getDisplayValue() === 'updated sentinel', 'mapped column update did not persist');
    return { passed: true, message: 'Schema tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

function assertSchemaTest_(condition, message) {
  if (!condition) throw new Error('Schema test failed: ' + message);
}

/**
 * Manual Apps Script identity integration checks. Run runAuthTests from the
 * editor; it creates a disposable spreadsheet and never uses a real user.
 */
function runAuthTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Auth Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();

    const pinHash = createPinHash_('24682468');
    appendRecords_('Users', [
      { StaffID: '00123', FullName: 'Test Staff', Department: 'ER', Email: 'staff@example.invalid', Role: 'STAFF', PINHash: pinHash, Active: 'TRUE', CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() },
      { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Email: 'other@example.invalid', Role: 'STAFF', PINHash: pinHash, Active: 'TRUE', CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString() },
    ]);

    const loggedIn = login_({ staffId: '00123', pin: '24682468' }, 'auth-leading-zero');
    assertSchemaTest_(loggedIn.user.StaffID === '00123', 'leading-zero StaffID was not preserved');
    assertSchemaTest_(!Object.prototype.hasOwnProperty.call(loggedIn.user, 'PINHash'), 'login leaked PINHash');
    const repeatedLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-repeat');
    assertSchemaTest_(repeatedLogin.sessionToken !== loggedIn.sessionToken, 'repeated login reused a raw session token');
    assertSchemaTest_(requireSession_(loggedIn.sessionToken).user.StaffID === '00123', 'repeated login invalidated an existing session');
    assertSchemaTest_(requireSession_(repeatedLogin.sessionToken).user.StaffID === '00123', 'repeated login did not create an independently usable session');
    assertAuthThrows_(function () { login_({ staffId: '00123', pin: 'wrong' }, 'auth-bad-pin'); }, 'INVALID_CREDENTIALS', 'bad PIN was accepted');

    updateRecordByKey_('Users', 'StaffID', '00123', { Active: 'FALSE' });
    assertAuthThrows_(function () { login_({ staffId: '00123', pin: '24682468' }, 'auth-inactive'); }, 'INVALID_CREDENTIALS', 'inactive user was accepted');
    updateRecordByKey_('Users', 'StaffID', '00123', { Active: 'TRUE' });

    const expiredLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-expired');
    updateRecordByKey_('Sessions', 'SessionTokenHash', sha256Hex_(expiredLogin.sessionToken), { ExpiresAt: new Date(0).toISOString() });
    assertAuthThrows_(function () { requireSession_(expiredLogin.sessionToken); }, 'SESSION_EXPIRED', 'expired session was accepted');

    const activeLogin = login_({ staffId: '00123', pin: '24682468' }, 'auth-logout');
    const context = requireSession_(activeLogin.sessionToken);
    logout_(context);
    assertAuthThrows_(function () { requireSession_(activeLogin.sessionToken); }, 'SESSION_EXPIRED', 'logged-out session was accepted');

    const roleTamperLogin = login_({ staffId: '00123', pin: '24682468', role: 'ADMIN' }, 'auth-role-tamper');
    const trustedContext = requireSession_(roleTamperLogin.sessionToken);
    assertAuthThrows_(function () { requireRole_(trustedContext, ['ADMIN']); }, 'ACCESS_DENIED', 'client role tampering changed authorization');
    assertAuthThrows_(function () { requireOrderAccess_(trustedContext, { Department: 'ICU' }); }, 'ACCESS_DENIED', 'foreign department access was allowed');
    return { passed: true, message: 'Authentication tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

function assertAuthThrows_(operation, errorCode, message) {
  try {
    operation();
  } catch (error) {
    if (error && error.errorCode === errorCode) return;
    throw new Error('Authentication test failed: ' + message + ' (unexpected error)');
  }
  throw new Error('Authentication test failed: ' + message);
}

/**
 * Manual scanner-safety and replay checks against a disposable spreadsheet.
 * The blank managed recipient deliberately makes email delivery fail safely.
 */
function runAppointmentTests() {
  const properties = PropertiesService.getScriptProperties();
  const frontendProperty = ['FRONTEND', 'BASE', 'URL'].join('_');
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const originalFrontendBaseUrl = properties.getProperty(frontendProperty);
  const sandbox = SpreadsheetApp.create('Medication Reservation Appointment Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    properties.setProperty(frontendProperty, 'https://example.invalid/medication');
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const now = new Date();
    const appointmentDate = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
    const order = {
      OrderID: 'MED-APPOINTMENT-TEST', CreatedAt: now.toISOString(), Department: 'ER', RequesterEmail: '', HN: '07-01-000001',
      PatientName: 'Scanner Test', RequiredDate: appointmentDate, Status: 'NOTIFIED', ItemCount: 1, Version: 1,
      AppointmentSequence: 1, NoShowCount: 0,
    };
    appendRecords_('OrderHeaders', [order]);
    appendRecords_('OrderItems', [{ OrderItemID: 'MED-APPOINTMENT-TEST-01', OrderID: order.OrderID, ItemNo: 1, GenericName: 'Test medicine', RequestedQuantity: 1, Unit: 'CAPSULE', ItemStatus: 'RECEIVED', Active: 'TRUE' }]);
    const group = createAppointmentActionTokenGroup_(order, 'APRM-MANUAL', 'ATG-MANUAL', now);
    const tokenMatch = /[?&]token=([^&]+)/.exec(group.actionLinks.received);
    assertSchemaTest_(tokenMatch && tokenMatch[1], 'received action link did not contain an opaque token');
    const token = decodeURIComponent(tokenMatch[1]);
    const sheets = ['OrderHeaders', 'OrderItems', 'ActionTokens', 'AppointmentResponseLog', 'OrderChangeLog', 'AuditLog', 'RequestLog'];
    const beforeGet = JSON.stringify(sheets.reduce(function (result, name) { result[name] = readRecords_(name); return result; }, {}));
    getAppointmentAction_(token);
    getAppointmentAction_(token);
    const afterGet = JSON.stringify(sheets.reduce(function (result, name) { result[name] = readRecords_(name); return result; }, {}));
    assertSchemaTest_(beforeGet === afterGet, 'repeated appointment GET changed a business sheet');
    const first = confirmPatientReceived_({ token: token }, 'appointment-confirm');
    const replay = confirmPatientReceived_({ token: token }, 'appointment-confirm');
    assertSchemaTest_(first.Status === 'COMPLETED', 'received confirmation did not apply completion policy');
    assertSchemaTest_(replay.replayed === true, 'same request did not return its stored idempotent result');
    assertAuthThrows_(function () { confirmPatientReceived_({ token: token }, 'appointment-token-replay'); }, 'TOKEN_REPLAY', 'used appointment token was accepted again');
    return { passed: true, message: 'Appointment tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    if (originalFrontendBaseUrl === null) properties.deleteProperty(frontendProperty);
    else properties.setProperty(frontendProperty, originalFrontendBaseUrl);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script mutation integration checks against a disposable Sheet.
 */
function runOrderUpdateTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Update Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const context = { user: { StaffID: '00123', FullName: 'Update Tester', Department: 'ER', Email: '', Role: 'STAFF' } };
    const created = createOrder_(context, {
      HN: '07-01-000001', PatientName: 'Ada Lovelace', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [{ GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' }],
    }, 'update-create');
    const existing = getOrderItems_(created.OrderID)[0];
    const update = updateOrderByStaff_(context, {
      OrderID: created.OrderID, expectedVersion: 1, PatientName: 'Grace Hopper',
      Items: [{ OrderItemID: existing.OrderItemID, GenericName: existing.GenericName, BrandName: existing.BrandName, Strength: existing.Strength, DosageForm: existing.DosageForm, RequestedQuantity: 3, Unit: existing.Unit, Prescriber: existing.Prescriber }],
    }, 'update-order');
    assertSchemaTest_(update.Version === 2, 'staff update did not increment Version exactly once');
    assertSchemaTest_(getOrderChangeLog_(context, created.OrderID).length === 2, 'staff update did not write one change row per changed field');
    assertAuthThrows_(function () {
      updateOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 1, PatientName: 'Stale', Items: [existing] }, 'update-stale');
    }, 'ORDER_VERSION_CONFLICT', 'stale update overwrote a newer version');
    assertAuthThrows_(function () {
      updateOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 2, Items: [] }, 'update-remove-item');
    }, 'VALIDATION_ERROR', 'submitted item deletion was accepted');
    const cancelled = cancelOrderByStaff_(context, { OrderID: created.OrderID, expectedVersion: 2, ReasonCode: 'OTHER', ReasonDetail: 'Clinical change' }, 'cancel-order');
    assertSchemaTest_(cancelled.Status === 'CANCELLED', 'direct cancellation policy was not applied');
    assertSchemaTest_(getOrderItems_(created.OrderID).length === 1, 'cancellation deleted an item row');
    assertSchemaTest_(!isReminderEligibleForOrder_(findOrderHeader_(created.OrderID)), 'cancelled order remained reminder eligible');
    return { passed: true, message: 'Order update tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script order integration checks. Run runOrderTests from the
 * editor; it uses a disposable spreadsheet and uses a blank requester email
 * so the confirmation path is logged as failed without sending mail.
 */
function runOrderTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Order Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const context = { user: { StaffID: '00123', FullName: 'Test Staff', Department: 'ER', Email: '', Role: 'STAFF' } };
    const payload = {
      HN: '07-01-000001', PatientName: 'Ada Lovelace', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [
        { GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' },
        { GenericName: 'Paracetamol', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 4, Unit: 'TABLET', Prescriber: 'Dr Test' },
      ],
    };
    const first = createOrder_(context, payload, 'order-idempotent');
    const second = createOrder_(context, payload, 'order-idempotent');
    assertSchemaTest_(first.OrderID === second.OrderID, 'sequential duplicate did not return the same OrderID');
    assertSchemaTest_(getOrderItems_(first.OrderID).length === 2, 'multi-item order was not written');
    const list = listDepartmentOrders_(context, { pageSize: 999 });
    assertSchemaTest_(list.pageSize === 100 && !Object.prototype.hasOwnProperty.call(list.orders[0], 'items'), 'list response includes lazy items or ignores the page cap');
    const foreignContext = { user: { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Role: 'STAFF' } };
    assertAuthThrows_(function () { getOrderDetail_(foreignContext, first.OrderID); }, 'ACCESS_DENIED', 'foreign department probe was allowed');
    return { passed: true, message: 'Order tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}

/**
 * Manual Apps Script email/receiving checks.  A blank requester address is a
 * deliberate delivery double: MailApp fails, EmailLog records FAILED, and the
 * already-committed receiving quantities and status remain intact.
 */
function runEmailTests() {
  const properties = PropertiesService.getScriptProperties();
  const originalSpreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY_);
  const sandbox = SpreadsheetApp.create('Medication Reservation Email Test ' + new Date().toISOString());
  try {
    properties.setProperty(SPREADSHEET_ID_PROPERTY_, sandbox.getId());
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    initializeDatabase();
    const staff = { user: { StaffID: '00123', FullName: 'Email Staff', Department: 'ER', Email: '', Role: 'STAFF' } };
    const admin = { user: { StaffID: '00999', FullName: 'Email Admin', Department: 'ER', Email: '', Role: 'ADMIN' } };
    const created = createOrder_(staff, {
      HN: '07-01-000001', PatientName: '<Ada Lovelace>', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
      Items: [{ GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'CAPSULE', RequestedQuantity: 2, Unit: 'CAPSULE', Prescriber: 'Dr Test' }],
    }, 'email-create');
    const item = getOrderItems_(created.OrderID)[0];
    const received = updateReceivedItems_(admin, {
      OrderID: created.OrderID, expectedVersion: 1,
      Items: [{ OrderItemID: item.OrderItemID, ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'CAPSULE', AdminNote: '' }],
    }, 'email-receive');
    assertSchemaTest_(received.Status === 'RECEIVED', 'receiving did not derive RECEIVED status');
    assertSchemaTest_(Number(getOrderItems_(created.OrderID)[0].ReceivedQuantity) === 2, 'receiving quantity was not committed');
    const log = readRecords_('EmailLog', { predicate: function (entry) { return String(entry.OrderID || '') === created.OrderID && String(entry.EmailType || '') === 'MEDICATION_RECEIVED'; }, limit: 1 })[0];
    assertSchemaTest_(log && String(log.Result) === 'FAILED', 'failed delivery was not independently logged');
    const snapshot = loadEmailSnapshot_(log.EmailLogID);
    assertSchemaTest_(snapshot && snapshot.event && Number(snapshot.event.orderVersion) === 2, 'email snapshot did not preserve the original order version');
    assertSchemaTest_(snapshot.event.actor && String(snapshot.event.actor.StaffID) === '00999', 'email snapshot did not preserve the original actor');
    assertSchemaTest_(snapshot.items && snapshot.items.length === 1 && String(snapshot.items[0].GenericName) === 'Amoxicillin', 'email snapshot did not preserve original items');
    const template = buildOrderEmailTemplate_('MEDICATION_RECEIVED', { header: findOrderHeader_(created.OrderID), items: getOrderItems_(created.OrderID), actor: admin.user });
    assertSchemaTest_(template.subject === '[Medication Received] Order ID: ' + created.OrderID, 'received template subject is incorrect');
    assertSchemaTest_(template.htmlBody.indexOf('&lt;Ada Lovelace&gt;') < 0 && template.htmlBody.indexOf('07-01-000001') < 0, 'email template exposed unmasked patient data');
    return { passed: true, message: 'Email tests passed.' };
  } finally {
    if (originalSpreadsheetId === null) properties.deleteProperty(SPREADSHEET_ID_PROPERTY_);
    else properties.setProperty(SPREADSHEET_ID_PROPERTY_, originalSpreadsheetId);
    CacheService.getScriptCache().remove(SCHEMA_CACHE_KEY_);
    clearConfigurationCaches_();
    DriveApp.getFileById(sandbox.getId()).setTrashed(true);
  }
}
