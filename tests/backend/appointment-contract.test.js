const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function ApiError(errorCode, safeMessage, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage;
  this.errors = errors;
}

function appointmentSandbox(options = {}) {
  let clock = new global.Date(options.now || '2026-07-19T01:00:00.000Z');
  let uuid = 0;
  let randomByte = 0;
  let lockDepth = 0;
  let deliveryFailure = Boolean(options.deliveryFailure);
  let failOnce = '';
  let failureInjected = false;
  let failureRules = [];
  const eventCounts = Object.create(null);
  let nextLockHook = null;
  const header = {
    OrderID: 'MED-20260719-0001', CreatedByStaffID: '00123', CreatedByName: 'Ada Staff',
    Department: 'ER', RequesterEmail: 'staff@example.invalid', HN: '07-01-000001',
    PatientName: 'Ada Lovelace', RequiredDate: '2026-07-19', Status: 'NOTIFIED', Version: 4,
    AppointmentSequence: 1, ItemCount: 1, NoShowCount: 0, LastChangeSetID: 'CHGSET-previous',
  };
  const records = {
    OrderHeaders: [header],
    OrderItems: [{ OrderItemID: `${header.OrderID}-01`, OrderID: header.OrderID, GenericName: 'Amoxicillin', RequestedQuantity: 1, Unit: 'CAPSULE', ItemStatus: 'RECEIVED' }],
    ActionTokens: [], AppointmentResponseLog: [], AppointmentReminderLog: [], OrderChangeLog: [],
    AuditLog: [], RequestLog: [], EmailLog: [],
    Users: [{ StaffID: '00123', Email: 'staff@example.invalid', Active: 'TRUE' }],
    Departments: [{ DepartmentCode: 'ER', DepartmentEmail: 'er@example.invalid', CCEmail: 'er-cc@example.invalid', Active: 'TRUE' }],
    ...(options.records || {}),
  };
  const events = [];
  const sent = [];
  const attempted = [];
  function maybeFail(event) {
    eventCounts[event] = Number(eventCounts[event] || 0) + 1;
    if (!failureInjected && failOnce === event) { failureInjected = true; throw new Error(`injected ${event}`); }
    const rule = failureRules.find((entry) => entry.event === event && Number(entry.occurrence) === eventCounts[event]);
    if (rule) throw new Error(`injected ${event} occurrence ${rule.occurrence}`);
  }
  class FakeDate extends global.Date {
    constructor(value) { super(arguments.length ? value : clock.getTime()); }
    static now() { return clock.getTime(); }
  }
  const settings = {
    TIMEZONE: 'Asia/Bangkok', APPOINTMENT_REMINDER_ENABLED: 'TRUE', APPOINTMENT_ACTION_TOKEN_HOURS: '168',
    APPOINTMENT_REMINDER_RETRY_LIMIT: '3', PATIENT_RECEIVED_AUTO_COMPLETE: 'TRUE',
    ...(options.settings || {}),
  };
  const scriptProperties = {};
  scriptProperties[['FRONTEND', 'BASE_URL'].join('_')] = ['https://example.invalid', 'medication'].join('/');
  const triggers = (options.triggers || []).map((handler) => ({ getHandlerFunction: () => handler }));
  const runtime = {
    ApiError_: ApiError, Array, Date: FakeDate, JSON, Math, Number, Object, RegExp, String, encodeURIComponent, isFinite,
    Utilities: {
      getUuid: () => `uuid-${++uuid}`,
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      formatDate: (date) => new global.Date(date).toISOString().slice(0, 10),
    },
    randomBytes_: (length) => Array.from({ length }, () => ((++randomByte) % 251)),
    sha256Hex_: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
    getSetting_: (key, fallback) => Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback,
    getMasterData_: (types) => ({ NO_SHOW_REASON: (options.noShowReasons || [
      { Code: 'UNREACHABLE', DisplayName: 'Unreachable', Active: 'TRUE' }, { Code: 'PATIENT_UNAVAILABLE', DisplayName: 'Unavailable', Active: 'TRUE' },
      { Code: 'TREATED_ELSEWHERE', DisplayName: 'Elsewhere', Active: 'TRUE' }, { Code: 'REFUSED_MEDICATION', DisplayName: 'Refused', Active: 'TRUE' },
      { Code: 'DECEASED', DisplayName: 'Deceased', Active: 'TRUE' }, { Code: 'UNKNOWN', DisplayName: 'Unknown', Active: 'TRUE' }, { Code: 'OTHER', DisplayName: 'Other', Active: 'TRUE' },
    ]).filter((entry) => !types || types.includes('NO_SHOW_REASON')) }),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => scriptProperties[key] || null }) },
    readRecords_: (name, query = {}) => {
      const rows = records[name] || [];
      const filtered = query.predicate ? rows.filter(query.predicate) : rows.slice();
      return clone(query.limit == null ? filtered : filtered.slice(0, query.limit));
    },
    appendRecords_: (name, rows) => {
      events.push(`append:${name}`);
      maybeFail(`append:${name}`);
      const target = records[name] || (records[name] = []);
      rows.forEach((row) => target.push(clone(row)));
      return { startRow: target.length - rows.length + 2, rowCount: rows.length };
    },
    updateRecordByKey_: (name, key, value, updates) => {
      events.push(`update:${name}`);
      maybeFail(`update:${name}`);
      const row = (records[name] || []).find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, clone(updates));
      return clone(row);
    },
    updateRecordByCompositeKey_: (name, keys, updates) => {
      events.push(`composite:${name}`);
      maybeFail(`composite:${name}`);
      const matches = (records[name] || []).filter((row) => Object.entries(keys).every(([key, value]) => String(row[key] || '') === String(value || '')));
      if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
      Object.assign(matches[0], clone(updates));
      return clone(matches[0]);
    },
    findOrderHeader_: (orderId) => clone(records.OrderHeaders.find((row) => String(row.OrderID) === String(orderId)) || null),
    getOrderItems_: (orderId) => clone(records.OrderItems.filter((row) => String(row.OrderID) === String(orderId))),
    requireOrderAccess_: (context, order) => {
      if (!context || !context.user || String(context.user.Department) !== String(order.Department)) throw new ApiError('ACCESS_DENIED', 'Access denied.');
      return order;
    },
    LockService: { getScriptLock: () => ({
      waitLock: () => {
        assert.equal(lockDepth, 0, 'script locks must never be acquired recursively');
        lockDepth += 1;
        events.push('lock');
        if (nextLockHook) { const hook = nextLockHook; nextLockHook = null; hook(); }
      },
      releaseLock: () => { lockDepth -= 1; events.push('unlock'); },
    }) },
    invalidateDashboardCache_: (department) => { events.push(`cache:${department}`); events.push('cache:ALL'); },
    CacheService: { getScriptCache: () => ({ remove: (key) => events.push(`cache:${key}`) }) },
    MailApp: { sendEmail: (message) => {
      events.push('email');
      assert.equal(lockDepth, 0, 'MailApp must never run while a script lock is held');
      attempted.push(clone(message));
      if (deliveryFailure) throw new Error('injected mail failure');
      sent.push(clone(message));
    } },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      newTrigger: (handler) => {
        const builder = {
          timeBased: () => builder, everyDays: () => builder, atHour: () => builder, inTimezone: () => builder,
          create: () => { triggers.push({ getHandlerFunction: () => handler }); return triggers.at(-1); },
        };
        return builder;
      },
    },
  };
  const files = [
    'backend/AuditService.gs', 'backend/ChangeLogService.gs', 'backend/EmailService.gs',
    'backend/ActionTokenService.gs', 'backend/AppointmentService.gs', 'backend/ReminderService.gs', 'backend/TriggerService.gs',
  ];
  const service = vm.runInNewContext(`${files.map(source).join('\n')}\n({
    getAppointmentAction_, confirmPatientReceived_, submitPatientNoShow_, getRescheduleReference_,
    getRescheduleOrder_, submitAppointmentReschedule_, processAppointmentDueReminders,
    retryFailedAppointmentReminders, expireActionTokens, setupAppointmentReminderTrigger,
    recordTerminalEmailOutcome_, reconcileReminderDelivery_,
  });`, runtime);
  return {
    service, records, events, sent, attempted, triggers,
    setNow: (value) => { clock = new global.Date(value); },
    setDeliveryFailure: (value) => { deliveryFailure = Boolean(value); },
    setFailOnce: (event) => { failOnce = String(event || ''); failureInjected = false; },
    setFailureRules: (rules) => {
      failureRules = clone(rules || []);
      Object.keys(eventCounts).forEach((key) => { delete eventCounts[key]; });
    },
    onNextLock: (hook) => { nextLockHook = hook; },
  };
}

function linksFromMail(mail) {
  const matches = [...mail.body.matchAll(/(https:\/\/\S+)/g)].map((match) => match[1]);
  return {
    received: matches.find((url) => /action=received/.test(url)),
    noShow: matches.find((url) => /action=no-show/.test(url)),
    reschedule: matches.find((url) => /reference=/.test(url)),
  };
}

function queryValue(url, name) { return new URL(url).searchParams.get(name); }

const staff = { user: { StaffID: '00123', FullName: 'Ada Staff', Department: 'ER', Role: 'STAFF' } };
const foreign = { user: { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Role: 'STAFF' } };

test('due reminder creates one unique tuple, stores only 256-bit token hashes, and links include requestId', () => {
  const { service, records, sent, events } = appointmentSandbox();
  const first = service.processAppointmentDueReminders();
  const second = service.processAppointmentDueReminders();
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(records.AppointmentReminderLog.length, 1);
  assert.equal(records.ActionTokens.length, 3);
  assert.equal(records.EmailLog.length, 1);
  assert.equal(Number(records.EmailLog[0].RetryCount), 0);
  assert.equal(Number(records.AppointmentReminderLog[0].RetryCount), 0);
  assert.equal(sent.length, 1);
  const links = linksFromMail(sent[0]);
  for (const url of Object.values(links)) {
    assert.ok(url);
    assert.ok(queryValue(url, 'requestId'));
    assert.doesNotMatch(url, /07-01-000001|Ada|PatientName|HN=/i);
    const raw = queryValue(url, /reference=/.test(url) ? 'reference' : 'token');
    assert.equal(Buffer.from(raw, 'base64url').length, 32);
  }
  for (const row of records.ActionTokens) {
    assert.match(row.TokenHash, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(row).some((key) => /raw|opaque/i.test(key)), false);
    assert.equal(Object.values(row).some((value) => Object.values(links).some((url) => url.includes(String(value)) && String(value).length > 40)), false);
  }
  const rawSecrets = Object.values(links).map((url) => queryValue(url, /reference=/.test(url) ? 'reference' : 'token'));
  const persisted = JSON.stringify(records);
  rawSecrets.forEach((secret) => assert.equal(persisted.includes(secret), false, 'raw action material leaked into a persisted sheet'));
  assert.doesNotMatch(persisted, /[?&](?:token|reference)=/i);
  const snapshot = JSON.parse(records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT').ResponseData);
  assert.deepEqual(snapshot.appointmentActions, ['RECEIVED', 'NO_SHOW', 'RESCHEDULE']);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'actionLinks'), false);
  assert.ok(events.indexOf('unlock') < events.indexOf('email'));
  const afterDelivery = events.slice(events.indexOf('email'));
  assert.deepEqual(afterDelivery.slice(0, 4), ['email', 'lock', 'update:EmailLog', 'unlock']);
});

test('public GET validates metadata but repeated previews never mutate business sheets', () => {
  const { service, records, sent } = appointmentSandbox();
  service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sent[0]).received, 'token');
  const before = JSON.stringify(records);
  const preview = service.getAppointmentAction_(token);
  const again = service.getAppointmentAction_(token);
  assert.equal(preview.OrderID, 'MED-20260719-0001');
  assert.equal(preview.actionType, 'RECEIVED');
  assert.deepEqual(clone(again), clone(preview));
  assert.equal(JSON.stringify(records), before);
});

test('no-show public preview includes only active canonical reason code and label values', () => {
  const { service, sent } = appointmentSandbox({ noShowReasons: [
    { Code: 'UNREACHABLE', DisplayName: 'Unreachable', Active: 'TRUE' },
    { Code: 'LEGACY', DisplayName: 'Legacy', Active: 'FALSE' },
  ] });
  service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sent[0]).noShow, 'token');
  const preview = service.getAppointmentAction_(token);
  assert.deepEqual(clone(preview.noShowReasons), [{ code: 'UNREACHABLE', label: 'Unreachable' }]);
  assert.equal(JSON.stringify(preview).includes('PatientName'), false);
  assert.equal(JSON.stringify(preview).includes('HN'), false);
});

test('received POST revalidates the token under lock, records immutable history, and rejects token replay', () => {
  const { service, records, sent, events } = appointmentSandbox();
  service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sent[0]).received, 'token');
  const result = service.confirmPatientReceived_({ token }, 'received-post');
  assert.equal(result.Status, 'COMPLETED');
  assert.equal(records.OrderHeaders[0].AppointmentResponseStatus, 'PATIENT_RECEIVED');
  assert.equal(records.OrderHeaders[0].PatientReceivedAt.length > 0, true);
  assert.equal(records.OrderHeaders[0].Version, 5);
  assert.equal(records.AppointmentResponseLog.length, 1);
  assert.equal(records.AppointmentResponseLog[0].ActionType, 'PATIENT_RECEIVED');
  assert.equal(records.OrderChangeLog.length > 0, true);
  assert.equal(records.AuditLog.some((row) => row.Action === 'CONFIRM_PATIENT_RECEIVED'), true);
  assert.equal(records.ActionTokens.find((row) => row.ActionType === 'RECEIVED').Status, 'USED');
  assert.ok(events.includes('cache:ER'));
  assert.ok(events.includes('cache:ALL'));
  assert.equal(events[events.lastIndexOf('email') - 1], 'unlock');
  const replay = service.confirmPatientReceived_({ token }, 'received-post');
  assert.equal(replay.replayed, true);
  assert.throws(() => service.confirmPatientReceived_({ token }, 'received-new-request'), (error) => error.errorCode === 'TOKEN_REPLAY');
});

test('received POST rejects every non-allowlisted payload field before mutation', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sandbox.sent[0]).received, 'token');
  const before = JSON.stringify(sandbox.records);
  assert.throws(() => sandbox.service.confirmPatientReceived_({ token, Department: 'ICU' }, 'received-smuggle'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(sandbox.records), before);
});

test('expired, malformed, revoked, wrong-sequence, and status-incompatible tokens fail without GET mutation', () => {
  for (const invalidation of ['expired', 'malformed-expiry', 'revoked', 'sequence', 'status']) {
    const { service, records, sent } = appointmentSandbox();
    service.processAppointmentDueReminders();
    const token = queryValue(linksFromMail(sent[0]).received, 'token');
    const tokenRow = records.ActionTokens.find((row) => row.ActionType === 'RECEIVED');
    if (invalidation === 'expired') tokenRow.ExpiresAt = '2020-01-01T00:00:00.000Z';
    if (invalidation === 'malformed-expiry') tokenRow.ExpiresAt = 'not-a-date';
    if (invalidation === 'revoked') tokenRow.Status = 'REVOKED';
    if (invalidation === 'sequence') records.OrderHeaders[0].AppointmentSequence += 1;
    if (invalidation === 'status') records.OrderHeaders[0].Status = 'CANCELLED';
    const before = JSON.stringify(records);
    assert.throws(() => service.getAppointmentAction_(token), (error) => ['ACTION_TOKEN_EXPIRED', 'TOKEN_REPLAY', 'INVALID_ACTION_TOKEN'].includes(error.errorCode), invalidation);
    assert.equal(JSON.stringify(records), before, invalidation);
  }
});

test('no-show requires an active reason and OTHER detail, then increments the count once', () => {
  const { service, records, sent } = appointmentSandbox();
  service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sent[0]).noShow, 'token');
  assert.throws(() => service.submitPatientNoShow_({ token }, 'no-reason'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.submitPatientNoShow_({ token, reasonCode: 'OTHER' }, 'no-detail'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.submitPatientNoShow_({ token, reasonCode: 'INVENTED' }, 'bad-code'), (error) => error.errorCode === 'VALIDATION_ERROR');
  const result = service.submitPatientNoShow_({ token, reasonCode: 'OTHER', reasonDetail: 'Family could not attend' }, 'no-show-post');
  assert.equal(result.Status, 'PATIENT_NO_SHOW');
  assert.equal(records.OrderHeaders[0].NoShowCount, 1);
  assert.equal(records.OrderHeaders[0].NoShowReasonCode, 'OTHER');
  assert.equal(records.AppointmentResponseLog[0].ReasonDetail, 'Family could not attend');
  assert.equal(records.AppointmentResponseLog.length, 1);
});

test('public received and no-show POSTs fail closed when their policy setting is disabled', () => {
  const receivedPolicy = ['ALLOW_EMAIL_RECEIVED_ACTION', 'WITHOUT_LOGIN'].join('_');
  const noShowPolicy = ['ALLOW_EMAIL_NO_SHOW_ACTION', 'WITHOUT_LOGIN'].join('_');
  const sandbox = appointmentSandbox({ settings: {
    [receivedPolicy]: 'FALSE',
    [noShowPolicy]: 'FALSE',
  } });
  sandbox.service.processAppointmentDueReminders();
  const links = linksFromMail(sandbox.sent[0]);
  assert.throws(() => sandbox.service.confirmPatientReceived_({ token: queryValue(links.received, 'token') }, 'disabled-received'), (error) => error.errorCode === 'ACCESS_DENIED');
  assert.throws(() => sandbox.service.submitPatientNoShow_({ token: queryValue(links.noShow, 'token'), reasonCode: 'UNKNOWN' }, 'disabled-no-show'), (error) => error.errorCode === 'ACCESS_DENIED');
  assert.equal(sandbox.records.AppointmentResponseLog.length, 0);
});

test('reschedule reference requires login, exact department, version, and a different valid staff date', () => {
  const { service, sent } = appointmentSandbox();
  service.processAppointmentDueReminders();
  const reference = queryValue(linksFromMail(sent[0]).reschedule, 'reference');
  const publicModel = service.getRescheduleReference_(reference);
  assert.equal(publicModel.requiresLogin, true);
  assert.throws(() => service.getRescheduleOrder_(null, reference), (error) => error.errorCode === 'ACCESS_DENIED');
  assert.throws(() => service.getRescheduleOrder_(foreign, reference), (error) => error.errorCode === 'ACCESS_DENIED');
  const order = service.getRescheduleOrder_(staff, reference);
  assert.equal(order.Version, 4);
  assert.equal(order.RequiredDate, '2026-07-19');
  assert.throws(() => service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 3, newRequiredDate: '2026-07-20', reason: 'Clinic request' }, 'stale'), (error) => error.errorCode === 'ORDER_VERSION_CONFLICT');
  assert.throws(() => service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 4, newRequiredDate: '2026-07-19', reason: 'Same' }, 'same'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 4, newRequiredDate: '2026-07-18', reason: 'Past' }, 'past'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 4, newRequiredDate: '2026-02-30', reason: 'Invalid' }, 'invalid-date'), (error) => error.errorCode === 'VALIDATION_ERROR');
});

test('reschedule increments version and sequence, revokes old tokens, appends logs, and enables a new-date reminder', () => {
  const sandbox = appointmentSandbox();
  const { service, records, sent, events } = sandbox;
  service.processAppointmentDueReminders();
  const reference = queryValue(linksFromMail(sent[0]).reschedule, 'reference');
  const result = service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 4, newRequiredDate: '2026-07-20', reason: 'Clinic request' }, 'reschedule-post');
  assert.equal(result.Version, 5);
  assert.equal(result.AppointmentSequence, 2);
  assert.equal(records.OrderHeaders[0].RequiredDate, '2026-07-20');
  assert.equal(records.OrderHeaders[0].LastRequiredDate, '2026-07-19');
  assert.equal(records.OrderHeaders[0].Status, 'APPOINTMENT_RESCHEDULED');
  assert.equal(records.ActionTokens.slice(0, 3).every((row) => ['REVOKED', 'USED'].includes(row.Status)), true);
  assert.equal(records.AppointmentResponseLog.at(-1).ActionType, 'APPOINTMENT_RESCHEDULED');
  assert.equal(records.OrderChangeLog.some((row) => row.FieldName === 'RequiredDate'), true);
  assert.equal(records.AuditLog.some((row) => row.Action === 'SUBMIT_APPOINTMENT_RESCHEDULE'), true);
  assert.equal(events[events.lastIndexOf('email') - 1], 'unlock');
  sandbox.setNow('2026-07-20T01:00:00.000Z');
  const reminder = service.processAppointmentDueReminders();
  assert.equal(reminder.sent, 1);
  assert.equal(records.AppointmentReminderLog.length, 2);
  assert.deepEqual(records.AppointmentReminderLog.map((row) => Number(row.AppointmentSequence)), [1, 2]);
});

test('authenticated reschedule replay reauthorizes the current department context', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  const reference = queryValue(linksFromMail(sandbox.sent[0]).reschedule, 'reference');
  const payload = { reference, expectedVersion: 4, newRequiredDate: '2026-07-20', reason: 'Clinic request' };
  sandbox.service.submitAppointmentReschedule_(staff, payload, 'reschedule-auth-replay');
  assert.throws(() => sandbox.service.submitAppointmentReschedule_(foreign, payload, 'reschedule-auth-replay'), (error) => error.errorCode === 'ACCESS_DENIED');
});

test('appointment write-stage failures compensate the header and token while appending rollback evidence', () => {
  for (const failAt of ['append:AppointmentResponseLog', 'append:OrderChangeLog', 'append:AuditLog', 'update:ActionTokens', 'composite:RequestLog']) {
    const sandbox = appointmentSandbox();
    sandbox.service.processAppointmentDueReminders();
    const token = queryValue(linksFromMail(sandbox.sent[0]).received, 'token');
    sandbox.setFailOnce(failAt);
    assert.throws(() => sandbox.service.confirmPatientReceived_({ token }, `failed-${failAt}`), /injected/, failAt);
    assert.equal(sandbox.records.OrderHeaders[0].Status, 'NOTIFIED', failAt);
    assert.equal(sandbox.records.OrderHeaders[0].Version, 4, failAt);
    assert.equal(sandbox.records.ActionTokens.find((row) => row.ActionType === 'RECEIVED').Status, 'ACTIVE', failAt);
    assert.equal(sandbox.records.RequestLog.find((row) => row.Action === 'CONFIRM_PATIENT_RECEIVED').Result, 'TRANSACTION_FAILURE', failAt);
    assert.equal(sandbox.records.AppointmentResponseLog.some((row) => row.Result === 'ROLLED_BACK'), true, failAt);
    const rollbackChange = sandbox.records.OrderChangeLog.find((row) => row.Result === 'ROLLED_BACK');
    assert.equal(Number(rollbackChange.OrderVersionBefore), 5, failAt);
    assert.equal(Number(rollbackChange.OrderVersionAfter), 4, failAt);
    const retry = sandbox.service.confirmPatientReceived_({ token }, `retry-${failAt}`);
    assert.equal(retry.Status, 'COMPLETED', failAt);
  }
});

test('failed reminders revoke old tokens and mint fresh in-memory links within the retry limit', () => {
  const sandbox = appointmentSandbox({ deliveryFailure: true, settings: { APPOINTMENT_REMINDER_RETRY_LIMIT: '1' } });
  const { service, records, attempted, sent } = sandbox;
  const first = service.processAppointmentDueReminders();
  assert.equal(first.failed, 1);
  assert.equal(records.AppointmentReminderLog[0].Result, 'FAILED');
  assert.equal(records.AppointmentReminderLog[0].RetryCount, 0);
  const firstLinks = linksFromMail(attempted[0]);
  sandbox.setDeliveryFailure(false);
  const retry = service.retryFailedAppointmentReminders();
  assert.equal(retry.sent, 1);
  assert.equal(records.AppointmentReminderLog[0].RetryCount, 1);
  assert.equal(records.AppointmentReminderLog[0].Result, 'SUCCESS');
  const secondLinks = linksFromMail(sent[0]);
  assert.notEqual(queryValue(firstLinks.received, 'token'), queryValue(secondLinks.received, 'token'));
  assert.equal(records.ActionTokens.slice(0, 3).every((row) => row.Status === 'REVOKED'), true);
  assert.equal(records.ActionTokens.slice(3).every((row) => row.Status === 'ACTIVE'), true);
  assert.equal(records.ActionTokens.length, 6);
  assert.equal(records.EmailLog.length, 2);
  assert.deepEqual(records.EmailLog.map((row) => Number(row.RetryCount)), [0, 1]);
  const persisted = JSON.stringify(records);
  [firstLinks, secondLinks].flatMap((links) => Object.values(links)).forEach((url) => {
    const raw = queryValue(url, /reference=/.test(url) ? 'reference' : 'token');
    assert.equal(persisted.includes(raw), false);
  });
  sandbox.setNow('2027-07-20T01:00:00.000Z');
  const expired = service.expireActionTokens();
  assert.equal(expired.expired, 3);
  assert.equal(records.ActionTokens.slice(3).every((row) => row.Status === 'EXPIRED'), true);
});

test('rollback failure is terminal and never falsely records a restored appointment', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sandbox.sent[0]).received, 'token');
  sandbox.setFailureRules([
    { event: 'append:AppointmentResponseLog', occurrence: 1 },
    { event: 'update:OrderHeaders', occurrence: 2 },
  ]);
  assert.throws(() => sandbox.service.confirmPatientReceived_({ token }, 'rollback-failed'), /injected/);
  assert.equal(sandbox.records.OrderHeaders[0].Version, 5);
  assert.equal(sandbox.records.OrderHeaders[0].Status, 'COMPLETED');
  assert.equal(sandbox.records.AppointmentResponseLog.some((row) => row.Result === 'ROLLED_BACK'), false);
  assert.equal(sandbox.records.OrderChangeLog.some((row) => row.Result === 'ROLLED_BACK'), false);
  assert.equal(sandbox.records.OrderChangeLog.some((row) => row.Result === 'ROLLBACK_FAILED'), true);
  assert.equal(sandbox.records.AuditLog.some((row) => row.Result === 'ROLLBACK_FAILED'), true);
  const request = sandbox.records.RequestLog.find((row) => row.Action === 'CONFIRM_PATIENT_RECEIVED');
  assert.equal(request.Result, 'TRANSACTION_FAILURE');
  assert.match(request.ResponseData, /ROLLBACK_FAILED/);
});

test('reschedule rollback verifies and restores the entire owned token group', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  const reference = queryValue(linksFromMail(sandbox.sent[0]).reschedule, 'reference');
  sandbox.setFailureRules([{ event: 'append:AppointmentResponseLog', occurrence: 1 }]);
  assert.throws(() => sandbox.service.submitAppointmentReschedule_(staff, { reference, expectedVersion: 4, newRequiredDate: '2026-07-20', reason: 'Clinic request' }, 'reschedule-rollback'), /injected/);
  assert.equal(sandbox.records.OrderHeaders[0].Version, 4);
  assert.equal(sandbox.records.OrderHeaders[0].RequiredDate, '2026-07-19');
  assert.equal(sandbox.records.OrderHeaders[0].AppointmentSequence, 1);
  assert.equal(sandbox.records.ActionTokens.every((row) => row.Status === 'ACTIVE'), true);
  assert.equal(sandbox.records.AppointmentResponseLog.some((row) => row.Result === 'ROLLED_BACK'), true);
});

test('appointment action replay resumes only PENDING mail and reports SENDING as uncertain without a duplicate', () => {
  const pending = appointmentSandbox();
  pending.service.processAppointmentDueReminders();
  const pendingToken = queryValue(linksFromMail(pending.sent[0]).received, 'token');
  const first = pending.service.confirmPatientReceived_({ token: pendingToken }, 'action-mail-replay');
  const actionEmail = pending.records.EmailLog.find((row) => row.EmailLogID === first.emailLogId);
  actionEmail.Result = 'PENDING';
  pending.sent.length = 0;
  const resumed = pending.service.confirmPatientReceived_({ token: pendingToken }, 'action-mail-replay');
  assert.equal(resumed.replayed, true);
  assert.equal(resumed.email.result, 'SUCCESS');
  assert.equal(pending.sent.length, 1);

  const uncertain = appointmentSandbox();
  uncertain.service.processAppointmentDueReminders();
  const uncertainToken = queryValue(linksFromMail(uncertain.sent[0]).received, 'token');
  const result = uncertain.service.confirmPatientReceived_({ token: uncertainToken }, 'action-mail-uncertain');
  const uncertainEmail = uncertain.records.EmailLog.find((row) => row.EmailLogID === result.emailLogId);
  uncertainEmail.Result = 'SENDING';
  uncertain.sent.length = 0;
  const replay = uncertain.service.confirmPatientReceived_({ token: uncertainToken }, 'action-mail-uncertain');
  assert.equal(replay.email.result, 'UNCERTAIN');
  assert.equal(uncertain.sent.length, 0);
});

test('terminal fallback receipts reconcile action and reminder roots instead of remaining uncertain', () => {
  const action = appointmentSandbox();
  action.service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(action.sent[0]).received, 'token');
  const result = action.service.confirmPatientReceived_({ token }, 'fallback-action');
  const original = action.records.EmailLog.find((row) => row.EmailLogID === result.emailLogId);
  original.Result = 'SENDING';
  const receipt = { ...clone(original), EmailLogID: 'EML-terminal-receipt', Result: 'SUCCESS', SentAt: '2026-07-19T01:01:00.000Z' };
  action.records.EmailLog.push(receipt);
  const snapshot = JSON.parse(action.records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT' && row.RequestID === original.EmailLogID).ResponseData);
  action.records.RequestLog.push({ RequestID: receipt.EmailLogID, Action: 'EMAIL_SNAPSHOT', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) });
  action.sent.length = 0;
  const replay = action.service.confirmPatientReceived_({ token }, 'fallback-action');
  assert.equal(replay.email.result, 'SUCCESS');
  assert.equal(action.sent.length, 0);

  const reminder = appointmentSandbox();
  reminder.service.processAppointmentDueReminders();
  reminder.records.AppointmentReminderLog[0].Result = 'PREPARED';
  reminder.records.EmailLog[0].Result = 'SENDING';
  delete reminder.records.OrderHeaders[0].LastAppointmentReminderAt;
  delete reminder.records.OrderHeaders[0].LastAppointmentReminderSequence;
  const reminderReceipt = { ...clone(reminder.records.EmailLog[0]), EmailLogID: 'EML-reminder-receipt', Result: 'SUCCESS', SentAt: '2026-07-19T01:02:00.000Z' };
  reminder.records.EmailLog.push(reminderReceipt);
  const reminderSnapshot = JSON.parse(reminder.records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT').ResponseData);
  reminder.records.RequestLog.push({ RequestID: reminderReceipt.EmailLogID, Action: 'EMAIL_SNAPSHOT', Result: 'SUCCESS', ResponseData: JSON.stringify(reminderSnapshot) });
  reminder.sent.length = 0;
  reminder.service.retryFailedAppointmentReminders();
  assert.equal(reminder.records.AppointmentReminderLog[0].Result, 'SUCCESS');
  assert.equal(reminder.records.OrderHeaders[0].LastAppointmentReminderSequence, 1);
  assert.ok(reminder.records.OrderHeaders[0].LastAppointmentReminderAt);
  assert.equal(reminder.sent.length, 0);
});

test('reminder preparation failures consume durable monotonic attempts and recover without duplicate delivery', () => {
  for (const failAt of ['append:ActionTokens', 'append:EmailLog', 'append:RequestLog']) {
    const sandbox = appointmentSandbox({ settings: { APPOINTMENT_REMINDER_RETRY_LIMIT: '1' } });
    sandbox.setFailOnce(failAt);
    const first = sandbox.service.processAppointmentDueReminders();
    assert.equal(first.failed, 1, failAt);
    assert.equal(sandbox.records.AppointmentReminderLog.length, 1, failAt);
    assert.equal(sandbox.records.AppointmentReminderLog[0].RetryCount, 0, failAt);
    assert.equal(sandbox.records.EmailLog.length, 1, failAt);
    assert.equal(Number(sandbox.records.EmailLog[0].RetryCount), 0, failAt);
    assert.equal(sandbox.records.EmailLog[0].Result, 'FAILED', failAt);
    sandbox.setFailOnce('');
    const retry = sandbox.service.retryFailedAppointmentReminders();
    assert.equal(retry.sent, 1, failAt);
    assert.equal(sandbox.records.AppointmentReminderLog.length, 1, failAt);
    assert.equal(sandbox.records.AppointmentReminderLog[0].RetryCount, 1, failAt);
    assert.deepEqual(sandbox.records.EmailLog.map((row) => Number(row.RetryCount)), [0, 1], failAt);
    assert.equal(sandbox.sent.length, 1, failAt);
  }
});

test('reminder attempt cap counts every failed send and prevents further token generation', () => {
  const sandbox = appointmentSandbox({ deliveryFailure: true, settings: { APPOINTMENT_REMINDER_RETRY_LIMIT: '1' } });
  sandbox.service.processAppointmentDueReminders();
  sandbox.service.retryFailedAppointmentReminders();
  const before = { emails: sandbox.records.EmailLog.length, tokens: sandbox.records.ActionTokens.length };
  const exhausted = sandbox.service.retryFailedAppointmentReminders();
  assert.equal(exhausted.sent, 0);
  assert.equal(sandbox.records.EmailLog.length, before.emails);
  assert.equal(sandbox.records.ActionTokens.length, before.tokens);
  assert.equal(sandbox.records.AppointmentReminderLog[0].RetryCount, 1);
  assert.deepEqual(sandbox.records.EmailLog.map((row) => Number(row.RetryCount)), [0, 1]);
});

test('the default retry limit allows three retries after the initial attempt', () => {
  const sandbox = appointmentSandbox({ deliveryFailure: true });
  sandbox.service.processAppointmentDueReminders();
  sandbox.service.retryFailedAppointmentReminders();
  sandbox.service.retryFailedAppointmentReminders();
  sandbox.service.retryFailedAppointmentReminders();
  const before = sandbox.records.EmailLog.length;
  sandbox.service.retryFailedAppointmentReminders();
  assert.equal(before, 4);
  assert.equal(sandbox.records.EmailLog.length, 4);
  assert.equal(sandbox.records.AppointmentReminderLog[0].RetryCount, 3);
  assert.deepEqual(sandbox.records.EmailLog.map((row) => Number(row.RetryCount)), [0, 1, 2, 3]);
});

test('a zero reminder retry limit permits the initial attempt but no retry', () => {
  const sandbox = appointmentSandbox({ deliveryFailure: true, settings: { APPOINTMENT_REMINDER_RETRY_LIMIT: '0' } });
  assert.equal(sandbox.service.processAppointmentDueReminders().failed, 1);
  const before = { emails: sandbox.records.EmailLog.length, tokens: sandbox.records.ActionTokens.length };
  const result = sandbox.service.retryFailedAppointmentReminders();
  assert.equal(result.sent, 0);
  assert.equal(sandbox.records.EmailLog.length, before.emails);
  assert.equal(sandbox.records.ActionTokens.length, before.tokens);
  assert.equal(sandbox.records.AppointmentReminderLog[0].RetryCount, 0);
  assert.deepEqual(sandbox.records.EmailLog.map((row) => Number(row.RetryCount)), [0]);
});

test('appointment requests become durably replayable before their email attempt is claimed', () => {
  const { service, events, sent } = appointmentSandbox();
  service.processAppointmentDueReminders();
  const token = queryValue(linksFromMail(sent[0]).received, 'token');
  const start = events.length;
  service.confirmPatientReceived_({ token }, 'claim-order');
  const actionEvents = events.slice(start);
  assert.ok(actionEvents.indexOf('composite:RequestLog') < actionEvents.indexOf('update:EmailLog'));
  assert.ok(actionEvents.indexOf('unlock') < actionEvents.indexOf('email'));
});

test('an unfinished SENDING reminder is marked uncertain and never sent again', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  sandbox.records.AppointmentReminderLog[0].Result = 'PREPARED';
  sandbox.records.EmailLog[0].Result = 'SENDING';
  sandbox.sent.length = 0;
  const result = sandbox.service.retryFailedAppointmentReminders();
  assert.equal(result.uncertain, 1);
  assert.equal(sandbox.records.AppointmentReminderLog[0].Result, 'UNCERTAIN');
  assert.equal(sandbox.sent.length, 0);
});

test('reconciliation re-reads the latest chain under lock and preserves a racing terminal success', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  const reminder = sandbox.records.AppointmentReminderLog[0];
  reminder.Result = 'PREPARED';
  const original = sandbox.records.EmailLog[0];
  original.Result = 'SENDING';
  const snapshot = JSON.parse(sandbox.records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT').ResponseData);
  sandbox.sent.length = 0;
  sandbox.onNextLock(() => {
    const receipt = { ...clone(original), EmailLogID: 'EML-racing-terminal', Result: 'SUCCESS', SentAt: '2026-07-19T01:03:00.000Z' };
    sandbox.records.EmailLog.push(receipt);
    sandbox.records.RequestLog.push({ RequestID: receipt.EmailLogID, Action: 'EMAIL_SNAPSHOT', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) });
  });
  sandbox.service.retryFailedAppointmentReminders();
  assert.equal(reminder.Result, 'SUCCESS');
  assert.notEqual(reminder.Result, 'UNCERTAIN');
  assert.equal(sandbox.sent.length, 0);
});

function terminalReminderFixture(options = {}) {
  const sandbox = appointmentSandbox(options);
  sandbox.service.processAppointmentDueReminders();
  const reminder = sandbox.records.AppointmentReminderLog[0];
  const attempt = sandbox.records.EmailLog[0];
  reminder.Result = 'PREPARED';
  attempt.Result = 'SENDING';
  delete sandbox.records.OrderHeaders[0].LastAppointmentReminderAt;
  delete sandbox.records.OrderHeaders[0].LastAppointmentReminderSequence;
  sandbox.sent.length = 0;
  const snapshot = JSON.parse(sandbox.records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT' && row.RequestID === attempt.EmailLogID).ResponseData);
  const terminalOutcome = { result: 'SUCCESS', errorMessage: '', recipient: { to: 'er@example.invalid', cc: '' }, template: { subject: 'Appointment' } };
  return { sandbox, reminder, attempt, snapshot, terminalOutcome, order: clone(sandbox.records.OrderHeaders[0]) };
}

test('terminalization after reconciliation wins through a locked terminal write and reminder re-read', () => {
  const fixture = terminalReminderFixture();
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'UNCERTAIN');
  const start = fixture.sandbox.events.length;
  const outcome = fixture.sandbox.service.recordTerminalEmailOutcome_(fixture.attempt, fixture.snapshot, fixture.terminalOutcome);
  fixture.sandbox.service.reconcileReminderDelivery_(fixture.reminder, fixture.order, outcome, new Date('2026-07-19T01:04:00.000Z'));
  assert.deepEqual(fixture.sandbox.events.slice(start, start + 3), ['lock', 'update:EmailLog', 'unlock']);
  assert.equal(fixture.reminder.Result, 'SUCCESS');
  assert.equal(fixture.sandbox.records.OrderHeaders[0].LastAppointmentReminderSequence, 1);
});

test('terminalization before reconciliation is observed as terminal and never overwritten uncertain', () => {
  const fixture = terminalReminderFixture();
  fixture.sandbox.service.recordTerminalEmailOutcome_(fixture.attempt, fixture.snapshot, fixture.terminalOutcome);
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'SUCCESS');
  assert.notEqual(fixture.reminder.Result, 'UNCERTAIN');
  assert.equal(fixture.sandbox.sent.length, 0);
});

test('a later scheduled reconciliation recovers UNCERTAIN to terminal success after a callback crash', () => {
  const fixture = terminalReminderFixture();
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'UNCERTAIN');
  fixture.sandbox.service.recordTerminalEmailOutcome_(fixture.attempt, fixture.snapshot, fixture.terminalOutcome);
  assert.equal(fixture.reminder.Result, 'UNCERTAIN', 'the immediate reminder callback is deliberately skipped');
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'SUCCESS');
  assert.equal(fixture.sandbox.records.OrderHeaders[0].LastAppointmentReminderSequence, 1);
  assert.ok(fixture.sandbox.records.OrderHeaders[0].LastAppointmentReminderAt);
  assert.equal(fixture.sandbox.sent.length, 0);
});

test('a later scheduled reconciliation recovers UNCERTAIN to terminal failure without resend', () => {
  const fixture = terminalReminderFixture({ settings: { APPOINTMENT_REMINDER_RETRY_LIMIT: '0' } });
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'UNCERTAIN');
  fixture.sandbox.service.recordTerminalEmailOutcome_(fixture.attempt, fixture.snapshot, {
    result: 'FAILED', errorMessage: 'EMAIL_DELIVERY_FAILED', recipient: { to: 'er@example.invalid', cc: '' }, template: { subject: 'Appointment' },
  });
  assert.equal(fixture.reminder.Result, 'UNCERTAIN', 'the immediate reminder callback is deliberately skipped');
  fixture.sandbox.service.retryFailedAppointmentReminders();
  assert.equal(fixture.reminder.Result, 'FAILED');
  assert.equal(fixture.reminder.RetryCount, 0);
  assert.equal(fixture.sandbox.sent.length, 0);
  assert.equal(fixture.sandbox.records.EmailLog.length, 1);
});

test('an unfinished PENDING reminder is never delivered after cancellation', () => {
  const sandbox = appointmentSandbox();
  sandbox.service.processAppointmentDueReminders();
  sandbox.records.AppointmentReminderLog[0].Result = 'PREPARED';
  sandbox.records.EmailLog[0].Result = 'PENDING';
  sandbox.records.OrderHeaders[0].Status = 'CANCELLED';
  sandbox.sent.length = 0;
  sandbox.service.retryFailedAppointmentReminders();
  assert.equal(sandbox.records.AppointmentReminderLog[0].Result, 'SKIPPED_STALE');
  assert.equal(sandbox.records.EmailLog[0].Result, 'FAILED');
  assert.equal(sandbox.sent.length, 0);
});

test('trigger setup preserves unrelated triggers and creates the named handler only once', () => {
  const { service, triggers } = appointmentSandbox({ triggers: ['unrelatedHandler'] });
  service.setupAppointmentReminderTrigger();
  service.setupAppointmentReminderTrigger();
  assert.deepEqual(triggers.map((trigger) => trigger.getHandlerFunction()), ['unrelatedHandler', 'processAppointmentDueReminders']);
  assert.match(source('backend/TriggerService.gs'), /LockService\.getScriptLock\(\)/);
  assert.match(source('backend/TriggerService.gs'), /ScriptApp\.getProjectTriggers\(\)/);
  assert.doesNotMatch(source('backend/TriggerService.gs'), /\bTriggerApp\b/);
});

test('router exposes scanner-safe public previews and authenticated rescheduling with exact handlers', () => {
  const seen = [];
  const runtime = {
    ApiError_: ApiError,
    requireSession_: () => staff,
    getAppointmentAction_: (token) => { seen.push(['preview', token]); return {}; },
    getRescheduleReference_: (token) => { seen.push(['reference', token]); return {}; },
    confirmPatientReceived_: (payload, requestId) => { seen.push(['received', payload.token, requestId]); return {}; },
    submitPatientNoShow_: (payload, requestId) => { seen.push(['no-show', payload.token, requestId]); return {}; },
    getRescheduleOrder_: (_context, reference) => { seen.push(['order', reference]); return {}; },
    submitAppointmentReschedule_: (_context, payload, requestId) => { seen.push(['reschedule', payload.reference, requestId]); return {}; },
  };
  const api = vm.runInNewContext(`${source('backend/ApiRouter.gs')}\n({ routeApiRequest_, GET_ACTIONS_, API_ACTIONS_ });`, runtime);
  api.routeApiRequest_({ action: 'GET_APPOINTMENT_ACTION', method: 'GET', requestId: 'get-1', payload: { token: 'opaque-1' } });
  api.routeApiRequest_({ action: 'GET_RESCHEDULE_REFERENCE', method: 'GET', requestId: 'get-2', payload: { reference: 'opaque-2' } });
  api.routeApiRequest_({ action: 'CONFIRM_PATIENT_RECEIVED', method: 'POST', requestId: 'post-1', payload: { token: 'opaque-1' } });
  api.routeApiRequest_({ action: 'SUBMIT_PATIENT_NO_SHOW', method: 'POST', requestId: 'post-2', payload: { token: 'opaque-2' } });
  api.routeApiRequest_({ action: 'GET_RESCHEDULE_ORDER', method: 'POST', requestId: 'post-3', sessionToken: 'session', payload: { reference: 'opaque-3' } });
  api.routeApiRequest_({ action: 'SUBMIT_APPOINTMENT_RESCHEDULE', method: 'POST', requestId: 'post-4', sessionToken: 'session', payload: { reference: 'opaque-3' } });
  assert.deepEqual(seen, [
    ['preview', 'opaque-1'], ['reference', 'opaque-2'], ['received', 'opaque-1', 'post-1'],
    ['no-show', 'opaque-2', 'post-2'], ['order', 'opaque-3'], ['reschedule', 'opaque-3', 'post-4'],
  ]);
  assert.equal(api.GET_ACTIONS_.GET_APPOINTMENT_ACTION.mutates, false);
  assert.equal(api.API_ACTIONS_.GET_RESCHEDULE_ORDER.auth, true);
  assert.equal(api.API_ACTIONS_.SUBMIT_APPOINTMENT_RESCHEDULE.auth, true);
});
