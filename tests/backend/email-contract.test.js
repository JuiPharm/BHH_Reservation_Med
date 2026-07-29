const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }

function emailSandbox(options = {}) {
  const records = {
    EmailLog: [], RequestLog: [], AuditLog: [],
    Users: options.users || [{ StaffID: 'staff-1', Email: 'current@example.invalid', Active: 'TRUE' }],
    Departments: options.departments || [{ DepartmentCode: 'ER', DepartmentEmail: 'er-department@example.invalid', CCEmail: 'er-cc@example.invalid', Active: 'TRUE' }],
  };
  const logs = records.EmailLog;
  const sent = [];
  const events = [];
  let lockDepth = 0;
  let competingReservationInserted = false;
  const runtime = {
    Array, Date, JSON, Math, Number, Object, RegExp, String,
    Utilities: { getUuid: (() => { let count = 0; return () => `${options.uuidPrefix || 'uuid'}-${++count}`; })() },
    LockService: { getScriptLock: () => ({
      waitLock: () => { assert.equal(lockDepth, 0, 'script locks must not be nested'); lockDepth += 1; events.push('lock'); },
      releaseLock: () => { lockDepth -= 1; events.push('unlock'); },
    }) },
    MailApp: { sendEmail: (message) => { assert.equal(lockDepth, 0, 'MailApp must run outside the script lock'); events.push('email'); if (options.deliveryError) throw new Error(options.deliveryError); sent.push(message); } },
    appendRecords_: (sheet, rows) => {
      if (options.logError && sheet === 'EmailLog') throw new Error(options.logError);
      const target = records[sheet] || (records[sheet] = []);
      if (sheet === 'EmailLog' && options.competingReservation && lockDepth === 0 && !competingReservationInserted) {
        competingReservationInserted = true;
        target.push(JSON.parse(JSON.stringify(rows[0])));
      }
      target.push(...JSON.parse(JSON.stringify(rows)));
    },
    updateRecordByKey_: (sheet, key, value, updates) => {
      events.push(`update:${sheet}`);
      const log = (records[sheet] || []).find((entry) => String(entry[key]) === String(value));
      if (!log) return null;
      Object.assign(log, updates);
      return log;
    },
    readRecords_: (sheet, query = {}) => {
      const rows = records[sheet] || [];
      const chosen = query.predicate ? rows.filter(query.predicate) : rows;
      return JSON.parse(JSON.stringify(query.limit == null ? chosen : chosen.slice(0, query.limit)));
    },
    writeAudit_: (row) => records.AuditLog.push(JSON.parse(JSON.stringify(row))),
  };
  const service = vm.runInNewContext(`${source('backend/EmailService.gs')}\n({ sendTemplatedEmail_, retryEmailDelivery_, buildOrderEmailTemplate_, sendOrderNotificationSafe_, loadEmailSnapshot_, emailAttemptChainKey_, claimPostCommitAttempt_, recordTerminalEmailOutcome_, deliverPostCommitNotificationJob_ });`, runtime);
  return { service, records, logs, sent, events };
}

test('only the request that changes a post-commit attempt from PENDING to SENDING owns delivery', () => {
  const { service, logs } = emailSandbox();
  logs.push({ EmailLogID: 'EML-race', Result: 'PENDING', SentAt: '' });
  const first = service.claimPostCommitAttempt_('EML-race');
  const racingReplay = service.claimPostCommitAttempt_('EML-race');
  assert.equal(first.owned, true);
  assert.equal(racingReplay.owned, false);
  assert.equal(racingReplay.attempt.Result, 'SENDING');
});

test('a stale terminalizer cannot overwrite an already terminal email outcome', () => {
  const { service, logs } = emailSandbox();
  logs.push({ EmailLogID: 'EML-terminal-race', OrderID: 'MED-1', Result: 'SUCCESS', SentAt: '2026-07-29T01:00:00.000Z', ErrorMessage: '' });
  const result = service.recordTerminalEmailOutcome_(
    { EmailLogID: 'EML-terminal-race', OrderID: 'MED-1', Result: 'SENDING' },
    { schemaVersion: 1, rootEmailLogId: 'EML-terminal-race', templateName: 'ORDER_UPDATE', header: { OrderID: 'MED-1' }, event: {} },
    { result: 'FAILED', errorMessage: 'EMAIL_DELIVERY_FAILED', recipient: { to: '', cc: '' }, template: null },
  );
  assert.equal(result.result, 'SUCCESS');
  assert.equal(logs[0].Result, 'SUCCESS');
  assert.equal(logs.length, 1);
});

test('first post-commit reservation is serialized so racing finalizers cannot append duplicate identities', () => {
  const { service, logs } = emailSandbox({ competingReservation: true });
  const result = service.deliverPostCommitNotificationJob_({
    emailLogId: 'EML-first-reservation',
    templateName: 'ORDER_UPDATE',
    deliveryMode: 'SEND',
    snapshot: {
      schemaVersion: 1, rootEmailLogId: 'EML-first-reservation', templateName: 'ORDER_UPDATE',
      header: { OrderID: 'MED-1', CreatedByStaffID: 'staff-1', Department: 'ER', Version: 1 },
      event: { actor: { StaffID: 'staff-1' }, occurredAt: '2026-07-29T01:00:00.000Z', orderVersion: 1 },
      actor: { StaffID: 'staff-1' }, changes: [],
    },
  });
  assert.equal(result.result, 'SUCCESS');
  assert.equal(logs.filter((row) => row.EmailLogID === 'EML-first-reservation').length, 1);
});

const header = {
  OrderID: 'MED-20260719-0001', Department: 'ER', HN: '07-01-000001', PatientName: '<Ada & Bob>',
  CreatedAt: '2026-07-19T10:00:00.000Z', RequiredDate: '2026-07-20', Status: 'RECEIVED', Version: 2,
};
const items = [{ GenericName: '<Amoxicillin>', RequestedQuantity: 2, Unit: 'TABLET', ItemStatus: 'RECEIVED', ReceivedQuantity: 2, ReceivedUnit: 'TABLET', ReceivedDate: '2026-07-19' }];

test('templated medication-received delivery escapes and masks every patient value in HTML and plain text', () => {
  const { service, sent, logs, events } = emailSandbox();
  const result = service.sendTemplatedEmail_('MEDICATION_RECEIVED', { header, items, actor: { StaffID: 'admin-1' } }, { to: 'staff@example.invalid', cc: 'cc@example.invalid' });
  assert.equal(result.result, 'SUCCESS');
  assert.equal(sent[0].subject, '[Medication Received] Order ID: MED-20260719-0001');
  assert.match(sent[0].htmlBody, /&lt;Amoxicillin&gt;/);
  assert.doesNotMatch(sent[0].htmlBody, /Ada &amp; Bob/);
  assert.doesNotMatch(sent[0].htmlBody, /07-01-000001/);
  assert.doesNotMatch(sent[0].body, /07-01-000001/);
  assert.match(sent[0].body, /Item status: RECEIVED/);
  assert.deepEqual(logs[0].CC, 'cc@example.invalid');
  assert.equal(logs[0].Result, 'SUCCESS');
  const mailIndex = events.indexOf('email');
  assert.deepEqual(events.slice(mailIndex, mailIndex + 4), ['email', 'lock', 'update:EmailLog', 'unlock']);
});

test('failed delivery writes a safe failed log and a retry increments only the delivery attempt', () => {
  const failed = emailSandbox({ deliveryError: 'smtp <unsafe> secret' });
  const retryHeader = { ...header, CreatedByStaffID: 'staff-1' };
  const first = failed.service.sendTemplatedEmail_('MEDICATION_RECEIVED', { header: retryHeader, items, actor: { StaffID: 'admin-1' } }, { to: 'staff@example.invalid' });
  assert.equal(first.result, 'FAILED');
  assert.equal(failed.logs[0].ErrorMessage, 'EMAIL_DELIVERY_FAILED');

  const retry = emailSandbox({ uuidPrefix: 'retry' });
  retry.logs.push(...failed.logs);
  const result = retry.service.retryEmailDelivery_(retry.logs[0], { header: retryHeader, items, actor: { StaffID: 'admin-1' } });
  assert.equal(result.result, 'SUCCESS');
  assert.equal(retry.logs.length, 2);
  assert.equal(retry.logs[0].RetryCount, 0);
  assert.equal(retry.logs[0].Result, 'FAILED');
  assert.equal(retry.logs[1].RetryCount, 1);
  assert.equal(retry.logs[1].Result, 'SUCCESS');
});

test('delivery traps template, recipient, and EmailLog failures as a durable failed outcome', () => {
  const invalid = emailSandbox();
  const result = invalid.service.sendTemplatedEmail_('NOT_A_TEMPLATE', { header, items, actor: { StaffID: 'admin-1' } }, { to: 'invalid@example.invalid' });
  assert.equal(result.result, 'FAILED');
  assert.match(result.emailLogId, /^EML-/);

  const badRecipient = emailSandbox();
  const badResult = badRecipient.service.sendTemplatedEmail_('MEDICATION_RECEIVED', { header, items, actor: { StaffID: 'admin-1' } }, { to: 'one@example.invalid,two@example.invalid' });
  assert.equal(badResult.result, 'FAILED');
  assert.match(badResult.emailLogId, /^EML-/);

  const logFailure = emailSandbox({ logError: 'sheet unavailable' });
  const logResult = logFailure.service.sendTemplatedEmail_('MEDICATION_RECEIVED', { header, items, actor: { StaffID: 'admin-1' } }, { to: 'valid@example.invalid' });
  assert.equal(logResult.result, 'FAILED');
  assert.equal(logResult.emailLogId, '');
});

test('appointment due has three explicit HTML buttons and plain links while update renders only changed fields', () => {
  const { service } = emailSandbox();
  const due = service.buildOrderEmailTemplate_('APPOINTMENT_DUE', { header, items, actor: {}, actionLinks: { received: 'https://example.invalid/received', noShow: 'https://example.invalid/no-show', reschedule: 'https://example.invalid/reschedule' } });
  for (const label of ['คนไข้รับยาเรียบร้อย', 'คนไข้ไม่มารับยา', 'คนไข้เลื่อนนัด']) {
    assert.match(due.htmlBody, new RegExp(label));
    assert.match(due.body, new RegExp(label));
  }
  assert.equal((due.htmlBody.match(/role="button"/g) || []).length, 3);
  assert.equal((due.htmlBody.match(/aria-label=/g) || []).length, 3);
  assert.equal((due.htmlBody.match(/display:inline-block/g) || []).length, 3);
  assert.doesNotMatch(due.body, /Amoxicillin|Item status|Received:/);
  assert.doesNotMatch(due.htmlBody, /Amoxicillin|Item status|Received:/);
  const update = service.buildOrderEmailTemplate_('ORDER_UPDATE', { header, changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: 'URGENT' }] });
  assert.match(update.body, /Priority: NORMAL → URGENT/);
  assert.doesNotMatch(update.body, /Patient:/);
  assert.doesNotMatch(update.body, /HN:/);
  assert.doesNotMatch(update.body, /Amoxicillin/);
  assert.throws(() => service.buildOrderEmailTemplate_('APPOINTMENT_DUE', { header, items, actionLinks: { received: 'https://', noShow: 'https://example.invalid/no-show', reschedule: 'https://example.invalid/reschedule' } }), /Invalid appointment action URL/);

  const cancelled = service.buildOrderEmailTemplate_('CANCELLATION', { header: { ...header, CancelledBy: 'staff-1', CancelledAt: '2026-07-19T11:00:00.000Z' }, actor: { FullName: 'Extra Actor' }, previousStatus: 'RECEIVED', cancelReason: 'PATIENT_CANCELLED' });
  assert.match(cancelled.body, /Cancelled by: staff-1/);
  assert.doesNotMatch(cancelled.body, /^Actor:/m);
  assert.doesNotMatch(cancelled.htmlBody, /<strong>Actor:/);
});

test('every managed attempt stores and reloads an immutable event snapshot with actor, time, version, diffs, and items', () => {
  const { service, records } = emailSandbox();
  const model = {
    header: { ...header, CreatedByStaffID: 'staff-1' }, items: JSON.parse(JSON.stringify(items)),
    actor: { StaffID: 'admin-1', FullName: 'Original Admin', Role: 'ADMIN' },
    eventAt: '2026-07-19T09:30:00.000Z', orderVersion: 2,
    changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: 'URGENT' }],
  };
  const result = service.sendOrderNotificationSafe_('ORDER_UPDATE', model);
  assert.equal(result.result, 'SUCCESS');
  model.actor.FullName = 'Mutated';
  model.items[0].GenericName = 'Mutated';
  model.changes[0].newValue = 'MUTATED';
  const snapshot = service.loadEmailSnapshot_(result.emailLogId);
  assert.equal(snapshot.event.actor.FullName, 'Original Admin');
  assert.equal(snapshot.event.occurredAt, '2026-07-19T09:30:00.000Z');
  assert.equal(snapshot.event.orderVersion, 2);
  assert.equal(snapshot.changes[0].newValue, 'URGENT');
  assert.equal(snapshot.items[0].GenericName, '<Amoxicillin>');
  assert.equal(records.RequestLog.filter((row) => row.Action === 'EMAIL_SNAPSHOT').length, 1);
});

test('appointment due resolves current department routing and resolver failures are durably logged and audited', () => {
  const routed = emailSandbox();
  const result = routed.service.sendOrderNotificationSafe_('APPOINTMENT_DUE', {
    header: { ...header, CreatedByStaffID: 'staff-1' }, items, actor: { StaffID: 'system' },
    actionLinks: { received: 'https://example.invalid/received', noShow: 'https://example.invalid/no-show', reschedule: 'https://example.invalid/reschedule' },
  });
  assert.equal(result.result, 'SUCCESS');
  assert.equal(routed.sent[0].to, 'er-department@example.invalid');
  assert.equal(routed.sent[0].cc, 'er-cc@example.invalid');

  const broken = emailSandbox({ departments: [{ DepartmentCode: 'ER', DepartmentEmail: 'not-an-email', CCEmail: '', Active: 'TRUE' }] });
  const failed = broken.service.sendOrderNotificationSafe_('APPOINTMENT_DUE', {
    header: { ...header, CreatedByStaffID: 'staff-1' }, actor: { StaffID: 'system', Role: 'SYSTEM' },
    actionLinks: { received: 'https://example.invalid/received', noShow: 'https://example.invalid/no-show', reschedule: 'https://example.invalid/reschedule' },
  });
  assert.equal(failed.result, 'FAILED');
  assert.equal(broken.logs[0].Result, 'FAILED');
  assert.equal(broken.records.AuditLog.at(-1).Action, 'EMAIL_RECIPIENT_RESOLUTION');
  assert.equal(broken.sent.length, 0);
});

test('managed recipient records are active only when normalized Active is exactly TRUE', () => {
  for (const active of ['', ' ', 'FALSE', 'YES', '1']) {
    const users = emailSandbox({ users: [{ StaffID: 'staff-1', Email: 'current@example.invalid', Active: active }] });
    const userResult = users.service.sendOrderNotificationSafe_('ORDER_UPDATE', { header: { ...header, CreatedByStaffID: 'staff-1' }, changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: 'URGENT' }] });
    assert.equal(userResult.result, 'FAILED', `Users Active=${JSON.stringify(active)}`);
    assert.equal(users.sent.length, 0);

    const departments = emailSandbox({ departments: [{ DepartmentCode: 'ER', DepartmentEmail: 'department@example.invalid', CCEmail: '', Active: active }] });
    const departmentResult = departments.service.sendOrderNotificationSafe_('APPOINTMENT_DUE', {
      header, actionLinks: { received: 'https://example.invalid/received', noShow: 'https://example.invalid/no-show', reschedule: 'https://example.invalid/reschedule' },
    });
    assert.equal(departmentResult.result, 'FAILED', `Departments Active=${JSON.stringify(active)}`);
    assert.equal(departments.sent.length, 0);
  }

  const normalized = emailSandbox({ users: [{ StaffID: 'staff-1', Email: 'current@example.invalid', Active: ' true ' }] });
  assert.equal(normalized.service.sendOrderNotificationSafe_('ORDER_UPDATE', { header: { ...header, CreatedByStaffID: 'staff-1' }, changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: 'URGENT' }] }).result, 'SUCCESS');
});
