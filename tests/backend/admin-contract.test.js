const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }
function ApiError(errorCode, safeMessage, errors) { this.errorCode = errorCode; this.safeMessage = safeMessage; this.errors = errors; }

function adminSandbox(options = {}) {
  const records = {
    OrderHeaders: [
      { OrderID: 'MED-1', Department: 'ER', Status: 'ORDERED', Version: 1, HN: '07-01-000001', PatientName: 'Ada', RequesterEmail: 'er@example.invalid', ItemCount: 1 },
      { OrderID: 'MED-2', Department: 'ICU', Status: 'ORDERED', Version: 1, HN: '07-01-000002', PatientName: 'Grace', RequesterEmail: 'icu@example.invalid', ItemCount: 1 },
    ],
    OrderItems: [{ OrderItemID: 'MED-1-01', OrderID: 'MED-1', ItemNo: 1, RequestedQuantity: 2, Unit: 'TABLET', ItemStatus: 'ORDERED', Active: 'TRUE' }],
    OrderChangeLog: [], AuditLog: [], RequestLog: [], EmailLog: [],
  };
  const runtime = {
    ApiError_: ApiError, Array, Date, JSON, Math, Number, Object, RegExp, String, isFinite,
    Utilities: { getUuid: (() => { let count = 0; return () => `uuid-${++count}`; })() },
    readRecords_: (name, query = {}) => { const rows = records[name] || []; const chosen = query.predicate ? rows.filter(query.predicate) : rows; return JSON.parse(JSON.stringify(query.limit == null ? chosen : chosen.slice(0, query.limit))); },
    appendRecords_: (name, rows) => { (records[name] || (records[name] = [])).push(...JSON.parse(JSON.stringify(rows))); },
    updateRecordByKey_: (name, key, value, updates) => { const row = records[name].find((entry) => String(entry[key]) === String(value)); if (!row) return null; Object.assign(row, JSON.parse(JSON.stringify(updates))); return row; },
    updateRecordByCompositeKey_: (name, keys, updates) => { const row = records[name].find((entry) => Object.entries(keys).every(([key, value]) => String(entry[key] || '') === String(value || ''))); if (!row) throw new Error('Composite key must match exactly one record.'); Object.assign(row, JSON.parse(JSON.stringify(updates))); return row; },
    batchUpdateRecordsByKeys_: (name, key, updates) => updates.forEach((entry) => runtime.updateRecordByKey_(name, key, entry.keyValue, entry.updates)),
    writeChanges_: (rows) => { records.OrderChangeLog.push(...rows); }, writeAudit_: (row) => { records.AuditLog.push(row); },
    findOrderHeader_: (id) => records.OrderHeaders.find((entry) => entry.OrderID === id),
    getOrderItems_: (id) => records.OrderItems.filter((entry) => entry.OrderID === id),
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) }, CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    sendTemplatedEmail_: () => ({ result: 'SUCCESS' }),
    sendOrderNotificationSafe_: () => ({ result: 'SUCCESS' }),
    createPendingEmailAttempt_: (templateName, model, meta) => {
      const attempt = { EmailLogID: meta.emailLogId, OrderID: model.header.OrderID, ChangeSetID: '', EmailType: templateName, Result: 'PENDING', RetryCount: Number(meta.retryCount || 0) };
      const snapshot = { ...JSON.parse(JSON.stringify(model)), schemaVersion: 1, rootEmailLogId: meta.rootEmailLogId, attemptEmailLogId: meta.emailLogId, templateName, event: { actor: model.actor || {}, occurredAt: model.eventAt, orderVersion: model.orderVersion, changes: model.changes || [], items: model.items || [] } };
      records.EmailLog.push(attempt);
      records.RequestLog.push({ RequestID: attempt.EmailLogID, Action: 'EMAIL_SNAPSHOT', OrderID: attempt.OrderID, StaffID: attempt.SentBy || '', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) });
      return { attempt, snapshot, result: null };
    },
    makeEmailSnapshot_: (templateName, model, rootEmailLogId) => ({ ...JSON.parse(JSON.stringify(model)), schemaVersion: 1, rootEmailLogId, attemptEmailLogId: rootEmailLogId, templateName, event: { actor: model.actor || {}, occurredAt: model.eventAt, orderVersion: model.orderVersion, changes: model.changes || [], items: model.items || [] } }),
    persistEmailSnapshot_: (attempt, snapshot) => { records.RequestLog.push({ RequestID: attempt.EmailLogID, Action: 'EMAIL_SNAPSHOT', OrderID: attempt.OrderID, StaffID: attempt.SentBy || '', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) }); },
    claimPendingEmailAttemptLocked_: (emailLogId) => {
      const attempt = records.EmailLog.find((row) => row.EmailLogID === emailLogId);
      attempt.Result = 'SENDING';
      return { ...attempt };
    },
    deliverPendingEmailAttempt_: (attempt) => {
      const result = options.deliveryResult || 'SUCCESS';
      Object.assign(records.EmailLog.find((row) => row.EmailLogID === attempt.EmailLogID), { Result: result, ErrorMessage: result === 'FAILED' ? 'EMAIL_DELIVERY_FAILED' : '', SentAt: new Date().toISOString() });
      return { result, emailLogId: attempt.EmailLogID, errorMessage: result === 'FAILED' ? 'EMAIL_DELIVERY_FAILED' : '' };
    },
    loadEmailSnapshot_: (emailLogId) => JSON.parse(records.RequestLog.find((row) => row.Action === 'EMAIL_SNAPSHOT' && row.RequestID === emailLogId).ResponseData),
    getMasterData_: () => ({ UNIT: [{ Code: 'TABLET' }] }),
  };
  const service = vm.runInNewContext(`${source('backend/OrderService.gs')}\n({ listAllOrders_, getAdminDashboard_, updateReceivedItems_, sendOrderEmail_ });`, runtime);
  return { service, records };
}

const admin = { user: { StaffID: 'admin-1', FullName: 'Admin', Department: 'ER', Role: 'ADMIN' } };
const staff = { user: { StaffID: 'staff-1', FullName: 'Staff', Department: 'ER', Role: 'STAFF' } };

test('admin can filter all-department orders but summaries do not leak patient data', () => {
  const { service } = adminSandbox();
  const filtered = service.listAllOrders_(admin, { department: 'ICU' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.orders[0].OrderID, 'MED-2');
  assert.equal(Object.hasOwn(filtered.orders[0], 'HN'), false);
  assert.throws(() => service.listAllOrders_(staff, {}), (error) => error.errorCode === 'ACCESS_DENIED');
});

test('receiving validates exact Version and requested quantity, derives status, and preserves the committed receive write if mail fails', () => {
  const { service, records } = adminSandbox({ deliveryResult: 'FAILED' });
  assert.throws(() => service.updateReceivedItems_(admin, { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 3, ReceivedUnit: 'TABLET' }] }, 'receive-over'), (error) => error.errorCode === 'VALIDATION_ERROR');
  const result = service.updateReceivedItems_(admin, { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] }, 'receive-1');
  assert.equal(result.Status, 'RECEIVED');
  assert.equal(records.OrderHeaders[0].Version, 2);
  assert.equal(records.OrderItems[0].ReceivedQuantity, 2);
});

test('send order email requires the received Version, transitions exactly once, and replays without resending', () => {
  const { service, records } = adminSandbox();
  records.OrderHeaders[0].Status = 'RECEIVED';
  assert.throws(() => service.sendOrderEmail_(admin, { OrderID: 'MED-1' }, 'send-missing-version'), (error) => error.errorCode === 'VALIDATION_ERROR');
  const first = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'send-1');
  assert.equal(first.Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].Version, 2);
  const replay = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'send-1');
  assert.equal(replay.replayed, true);
});

test('failed two-phase delivery preserves RECEIVED and finalizes the request without another send', () => {
  const { service, records } = adminSandbox({ deliveryResult: 'FAILED' });
  records.OrderHeaders[0].Status = 'RECEIVED';
  const first = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'send-failed');
  assert.equal(first.Status, 'RECEIVED');
  assert.equal(records.OrderHeaders[0].Status, 'RECEIVED');
  assert.equal(records.OrderHeaders[0].NotificationStatus, 'FAILED');
  assert.equal(service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'send-failed').replayed, true);
});

test('receiving rejects units that are not active unit master data and terminal order cancellation transitions', () => {
  const { service, records } = adminSandbox();
  assert.throws(() => service.updateReceivedItems_(admin, { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'VIAL' }] }, 'invalid-unit'), (error) => error.errorCode === 'VALIDATION_ERROR');
  records.OrderHeaders[0].Status = 'CANCELLED';
  assert.throws(() => service.updateReceivedItems_(admin, { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] }, 'cancelled-receive'), (error) => error.errorCode === 'INVALID_STATUS_TRANSITION');
});

function workflowSandbox(options = {}) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const records = {
    OrderHeaders: [{
      OrderID: 'MED-1', Department: 'ER', Status: 'RECEIVED', Version: 1, HN: '07-01-000001', PatientName: 'Current Patient',
      CreatedByStaffID: 'staff-1', RequesterEmail: 'stale@example.invalid', ItemCount: 1,
    }],
    OrderItems: [{ OrderItemID: 'MED-1-01', OrderID: 'MED-1', GenericName: 'Current Medicine', RequestedQuantity: 2, Unit: 'TABLET', ItemStatus: 'RECEIVED', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }],
    OrderChangeLog: [], AuditLog: [], RequestLog: [], EmailLog: [], AppointmentResponseLog: [],
    Users: [{ StaffID: 'staff-1', Email: 'current@example.invalid', Active: 'TRUE' }],
    Departments: [{ DepartmentCode: 'ER', DepartmentEmail: 'department@example.invalid', CCEmail: 'department-cc@example.invalid', Active: 'TRUE' }],
  };
  if (options.records) Object.entries(options.records).forEach(([name, rows]) => { records[name] = clone(rows); });
  const sent = [];
  const events = [];
  const mailLockDepths = [];
  let lockDepth = 0;
  let injected = false;
  let finalizerCleanupFailed = false;
  let emailCleanupUpdateFailed = false;
  let emailCleanupAppendFailed = false;
  let businessAuditFailed = false;
  let explicitPrepCrashed = false;
  let prepCompletionFailed = false;
  const maybeFail = (label) => {
    if (!injected && options.failOnce === label) {
      injected = true;
      throw new Error(`injected ${label} failure`);
    }
  };
  const runtime = {
    ApiError_: ApiError, Array, Date, JSON, Math, Number, Object, RegExp, String, isFinite,
    Utilities: { getUuid: (() => { let count = 0; return () => `uuid-${++count}`; })() },
    readRecords_: (name, query = {}) => {
      const rows = records[name] || [];
      const chosen = query.predicate ? rows.filter(query.predicate) : rows;
      return clone(query.limit == null ? chosen : chosen.slice(0, query.limit));
    },
    appendRecords_: (name, rows) => {
      events.push(`append:${name}:${rows[0] && rows[0].Action || ''}`);
      if (!explicitPrepCrashed && options.explicitPrepCrash === 'after_request' && name === 'RequestLog' && rows[0] && rows[0].Action === 'EMAIL_SNAPSHOT') { explicitPrepCrashed = true; throw new Error('injected explicit prep crash after request'); }
      if (!explicitPrepCrashed && options.explicitPrepCrash === 'after_snapshot' && name === 'EmailLog' && records.RequestLog.some((row) => ['SEND_ORDER_EMAIL', 'RESEND_FAILED_EMAIL'].includes(row.Action) && row.Result === 'PENDING')) { explicitPrepCrashed = true; throw new Error('injected explicit prep crash after snapshot'); }
      if (options.terminalLogUncertain && name === 'EmailLog' && sent.length && rows[0] && ['SUCCESS', 'FAILED'].includes(rows[0].Result)) throw new Error('injected terminal receipt failure');
      if (options.failCleanupTerminalOnce && name === 'EmailLog' && rows[0] && rows[0].ErrorMessage === 'EMAIL_PREPARATION_ABORTED' && !emailCleanupAppendFailed) { emailCleanupAppendFailed = true; throw new Error('injected cleanup EmailLog append failure'); }
      if (!injected && options.failOnce === 'prepare:EmailLog' && name === 'EmailLog') { injected = true; throw new Error('injected prepare:EmailLog failure'); }
      if (!injected && options.failOnce === 'prepare:EmailSnapshot' && name === 'RequestLog' && rows[0] && rows[0].Action === 'EMAIL_SNAPSHOT') { injected = true; throw new Error('injected prepare:EmailSnapshot failure'); }
      maybeFail(name === 'OrderChangeLog' && sent.length ? 'write:OrderChangeLog' : `append:${name}`);
      (records[name] || (records[name] = [])).push(...clone(rows));
      return { startRow: records[name].length - rows.length + 2, rowCount: rows.length };
    },
    updateRecordByKey_: (name, key, value, updates) => {
      if (!explicitPrepCrashed && options.explicitPrepCrash === 'before_claim' && name === 'EmailLog' && updates.Result === 'SENDING') { explicitPrepCrashed = true; throw new Error('injected explicit prep crash before claim'); }
      if (options.terminalLogUncertain && name === 'EmailLog' && sent.length && ['SUCCESS', 'FAILED'].includes(updates.Result)) throw new Error('injected terminal update failure');
      if (options.failCleanupTerminalOnce && name === 'EmailLog' && updates.ErrorMessage === 'EMAIL_PREPARATION_ABORTED' && !emailCleanupUpdateFailed) { emailCleanupUpdateFailed = true; throw new Error('injected cleanup EmailLog update failure'); }
      if (!injected && options.failOnce === 'partial:update:OrderHeaders' && name === 'OrderHeaders' && sent.length) {
        const partial = (records[name] || []).find((entry) => String(entry[key]) === String(value));
        if (partial) Object.assign(partial, { Status: updates.Status, Version: updates.Version });
        injected = true;
        throw new Error('injected partial:update:OrderHeaders failure');
      }
      if (name === 'OrderHeaders' && sent.length) maybeFail('update:OrderHeaders');
      if (name === 'EmailLog' && sent.length) maybeFail('update:EmailLog');
      const row = (records[name] || []).find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, clone(updates));
      return clone(row);
    },
    updateRecordByCompositeKey_: (name, keys, updates) => {
      events.push(`composite:${name}:${keys.Action || ''}:${updates.Result || ''}`);
      let response = {};
      try { response = JSON.parse(String(updates.ResponseData || '{}')); } catch (_ignored) {}
      if (!explicitPrepCrashed && options.explicitPrepCrash === 'after_attempt' && name === 'RequestLog' && updates.Result === 'PENDING' && response.PreparationPhase === 'ATTEMPT_READY') { explicitPrepCrashed = true; throw new Error('injected explicit prep crash after attempt'); }
      if (!prepCompletionFailed && options.failPrepCompletionOnce && name === 'RequestLog' && keys.Action === 'FINALIZE_RECEIVED_EMAIL' && updates.Result === 'SUCCESS' && response.finalizationOutcome === 'PREPARATION_FAILED') { prepCompletionFailed = true; throw new Error('injected preparation completion failure'); }
      if (options.failFinalizerAbortOnce && name === 'RequestLog' && keys.Action === 'FINALIZE_RECEIVED_EMAIL' && updates.Result === 'TRANSACTION_FAILURE' && !finalizerCleanupFailed) { finalizerCleanupFailed = true; throw new Error('injected finalizer cleanup failure'); }
      if (name === 'RequestLog' && updates.Result === 'SUCCESS' && sent.length) maybeFail('complete:RequestLog');
      const matches = (records[name] || []).filter((row) => Object.entries(keys).every(([key, value]) => String(row[key] || '') === String(value || '')));
      if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
      Object.assign(matches[0], clone(updates));
      return clone(matches[0]);
    },
    batchUpdateRecordsByKeys_: (name, key, updates) => updates.forEach((entry) => runtime.updateRecordByKey_(name, key, entry.keyValue, entry.updates)),
    writeChanges_: (rows) => { maybeFail(sent.length ? 'write:OrderChangeLog' : 'write:OrderChangeLog-pre-send'); records.OrderChangeLog.push(...clone(rows)); },
    writeAudit_: (row) => {
      if (options.failBusinessAuditOnce && row.Action === 'UPDATE_RECEIVED_ITEMS' && row.Result === 'SUCCESS' && !businessAuditFailed) { businessAuditFailed = true; throw new Error('injected business audit failure'); }
      if (sent.length && (row.Action === 'SEND_ORDER_EMAIL' || row.Action === 'RESEND_FAILED_EMAIL')) maybeFail('write:AuditLog');
      records.AuditLog.push(clone(row));
    },
    findOrderHeader_: (id) => clone(records.OrderHeaders.find((entry) => String(entry.OrderID) === String(id)) || null),
    getOrderItems_: (id) => clone(records.OrderItems.filter((entry) => String(entry.OrderID) === String(id))),
    getMasterData_: () => ({ UNIT: [{ Code: 'TABLET' }] }),
    LockService: { getScriptLock: () => ({ waitLock: () => { lockDepth += 1; events.push('lock'); }, releaseLock: () => { lockDepth -= 1; events.push('unlock'); } }) },
    CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    MailApp: { sendEmail: (message) => {
      mailLockDepths.push(lockDepth);
      sent.push(clone(message));
      events.push('email');
      if (options.concurrentAfterDelivery) Object.assign(records.OrderHeaders[0], { Status: 'CANCEL_REQUESTED', Version: 2, LastChangeSetID: 'concurrent-change', NotificationStatus: 'CURRENT' });
      const outcome = (options.deliveryOutcomes || [])[sent.length - 1];
      if (outcome === 'FAILED') throw new Error('injected delivery failure');
    } },
  };
  const service = vm.runInNewContext(`${source('backend/EmailService.gs')}\n${source('backend/OrderService.gs')}\n({ updateReceivedItems_, sendOrderEmail_, resendFailedEmail_, loadEmailSnapshot_, emailAttemptChainKey_, failReceivedFinalizerLocked_ });`, runtime);
  return { service, records, sent, events, mailLockDepths };
}

test('a terminal successful delivery reconciles a pending request under lock without sending again', () => {
  const { service, records, sent } = workflowSandbox({ failOnce: 'write:OrderChangeLog' });
  assert.throws(() => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'reconcile-1'), /injected write:OrderChangeLog/);
  assert.equal(sent.length, 1);
  assert.equal(records.EmailLog.find((row) => row.Result === 'SUCCESS').EmailType, 'MEDICATION_RECEIVED');
  assert.equal(records.RequestLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'PENDING');
  const replay = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'reconcile-1');
  assert.equal(replay.Status, 'NOTIFIED');
  assert.equal(replay.replayed, true);
  assert.equal(sent.length, 1, 'terminal SUCCESS must never be delivered again');
  assert.equal(records.OrderChangeLog.filter((row) => row.ActionType === 'SEND_ORDER_EMAIL').length, 1);
});

test('every post-delivery finalization stage is idempotently resumable', () => {
  for (const failOnce of ['update:OrderHeaders', 'write:OrderChangeLog', 'write:AuditLog', 'complete:RequestLog']) {
    const { service, records, sent } = workflowSandbox({ failOnce });
    assert.throws(() => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, `finalize-${failOnce}`), /injected/);
    const replay = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, `finalize-${failOnce}`);
    assert.equal(replay.Status, 'NOTIFIED', failOnce);
    assert.equal(sent.length, 1, failOnce);
    assert.equal(records.OrderChangeLog.filter((row) => row.ActionType === 'SEND_ORDER_EMAIL').length, 1, failOnce);
    assert.equal(records.AuditLog.filter((row) => row.Action === 'SEND_ORDER_EMAIL').length, 1, failOnce);
    assert.equal(records.RequestLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'SUCCESS', failOnce);
  }
});

test('a delivery-log terminalization failure appends a terminal receipt and still finalizes without a resend', () => {
  const { service, records, sent } = workflowSandbox({ failOnce: 'update:EmailLog' });
  const result = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'terminal-receipt');
  assert.equal(result.Status, 'NOTIFIED');
  assert.equal(sent.length, 1);
  assert.equal(records.EmailLog.filter((row) => row.Result === 'SENDING').length, 1);
  assert.equal(records.EmailLog.filter((row) => row.Result === 'SUCCESS').length, 1);
  assert.equal(records.RequestLog.filter((row) => row.Action === 'EMAIL_SNAPSHOT').length, 2);
  assert.equal(service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'terminal-receipt').replayed, true);
  assert.equal(sent.length, 1);
});

test('a partially written header finalization is recognized as owned and safely completed on replay', () => {
  const { service, records, sent } = workflowSandbox({ failOnce: 'partial:update:OrderHeaders' });
  assert.throws(() => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'partial-header'), /partial:update:OrderHeaders/);
  assert.equal(records.OrderHeaders[0].Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].Version, 2);
  const replay = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'partial-header');
  assert.equal(replay.Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].LastChangeSetID, records.OrderChangeLog[0].ChangeSetID);
  assert.equal(sent.length, 1);
});

test('a terminal failed delivery is replayed without resend and remains eligible for an explicit successful retry', () => {
  const { service, records, sent } = workflowSandbox({ deliveryOutcomes: ['FAILED', 'SUCCESS'] });
  const failed = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'failed-terminal');
  assert.equal(failed.Status, 'RECEIVED');
  assert.equal(failed.retryEligible, true);
  assert.equal(records.OrderHeaders[0].NotificationStatus, 'FAILED');
  assert.equal(service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'failed-terminal').email.result, 'FAILED');
  assert.equal(sent.length, 1);
  const retried = service.resendFailedEmail_(admin, failed.email.emailLogId, 'retry-terminal');
  assert.equal(retried.Status, 'NOTIFIED');
  assert.equal(retried.email.result, 'SUCCESS');
  assert.equal(sent.length, 2);
});

test('the receiving notification uses the same durable finalizer and cannot be sent twice after success', () => {
  const { service, records, sent } = workflowSandbox();
  records.OrderHeaders[0].Status = 'ORDERED';
  records.OrderItems[0].ItemStatus = 'ORDERED';
  delete records.OrderItems[0].ReceivedQuantity;
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  const first = service.updateReceivedItems_(admin, payload, 'receive-notify');
  assert.equal(first.Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].Version, 3);
  assert.equal(sent.length, 1);
  const replay = service.updateReceivedItems_(admin, payload, 'receive-notify');
  assert.equal(replay.Status, 'NOTIFIED');
  assert.equal(replay.replayed, true);
  assert.equal(sent.length, 1);
});

test('receiving reserves under the business lock, claims under a second lock, and sends unlocked', () => {
  const { service, records, sent, events, mailLockDepths } = workflowSandbox();
  records.OrderHeaders[0].Status = 'ORDERED';
  records.OrderItems[0].ItemStatus = 'ORDERED';
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  service.updateReceivedItems_(admin, payload, 'atomic-prepare');
  const finalizer = events.indexOf('append:RequestLog:FINALIZE_RECEIVED_EMAIL');
  const attempt = events.indexOf('append:EmailLog:');
  const snapshot = events.indexOf('append:RequestLog:EMAIL_SNAPSHOT');
  const businessComplete = events.indexOf('composite:RequestLog:UPDATE_RECEIVED_ITEMS:SUCCESS');
  const firstUnlock = events.indexOf('unlock');
  const email = events.indexOf('email');
  const deliveryLock = events.indexOf('lock', firstUnlock + 1);
  const deliveryUnlock = events.indexOf('unlock', firstUnlock + 1);
  assert.ok(finalizer >= 0 && attempt > finalizer && snapshot > attempt);
  assert.ok(snapshot < businessComplete && businessComplete < firstUnlock);
  assert.ok(firstUnlock < deliveryLock && deliveryLock < deliveryUnlock && deliveryUnlock < email);
  assert.deepEqual(mailLockDepths, [0]);
  assert.equal(sent.length, 1);
});

test('receiving replay resumes a durably prepared attempt after a crash before delivery', () => {
  const pending = {
    OrderID: 'MED-1', Version: 2, Status: 'RECEIVED', EmailLogID: 'crash-attempt', ExpectedVersion: 2,
    FinalizeChangeSetID: 'email-change', EmailType: 'MEDICATION_RECEIVED', OriginalLastChangeSetID: 'receive-change',
    ChangeSetID: 'receive-change', replayed: false, deliveryPending: true,
  };
  const snapshot = {
    schemaVersion: 1, rootEmailLogId: 'crash-attempt', attemptEmailLogId: 'crash-attempt', templateName: 'MEDICATION_RECEIVED',
    header: { OrderID: 'MED-1', Department: 'ER', Status: 'RECEIVED', Version: 2, LastChangeSetID: 'receive-change', CreatedByStaffID: 'staff-1', HN: '07-01-000001', PatientName: 'Patient' },
    items: [{ OrderItemID: 'MED-1-01', OrderID: 'MED-1', GenericName: 'Medicine', RequestedQuantity: 2, Unit: 'TABLET', ItemStatus: 'RECEIVED', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }],
    actor: admin.user, changes: [], event: { actor: admin.user, occurredAt: '2026-07-19T00:00:00.000Z', orderVersion: 2, changes: [], items: [] }, actionLinks: {},
  };
  const { service, records, sent } = workflowSandbox({ records: {
    OrderHeaders: [{ ...snapshot.header }], OrderItems: snapshot.items,
    EmailLog: [{ EmailLogID: 'crash-attempt', OrderID: 'MED-1', ChangeSetID: 'receive-change', EmailType: 'MEDICATION_RECEIVED', Result: 'PENDING', RetryCount: 0, SentBy: 'admin-1' }],
    RequestLog: [
      { RequestID: 'crash-receive', Action: 'UPDATE_RECEIVED_ITEMS', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'TRANSACTION_FAILURE', ResponseData: JSON.stringify({ errorCode: 'TRANSACTION_FAILURE' }) },
      { RequestID: 'RECEIVED_EMAIL:crash-receive', Action: 'FINALIZE_RECEIVED_EMAIL', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'PENDING', ResponseData: JSON.stringify(pending) },
      { RequestID: 'crash-attempt', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) },
    ],
  } });
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  const recovered = service.updateReceivedItems_(admin, payload, 'crash-receive');
  assert.equal(recovered.Status, 'NOTIFIED');
  assert.equal(recovered.replayed, true);
  assert.equal(sent.length, 1);
  assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_RECEIVED_ITEMS').Result, 'SUCCESS');
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'SUCCESS');
  assert.equal(service.updateReceivedItems_(admin, payload, 'crash-receive').replayed, true);
  assert.equal(sent.length, 1);
});

test('receiving replay reconciles a terminal delivery after a finalization crash without resending', () => {
  const { service, records, sent } = workflowSandbox({ failOnce: 'write:OrderChangeLog' });
  records.OrderHeaders[0].Status = 'ORDERED';
  records.OrderItems[0].ItemStatus = 'ORDERED';
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  assert.throws(() => service.updateReceivedItems_(admin, payload, 'receive-finalize-crash'), /write:OrderChangeLog/);
  assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_RECEIVED_ITEMS').Result, 'SUCCESS');
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'PENDING');
  assert.equal(records.EmailLog.find((row) => row.EmailType === 'MEDICATION_RECEIVED').Result, 'SUCCESS');
  assert.equal(sent.length, 1);
  const recovered = service.updateReceivedItems_(admin, payload, 'receive-finalize-crash');
  assert.equal(recovered.Status, 'NOTIFIED');
  assert.equal(recovered.replayed, true);
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'SUCCESS');
  assert.equal(sent.length, 1);
});

test('external success with no terminal receipt stays SENDING and replay never resends', () => {
  const { service, records, sent, mailLockDepths } = workflowSandbox({ terminalLogUncertain: true });
  assert.throws(
    () => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'uncertain-send'),
    (error) => error && error.errorCode === 'EMAIL_DELIVERY_UNCERTAIN'
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(mailLockDepths, [0]);
  assert.equal(records.EmailLog[0].Result, 'SENDING');
  assert.throws(
    () => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'uncertain-send'),
    (error) => error && error.errorCode === 'EMAIL_DELIVERY_UNCERTAIN'
  );
  assert.equal(sent.length, 1);
});

test('a new send request is rejected before preparation while this order has a pending or uncertain delivery', () => {
  for (const state of ['PENDING', 'SENDING', 'UNCERTAIN']) {
    const { service, records, sent } = workflowSandbox({ records: {
      EmailLog: [{ EmailLogID: `inflight-${state}`, OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: state, RetryCount: 0 }],
    } });
    assert.throws(
      () => service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, `fresh-after-${state}`),
      (error) => error && error.errorCode === (state === 'PENDING' ? 'EMAIL_DELIVERY_PENDING' : 'EMAIL_DELIVERY_UNCERTAIN'),
    );
    assert.equal(records.EmailLog.length, 1, state);
    assert.equal(records.RequestLog.length, 0, state);
    assert.equal(sent.length, 0, state);
  }
});

test('a new resend request is rejected before preparation while this order has another pending delivery', () => {
  const snapshot = {
    schemaVersion: 1, rootEmailLogId: 'root-failed', attemptEmailLogId: 'failed-source', templateName: 'MEDICATION_RECEIVED',
    header: { OrderID: 'MED-1', Department: 'ER', Status: 'RECEIVED', Version: 1, LastChangeSetID: '' },
    event: { orderVersion: 1 }, changes: [], items: [],
  };
  const { service, records, sent } = workflowSandbox({ records: {
    EmailLog: [
      { EmailLogID: 'failed-source', OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: 'FAILED', RetryCount: 0 },
      { EmailLogID: 'other-pending', OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: 'PENDING', RetryCount: 0 },
    ],
    RequestLog: [
      { RequestID: 'failed-source', Action: 'EMAIL_SNAPSHOT', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot) },
      { RequestID: 'other-pending', Action: 'EMAIL_SNAPSHOT', Result: 'SUCCESS', ResponseData: JSON.stringify(Object.assign({}, snapshot, { attemptEmailLogId: 'other-pending' })) },
    ],
  } });
  assert.throws(() => service.resendFailedEmail_(admin, 'failed-source', 'fresh-resend'), (error) => error && error.errorCode === 'EMAIL_DELIVERY_PENDING');
  assert.equal(records.EmailLog.length, 2);
  assert.equal(sent.length, 0);
});

test('explicit send and resend recover every preparation write boundary without duplicate delivery', () => {
  for (const action of ['SEND', 'RESEND']) {
    for (const explicitPrepCrash of ['after_request', 'after_snapshot', 'after_attempt', 'before_claim']) {
      const sourceSnapshot = { schemaVersion: 1, rootEmailLogId: 'source-root', attemptEmailLogId: 'source-root', templateName: 'MEDICATION_RECEIVED', header: { OrderID: 'MED-1', Department: 'ER', CreatedByStaffID: 'staff-1', Version: 1, Status: 'RECEIVED' }, items: [], changes: [], event: { actor: { StaffID: 'admin-1' }, occurredAt: '2026-07-19T08:00:00.000Z', orderVersion: 1, changes: [], items: [] } };
      const extra = action === 'RESEND' ? { records: {
        EmailLog: [{ EmailLogID: 'source-root', OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: 'FAILED', RetryCount: 0 }],
        RequestLog: [{ RequestID: 'source-root', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'SUCCESS', ResponseData: JSON.stringify(sourceSnapshot) }],
      } } : {};
      const { service, records, sent } = workflowSandbox({ explicitPrepCrash, ...extra });
      const requestId = `${action.toLowerCase()}-${explicitPrepCrash}`;
      const invoke = () => action === 'SEND'
        ? service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, requestId)
        : service.resendFailedEmail_(admin, 'source-root', requestId);
      assert.throws(invoke, /injected explicit prep crash/, `${action}:${explicitPrepCrash}`);
      const recovered = invoke();
      assert.equal(recovered.email.result, 'SUCCESS', `${action}:${explicitPrepCrash}`);
      assert.equal(sent.length, 1, `${action}:${explicitPrepCrash}`);
      assert.equal(records.RequestLog.find((row) => row.Action === (action === 'SEND' ? 'SEND_ORDER_EMAIL' : 'RESEND_FAILED_EMAIL')).Result, 'SUCCESS');
      const attempts = records.EmailLog.filter((row) => row.EmailLogID !== 'source-root');
      assert.equal(attempts.length, 1, `${action}:${explicitPrepCrash}`);
    }
  }
});

test('partial receiving preparation is terminalized on replay without rolling back or sending', () => {
  const pending = { OrderID: 'MED-1', Version: 2, Status: 'RECEIVED', EmailLogID: 'partial-attempt', ExpectedVersion: 2, FinalizeChangeSetID: 'email-change', EmailType: 'MEDICATION_RECEIVED', OriginalLastChangeSetID: 'receive-change', ChangeSetID: 'receive-change', deliveryPending: true };
  const { service, records, sent } = workflowSandbox({ records: {
    OrderHeaders: [{ OrderID: 'MED-1', Department: 'ER', Status: 'RECEIVED', Version: 2, LastChangeSetID: 'receive-change', LastChangeType: 'UPDATE_RECEIVED_ITEMS', CreatedByStaffID: 'staff-1' }],
    OrderItems: [{ OrderItemID: 'MED-1-01', OrderID: 'MED-1', ItemStatus: 'RECEIVED', RequestedQuantity: 2, Unit: 'TABLET', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }],
    OrderChangeLog: [{ ChangeSetID: 'receive-change', OrderID: 'MED-1', ChangedByStaffID: 'admin-1', ActionType: 'UPDATE_RECEIVED_ITEMS', RequestID: 'partial-receive', OrderVersionAfter: 2 }],
    EmailLog: [{ EmailLogID: 'partial-attempt', OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: 'PENDING', RetryCount: 0 }],
    RequestLog: [
      { RequestID: 'partial-receive', Action: 'UPDATE_RECEIVED_ITEMS', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'TRANSACTION_FAILURE', ResponseData: '{}' },
      { RequestID: 'RECEIVED_EMAIL:partial-receive', Action: 'FINALIZE_RECEIVED_EMAIL', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'PENDING', ResponseData: JSON.stringify(pending) },
    ],
  } });
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  const replay = service.updateReceivedItems_(admin, payload, 'partial-receive');
  assert.equal(replay.finalizationOutcome, 'PREPARATION_FAILED');
  assert.equal(records.OrderHeaders[0].Status, 'RECEIVED');
  assert.equal(records.OrderHeaders[0].Version, 2);
  assert.equal(records.EmailLog[0].Result, 'FAILED');
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'SUCCESS');
  assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_RECEIVED_ITEMS').Result, 'SUCCESS');
  assert.equal(sent.length, 0);
});

test('receiving preparation failures preserve the business write and terminalize notification state', () => {
  for (const failOnce of ['prepare:EmailLog', 'prepare:EmailSnapshot']) {
    const { service, records, sent } = workflowSandbox({ failOnce });
    records.OrderHeaders[0].Status = 'ORDERED';
    records.OrderItems[0].ItemStatus = 'ORDERED';
    const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
    const result = service.updateReceivedItems_(admin, payload, `prepare-failure-${failOnce}`);
    assert.equal(result.NotificationPreparation, 'FAILED', failOnce);
    assert.equal(records.OrderHeaders[0].Status, 'RECEIVED', failOnce);
    assert.equal(records.OrderHeaders[0].Version, 2, failOnce);
    assert.equal(records.OrderItems[0].ItemStatus, 'RECEIVED', failOnce);
    assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_RECEIVED_ITEMS').Result, 'SUCCESS', failOnce);
    const finalizer = records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL');
    assert.ok(!finalizer || finalizer.Result === 'SUCCESS', failOnce);
    assert.equal(records.OrderHeaders[0].NotificationStatus, 'FAILED', failOnce);
    assert.equal(sent.length, 0, failOnce);
  }
});

test('receiving replay retries a transient preparation-failure completion until terminal', () => {
  const { service, records, sent } = workflowSandbox({ failOnce: 'prepare:EmailSnapshot', failPrepCompletionOnce: true });
  records.OrderHeaders[0].Status = 'ORDERED';
  records.OrderItems[0].ItemStatus = 'ORDERED';
  const payload = { OrderID: 'MED-1', expectedVersion: 1, Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', ReceivedDate: '2026-07-19', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }] };
  const first = service.updateReceivedItems_(admin, payload, 'prep-completion-retry');
  assert.equal(first.NotificationPreparation, 'FAILED');
  assert.equal(records.OrderHeaders[0].Status, 'RECEIVED');
  assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_RECEIVED_ITEMS').Result, 'SUCCESS');
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'PENDING');
  const replay = service.updateReceivedItems_(admin, payload, 'prep-completion-retry');
  assert.equal(replay.finalizationOutcome, 'PREPARATION_FAILED');
  assert.equal(records.RequestLog.find((row) => row.Action === 'FINALIZE_RECEIVED_EMAIL').Result, 'SUCCESS');
  assert.equal(sent.length, 0);
});

test('finalizer cleanup keeps the full composite identity when request IDs collide', () => {
  const requestId = 'RECEIVED_EMAIL:shared';
  const { service, records } = workflowSandbox({ records: { RequestLog: [
    { RequestID: requestId, Action: 'FINALIZE_RECEIVED_EMAIL', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'PENDING', ResponseData: '{}' },
    { RequestID: requestId, Action: 'FINALIZE_RECEIVED_EMAIL', OrderID: 'MED-2', StaffID: 'admin-2', Result: 'PENDING', ResponseData: '{}' },
  ] } });
  service.failReceivedFinalizerLocked_(admin, records.RequestLog[0], 'EMAIL_PREPARATION_FAILED');
  assert.equal(records.RequestLog[0].Result, 'TRANSACTION_FAILURE');
  assert.equal(records.RequestLog[1].Result, 'PENDING');
});

test('successful delivery with a legitimate concurrent order change terminalizes without overwriting or resending', () => {
  const { service, records, sent } = workflowSandbox({ concurrentAfterDelivery: true });
  const result = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'concurrent-success');
  assert.equal(result.email.result, 'SUCCESS');
  assert.equal(result.finalizationOutcome, 'DELIVERED_STATE_NOT_UPDATED');
  assert.equal(result.finalizationReason, 'CONCURRENT_STATE');
  assert.equal(result.Status, 'CANCEL_REQUESTED');
  assert.equal(records.OrderHeaders[0].NotificationStatus, 'CURRENT');
  assert.equal(records.RequestLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'SUCCESS');
  assert.equal(records.AuditLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'DELIVERED_STATE_NOT_UPDATED');
  assert.equal(service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'concurrent-success').replayed, true);
  assert.equal(sent.length, 1);
});

test('failed delivery with a legitimate concurrent order change terminalizes and preserves newer state', () => {
  const { service, records, sent } = workflowSandbox({ concurrentAfterDelivery: true, deliveryOutcomes: ['FAILED'] });
  const result = service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'concurrent-failed');
  assert.equal(result.email.result, 'FAILED');
  assert.equal(result.finalizationOutcome, 'DELIVERY_FAILED_STATE_NOT_UPDATED');
  assert.equal(result.finalizationReason, 'CONCURRENT_STATE');
  assert.equal(result.Status, 'CANCEL_REQUESTED');
  assert.equal(records.OrderHeaders[0].NotificationStatus, 'CURRENT');
  assert.equal(records.RequestLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'SUCCESS');
  assert.equal(records.AuditLog.find((row) => row.Action === 'SEND_ORDER_EMAIL').Result, 'DELIVERY_FAILED_STATE_NOT_UPDATED');
  assert.equal(service.sendOrderEmail_(admin, { OrderID: 'MED-1', expectedVersion: 1 }, 'concurrent-failed').replayed, true);
  assert.equal(sent.length, 1);
});

test('retry chains use root event identity rather than only order and email type', () => {
  const snapshot = (root, priority) => ({
    schemaVersion: 1, rootEmailLogId: root, templateName: 'ORDER_UPDATE',
    header: { OrderID: 'MED-1', Department: 'ER', CreatedByStaffID: 'staff-1', Version: 1 }, items: [],
    changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: priority }],
    event: { actor: { StaffID: 'staff-1' }, occurredAt: '2026-07-19T10:00:00.000Z', orderVersion: 1, changes: [{ field: 'Priority', oldValue: 'NORMAL', newValue: priority }], items: [] },
  });
  const { service, sent } = workflowSandbox({ records: {
    EmailLog: [
      { EmailLogID: 'root-a', OrderID: 'MED-1', ChangeSetID: '', EmailType: 'ORDER_UPDATE', Result: 'FAILED', RetryCount: 0 },
      { EmailLogID: 'root-b', OrderID: 'MED-1', ChangeSetID: '', EmailType: 'ORDER_UPDATE', Result: 'FAILED', RetryCount: 7 },
    ],
    RequestLog: [
      { RequestID: 'root-a', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'staff-1', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot('root-a', 'URGENT')) },
      { RequestID: 'root-b', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'staff-1', Result: 'SUCCESS', ResponseData: JSON.stringify(snapshot('root-b', 'CRITICAL')) },
    ],
  } });
  const result = service.resendFailedEmail_(admin, 'root-a', 'retry-root-a');
  assert.equal(result.email.result, 'SUCCESS');
  assert.match(sent[0].body, /URGENT/);
});

test('retry reads the exact original snapshot, re-resolves managed recipients, and finalizes medication received', () => {
  const original = {
    schemaVersion: 1, rootEmailLogId: 'root-received', templateName: 'MEDICATION_RECEIVED',
    header: { OrderID: 'MED-1', Department: 'ER', CreatedByStaffID: 'staff-1', Version: 1, Status: 'RECEIVED' },
    items: [{ GenericName: 'Original Medicine', ItemStatus: 'RECEIVED', ReceivedQuantity: 2, ReceivedUnit: 'TABLET' }],
    changes: [{ field: 'Status', oldValue: 'ORDERED', newValue: 'RECEIVED' }],
    event: { actor: { StaffID: 'original-admin', FullName: 'Original Admin' }, occurredAt: '2026-07-19T08:00:00.000Z', orderVersion: 1, changes: [{ field: 'Status', oldValue: 'ORDERED', newValue: 'RECEIVED' }], items: [{ GenericName: 'Original Medicine' }] },
  };
  const { service, records, sent } = workflowSandbox({ records: {
    EmailLog: [{ EmailLogID: 'root-received', OrderID: 'MED-1', ChangeSetID: 'receive-event-1', EmailType: 'MEDICATION_RECEIVED', Recipient: 'stale@example.invalid', Result: 'FAILED', RetryCount: 0 }],
    RequestLog: [{ RequestID: 'root-received', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'original-admin', Result: 'SUCCESS', ResponseData: JSON.stringify(original) }],
  } });
  records.OrderItems[0].GenericName = 'Mutated Current Medicine';
  const result = service.resendFailedEmail_(admin, 'root-received', 'retry-received');
  assert.equal(result.email.result, 'SUCCESS');
  assert.equal(result.Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].Status, 'NOTIFIED');
  assert.equal(records.OrderHeaders[0].NotificationStatus, 'SUCCESS');
  assert.equal(sent[0].to, 'current@example.invalid');
  assert.match(sent[0].body, /Original Medicine/);
  assert.doesNotMatch(sent[0].body, /Mutated Current Medicine/);
});

test('retry rejects a stale medication event after cancellation without a delivery call', () => {
  const original = { schemaVersion: 1, rootEmailLogId: 'stale-root', templateName: 'MEDICATION_RECEIVED', header: { OrderID: 'MED-1', Department: 'ER', CreatedByStaffID: 'staff-1', Version: 1, Status: 'RECEIVED' }, items: [], changes: [], event: { actor: { StaffID: 'admin-1' }, occurredAt: '2026-07-19T08:00:00.000Z', orderVersion: 1, changes: [], items: [] } };
  const { service, records, sent } = workflowSandbox({ records: {
    EmailLog: [{ EmailLogID: 'stale-root', OrderID: 'MED-1', EmailType: 'MEDICATION_RECEIVED', Result: 'FAILED', RetryCount: 0 }],
    RequestLog: [{ RequestID: 'stale-root', Action: 'EMAIL_SNAPSHOT', OrderID: 'MED-1', StaffID: 'admin-1', Result: 'SUCCESS', ResponseData: JSON.stringify(original) }],
  } });
  Object.assign(records.OrderHeaders[0], { Status: 'CANCEL_REQUESTED', Version: 2, LastChangeSetID: 'cancel-change' });
  assert.throws(() => service.resendFailedEmail_(admin, 'stale-root', 'stale-retry'), (error) => error && error.errorCode === 'EMAIL_RETRY_STALE');
  assert.equal(sent.length, 0);
  assert.equal(records.EmailLog.length, 1);
});
