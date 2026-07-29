const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const cancellationApprovalKey = ['CANCELLATION_REQUIRES_ADMIN', 'APPROVAL'].join('_');

function source(path) { return fs.readFileSync(path, 'utf8'); }

function ApiError(errorCode, safeMessage, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage;
  this.errors = errors;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function updateSandbox(options = {}) {
  const header = {
    OrderID: 'MED-20260719-0001', Department: 'ER', Status: 'SUBMITTED', Version: 1,
    HN: '07-01-000001', PatientName: 'Ada', WardClinic: 'ER', RequiredDate: '2026-07-20', Priority: 'NORMAL',
    RequesterPhone: '', ItemCount: 1, AppointmentSequence: 0, RequesterEmail: 'staff@example.invalid',
  };
  const item = {
    OrderItemID: 'MED-20260719-0001-01', OrderID: header.OrderID, ItemNo: 1,
    GenericName: 'Amoxicillin', BrandName: '', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 2,
    Unit: 'TABLET', Prescriber: 'Dr Test', ItemStatus: 'SUBMITTED', Active: 'TRUE',
  };
  const records = {
    OrderHeaders: [header], OrderItems: [item], OrderChangeLog: [], AuditLog: [], RequestLog: [],
    AppointmentResponseLog: [], AppointmentReminderLog: [], EmailLog: [],
    ActionTokens: [
      { TokenID: 'ATK-1', OrderID: header.OrderID, AppointmentSequence: 1, ActionType: 'RECEIVED', Status: 'ACTIVE', UsedAt: '', UsedBy: '' },
      { TokenID: 'ATK-2', OrderID: header.OrderID, AppointmentSequence: 1, ActionType: 'RESCHEDULE', Status: 'ACTIVE', UsedAt: '', UsedBy: '' },
    ],
    ...(options.records || {}),
  };
  const events = [];
  let notificationFailureUsed = false;
  const businessCommitted = () => records.RequestLog.some((row) => row.Result === 'SUCCESS');
  const failNotification = (stage) => !runtime.notificationFailureDisabled && !notificationFailureUsed && options.failNotificationStage === stage && businessCommitted();
  const runtime = {
    ApiError_: ApiError, Array, Date, JSON, Math, Number, Object, RegExp, String, isFinite,
    sha256Hex_: (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'),
    Utilities: { getUuid: (() => { let id = 0; return () => `uuid-${++id}`; })() },
    getSetting_: (key, fallback) => {
      if (options.failNotificationSetting === key) throw new Error('injected notification setting failure');
      return Object.prototype.hasOwnProperty.call(options.settings || {}, key) ? options.settings[key] : fallback;
    },
    getMasterData_: () => ({ DOSAGE_FORM: [{ Code: 'TABLET' }], UNIT: [{ Code: 'TABLET' }], PRIORITY: [{ Code: 'NORMAL' }], CANCEL_REASON: [{ Code: 'PATIENT_CANCELLED' }, { Code: 'OTHER' }] }),
    readRecords_: (name, query = {}) => {
      if (name === 'RequestLog' && options.failFinalizerRequestRead && businessCommitted()) {
        throw new Error('injected post-commit RequestLog read failure');
      }
      if (name === 'EmailLog' && failNotification('claim-read') && (records.EmailLog || []).some((row) => row.Result === 'PENDING')) {
        notificationFailureUsed = true;
        throw new Error('injected notification claim read failure');
      }
      const rows = records[name] || [];
      const filtered = query.predicate ? rows.filter(query.predicate) : rows.slice();
      return query.limit == null ? filtered.map(clone) : filtered.slice(0, query.limit).map(clone);
    },
    appendRecords_: (name, rows) => {
      events.push(`append:${name}`);
      if (name === 'EmailLog' && failNotification('terminalization') && (records.EmailLog || []).length > 0) {
        notificationFailureUsed = true;
        throw new Error('injected notification terminal append failure');
      }
      if (options.failAt === `append:${name}`) throw new Error(`injected ${name} append failure`);
      const target = records[name] || (records[name] = []);
      rows.forEach((row) => target.push(clone(row)));
      return { startRow: target.length - rows.length + 2, rowCount: rows.length };
    },
    updateRecordByKey_: (name, key, value, updates) => {
      events.push(`update:${name}`);
      if (name === 'EmailLog' && updates.Result === 'SENDING' && failNotification('claim-update')) {
        notificationFailureUsed = true;
        throw new Error('injected notification claim update failure');
      }
      if (name === 'EmailLog' && ['SUCCESS', 'FAILED'].includes(String(updates.Result || '')) && failNotification('terminalization')) {
        throw new Error('injected notification terminal update failure');
      }
      if (options.failAt === `update:${name}`) throw new Error(`injected ${name} update failure`);
      const row = (records[name] || []).find((record) => String(record[key]) === String(value));
      if (!row) return null;
      Object.assign(row, clone(updates));
      return clone(row);
    },
    updateRecordByCompositeKey_: (name, keys, updates) => {
      events.push(`composite:${name}`);
      if (options.failAt === `composite:${name}`) throw new Error(`injected ${name} composite failure`);
      const matches = (records[name] || []).filter((row) => Object.entries(keys).every(([key, value]) => String(row[key] || '') === String(value || '')));
      if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
      Object.assign(matches[0], clone(updates));
      return clone(matches[0]);
    },
    batchUpdateRecordsByKeys_: (name, key, updates) => {
      events.push(`batch:${name}`);
      if (options.failAt === `batch:${name}`) throw new Error(`injected ${name} batch failure`);
      updates.forEach((entry) => runtime.updateRecordByKey_(name, key, entry.keyValue, entry.updates));
    },
    requireOrderAccess_: (context, order) => {
      if (!context || !context.user || (context.user.Role !== 'ADMIN' && String(context.user.Department) !== String(order.Department))) throw new ApiError('ACCESS_DENIED', 'Access denied.');
      return order;
    },
    LockService: { getScriptLock: () => ({
      waitLock: () => {
        if (failNotification('lock')) { notificationFailureUsed = true; throw new Error('injected notification lock failure'); }
        events.push('lock');
      },
      releaseLock: () => events.push('unlock'),
    }) },
    CacheService: { getScriptCache: () => ({ remove: (key) => events.push(`cache:${key}`) }) },
    MailApp: { sendEmail: (message) => {
      runtime.lastEmail = message;
      events.push('email');
      if (failNotification('send')) { notificationFailureUsed = true; throw new Error('injected notification send failure'); }
    } },
  };
  const files = ['backend/OrderItemService.gs', 'backend/AuditService.gs', 'backend/ChangeLogService.gs', 'backend/EmailService.gs', 'backend/ActionTokenService.gs', 'backend/OrderService.gs'];
  const service = vm.runInNewContext(`${files.map(source).join('\n')}\n({ updateOrderByStaff_, cancelOrderByStaff_, decideCancellationByAdmin_, getOrderChangeLog_, getAppointmentHistory_, isReminderEligibleForOrder_, finalizePostCommitNoticeSafe_ });`, runtime);
  return { service, records, events, runtime };
}

const staff = { user: { StaffID: '00123', FullName: 'Ada Staff', Department: 'ER', Email: 'staff@example.invalid', Role: 'STAFF' } };
const foreignStaff = { user: { StaffID: '00456', FullName: 'Other Staff', Department: 'ICU', Role: 'STAFF' } };
const admin = { user: { StaffID: '00999', FullName: 'Admin User', Department: 'PHARMACY', Email: 'admin@example.invalid', Role: 'ADMIN' } };

function updatePayload(overrides = {}) {
  return {
    OrderID: 'MED-20260719-0001', expectedVersion: 1, PatientName: 'Grace',
    Items: [{ OrderItemID: 'MED-20260719-0001-01', GenericName: 'Amoxicillin', BrandName: '', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 3, Unit: 'TABLET', Prescriber: 'Dr Test' }],
    ...overrides,
  };
}

test('staff update checks the latest exact version, persists only allowed diffs, and emits immutable history', () => {
  const { service, records, events } = updateSandbox();
  const result = service.updateOrderByStaff_(staff, updatePayload(), 'update-1');
  assert.equal(result.Version, 2);
  assert.equal(records.OrderHeaders[0].PatientName, 'Grace');
  assert.equal(records.OrderHeaders[0].Version, 2);
  assert.equal(records.OrderItems[0].RequestedQuantity, 3);
  assert.deepEqual(records.OrderChangeLog.map((row) => row.FieldName), ['PatientName', 'RequestedQuantity']);
  assert.equal(records.AuditLog.filter((row) => row.Action === 'UPDATE_ORDER').length, 1);
  assert.ok(events.indexOf('unlock') < events.indexOf('email'), 'email delivery must not run while the lock is held');
  assert.throws(() => service.updateOrderByStaff_(staff, updatePayload({ expectedVersion: 1, PatientName: 'Later' }), 'update-stale'), (error) => error.errorCode === 'ORDER_VERSION_CONFLICT');
});

test('header-only edits compare persisted items but never validate them as client input', () => {
  const { service, records } = updateSandbox();
  const result = service.updateOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, PatientName: 'Header Only' }, 'header-only');
  assert.equal(result.Version, 2);
  assert.equal(records.OrderHeaders[0].PatientName, 'Header Only');
  assert.equal(records.OrderItems[0].RequestedQuantity, 2);
});

test('staff update rejects server-owned fields, submitted item removal, invalid status, and foreign departments', () => {
  const { service } = updateSandbox();
  assert.throws(() => service.updateOrderByStaff_(staff, updatePayload({ Department: 'ICU' }), 'bad-field'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.updateOrderByStaff_(staff, updatePayload({ Status: 'CANCELLED' }), 'bad-status'), (error) => error.errorCode === 'INVALID_STATUS_TRANSITION');
  assert.throws(() => service.updateOrderByStaff_(staff, updatePayload({ Items: [] }), 'drop-submitted'), (error) => error.errorCode === 'VALIDATION_ERROR' && /cannot be removed/.test(error.safeMessage));
  assert.throws(() => service.updateOrderByStaff_(foreignStaff, updatePayload(), 'foreign'), (error) => error.errorCode === 'ACCESS_DENIED');
});

test('staff update assigns stable IDs to new medication rows and replays a completed request', () => {
  const { service, records, events } = updateSandbox();
  const payload = updatePayload({ Items: [updatePayload().Items[0], { GenericName: 'Paracetamol', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 1, Unit: 'TABLET', Prescriber: 'Dr Test' }] });
  const first = service.updateOrderByStaff_(staff, payload, 'new-item');
  const locks = events.filter((event) => event === 'lock').length;
  const replay = service.updateOrderByStaff_(staff, payload, 'new-item');
  assert.equal(first.Version, 2);
  assert.equal(replay.replayed, true);
  assert.equal(events.filter((event) => event === 'lock').length, locks);
  assert.equal(records.OrderItems[1].OrderItemID, 'MED-20260719-0001-02');
  assert.equal(records.OrderItems[1].ItemNo, 2);
});

test('cancellation requires a valid reason, preserves all rows, applies policy, and excludes reminders', () => {
  const requested = updateSandbox({ settings: { [cancellationApprovalKey]: 'TRUE' } });
  assert.throws(() => requested.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1 }, 'cancel-missing'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => requested.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'OTHER' }, 'cancel-other'), (error) => error.errorCode === 'VALIDATION_ERROR');
  const result = requested.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'OTHER', ReasonDetail: 'Clinical change' }, 'cancel-request');
  assert.equal(result.Status, 'CANCEL_REQUESTED');
  assert.equal(requested.records.OrderItems.length, 1, 'cancellation must never delete items');
  assert.equal(requested.records.OrderHeaders[0].CancelReason, 'OTHER');
  assert.equal(requested.records.OrderHeaders[0].LastChangeReason, 'OTHER');
  assert.equal(requested.records.OrderHeaders[0].CancellationPreviousStatus, 'SUBMITTED');
  assert.equal(requested.records.OrderItems[0].CancellationPreviousStatus, 'SUBMITTED');
  assert.equal(requested.records.OrderItems[0].ItemStatus, 'CANCEL_REQUESTED');
  assert.equal(requested.records.ActionTokens.every((row) => row.Status === 'REVOKED'), true);
  assert.ok(requested.events.indexOf('update:ActionTokens') < requested.events.indexOf('unlock'));
  assert.equal(JSON.parse(requested.records.OrderChangeLog[0].OldValue), 'SUBMITTED');
  assert.equal(requested.service.isReminderEligibleForOrder_(requested.records.OrderHeaders[0]), false);
  assert.ok(requested.events.indexOf('unlock') < requested.events.indexOf('email'));

  const direct = updateSandbox({ settings: { [cancellationApprovalKey]: 'FALSE' } });
  assert.equal(direct.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'cancel-direct').Status, 'CANCELLED');
  assert.equal(direct.records.OrderItems[0].ItemStatus, 'CANCELLED');
  assert.equal(direct.records.ActionTokens.every((row) => row.Status === 'REVOKED'), true);
});

test('staff cancellation request IDs cannot replay a different reason payload', () => {
  const sandbox = updateSandbox();
  const original = { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'OTHER', ReasonDetail: 'private clinical detail' };
  sandbox.service.cancelOrderByStaff_(staff, original, 'cancel-bound-request');
  const stored = JSON.parse(sandbox.records.RequestLog.find((row) => row.Action === 'CANCEL_ORDER').ResponseData);
  assert.doesNotMatch(stored.requestSignature, /private clinical detail/);
  assert.match(stored.requestSignature, /^[a-f0-9]{64}$/);
  assert.throws(
    () => sandbox.service.cancelOrderByStaff_(staff, { ...original, ReasonCode: 'PATIENT_CANCELLED', ReasonDetail: '' }, 'cancel-bound-request'),
    (error) => error.errorCode === 'REQUEST_REPLAY',
  );
});

test('ADMIN approval is versioned, idempotent, audited, history-preserving, and terminalizes every item', () => {
  const sandbox = updateSandbox({ settings: { [cancellationApprovalKey]: 'TRUE' } });
  sandbox.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'cancel-for-approval');
  const payload = { OrderID: 'MED-20260719-0001', expectedVersion: 2, decision: 'APPROVE', decisionReason: 'Policy confirmed' };
  const result = sandbox.service.decideCancellationByAdmin_(admin, payload, 'approve-cancel-1');
  const replay = sandbox.service.decideCancellationByAdmin_(admin, payload, 'approve-cancel-1');
  assert.equal(result.Status, 'CANCELLED');
  assert.equal(result.Version, 3);
  assert.equal(replay.replayed, true);
  assert.equal(sandbox.records.OrderHeaders[0].CancellationDecision, 'APPROVED');
  assert.equal(sandbox.records.OrderHeaders[0].CancellationDecisionBy, '00999');
  assert.equal(sandbox.records.OrderHeaders[0].CancellationDecisionReason, 'Policy confirmed');
  assert.equal(sandbox.records.OrderItems[0].ItemStatus, 'CANCELLED');
  assert.equal(sandbox.records.ActionTokens.every((row) => row.Status === 'REVOKED'), true);
  assert.equal(sandbox.records.AuditLog.some((row) => row.Action === 'DECIDE_CANCELLATION' && row.Result === 'SUCCESS'), true);
  assert.equal(sandbox.records.OrderChangeLog.some((row) => row.ActionType === 'DECIDE_CANCELLATION' && row.FieldName === 'Status'), true);
  assert.throws(
    () => sandbox.service.decideCancellationByAdmin_(admin, { ...payload, expectedVersion: 1 }, 'approve-stale'),
    (error) => error.errorCode === 'ORDER_VERSION_CONFLICT',
  );
});

test('cancellation request IDs are bound to the normalized decision payload', () => {
  const sandbox = updateSandbox({ settings: { [cancellationApprovalKey]: 'TRUE' } });
  sandbox.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'cancel-for-bound-decision');
  const original = { OrderID: 'MED-20260719-0001', expectedVersion: 2, decision: 'REJECT', decisionReason: 'Awaiting medicine' };
  sandbox.service.decideCancellationByAdmin_(admin, original, 'decision-bound-request');
  const stored = JSON.parse(sandbox.records.RequestLog.find((row) => row.Action === 'DECIDE_CANCELLATION').ResponseData);
  assert.doesNotMatch(stored.requestSignature, /Awaiting medicine/);
  assert.match(stored.requestSignature, /^[a-f0-9]{64}$/);
  assert.throws(
    () => sandbox.service.decideCancellationByAdmin_(admin, { ...original, decision: 'APPROVE', decisionReason: 'Changed after retry' }, 'decision-bound-request'),
    (error) => error.errorCode === 'REQUEST_REPLAY',
  );
});

test('legacy cancellation RequestLog rows without signatures retain stored replay behavior', () => {
  const sandbox = updateSandbox({ records: {
    RequestLog: [{
      RequestID: 'legacy-cancel', Action: 'CANCEL_ORDER', OrderID: 'MED-20260719-0001', StaffID: '00123',
      CreatedAt: '2026-07-20T00:00:00.000Z', Result: 'SUCCESS',
      ResponseData: JSON.stringify({ OrderID: 'MED-20260719-0001', Version: 2, Status: 'CANCELLED' }),
    }],
  } });
  const replay = sandbox.service.cancelOrderByStaff_(
    staff,
    { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' },
    'legacy-cancel',
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.Status, 'CANCELLED');
});

test('ADMIN rejection restores the exact persisted header/item states and only cancellation-owned live tokens', () => {
  const sandbox = updateSandbox({
    settings: { [cancellationApprovalKey]: 'TRUE' },
    records: {
      OrderHeaders: [{
        OrderID: 'MED-20260719-0001', Department: 'ER', Status: 'NOTIFIED', Version: 1,
        HN: '07-01-000001', PatientName: 'Ada', RequesterEmail: 'staff@example.invalid', ItemCount: 1,
      }],
      OrderItems: [{
        OrderItemID: 'MED-20260719-0001-01', OrderID: 'MED-20260719-0001', ItemNo: 1,
        GenericName: 'Amoxicillin', DosageForm: 'TABLET', RequestedQuantity: 2, Unit: 'TABLET',
        Prescriber: 'Dr Test', ItemStatus: 'RECEIVED', Active: 'TRUE',
      }],
      ActionTokens: [{
        TokenID: 'ATK-1', OrderID: 'MED-20260719-0001', Status: 'ACTIVE',
        ExpiresAt: '2030-01-01T00:00:00.000Z', UsedAt: '', UsedBy: '',
      }, {
        TokenID: 'ATK-invalid-expiry', OrderID: 'MED-20260719-0001', Status: 'ACTIVE',
        ExpiresAt: 'not-an-expiry', UsedAt: '', UsedBy: '',
      }],
    },
  });
  sandbox.service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'cancel-for-rejection');
  const result = sandbox.service.decideCancellationByAdmin_(admin, {
    OrderID: 'MED-20260719-0001', expectedVersion: 2, decision: 'REJECT', decisionReason: 'Medicine already available',
  }, 'reject-cancel-1');
  assert.equal(result.Status, 'NOTIFIED');
  assert.equal(sandbox.records.OrderHeaders[0].CancellationDecision, 'REJECTED');
  assert.equal(sandbox.records.OrderItems[0].ItemStatus, 'RECEIVED');
  assert.equal(sandbox.records.ActionTokens[0].Status, 'ACTIVE');
  assert.equal(sandbox.records.ActionTokens[0].CancellationRequestID, 'cancel-for-rejection');
  assert.equal(sandbox.records.ActionTokens[1].Status, 'EXPIRED', 'invalid expiry metadata must fail closed');
  assert.deepEqual(
    sandbox.records.OrderChangeLog
      .filter((row) => row.ActionType === 'DECIDE_CANCELLATION' && row.FieldName === 'Status')
      .map((row) => [JSON.parse(row.OldValue), JSON.parse(row.NewValue)]),
    [['CANCEL_REQUESTED', 'CANCEL_REJECTED'], ['CANCEL_REJECTED', 'NOTIFIED']],
    'history must preserve both declared cancellation state transitions',
  );
  assert.throws(
    () => sandbox.service.decideCancellationByAdmin_(staff, {
      OrderID: 'MED-20260719-0001', expectedVersion: 3, decision: 'APPROVE',
    }, 'staff-cannot-decide'),
    (error) => error.errorCode === 'ACCESS_DENIED',
  );
});

test('OTHER cancellation detail is bounded before acquiring a lock', () => {
  const { service, events } = updateSandbox();
  assert.throws(
    () => service.cancelOrderByStaff_(staff, {
      OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'OTHER', ReasonDetail: 'x'.repeat(1001),
    }, 'cancel-detail-too-long'),
    (error) => error.errorCode === 'VALIDATION_ERROR' && error.errors.some((entry) => entry.field === 'ReasonDetail'),
  );
  assert.equal(events.includes('lock'), false);
});

test('cancellation uses transition authority and does not mark a pending request as cancelled', () => {
  const { service, records } = updateSandbox({ records: { OrderHeaders: [{
    OrderID: 'MED-20260719-0001', Department: 'ER', Status: 'NOTIFIED', Version: 1, RequesterEmail: 'staff@example.invalid', ItemCount: 1,
  }] } });
  const result = service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'pending-transition');
  assert.equal(result.Status, 'CANCEL_REQUESTED');
  assert.equal(records.OrderHeaders[0].CancelledAt, undefined);
  assert.equal(records.OrderHeaders[0].CancelledBy, undefined);
});

test('mutation emails contain masked patient information and actual diff/status content after cache invalidation', () => {
  const { service, events, runtime } = updateSandbox();
  service.updateOrderByStaff_(staff, updatePayload(), 'email-content');
  assert.ok(events.some((event) => event.startsWith('cache:')), 'dashboard cache was not invalidated');
  assert.equal(runtime.lastEmail.subject, '[Medication Reservation Updated] Order ID: MED-20260719-0001');
  assert.match(runtime.lastEmail.body, /PatientName/);
  assert.match(runtime.lastEmail.htmlBody, /Version/);
  assert.doesNotMatch(runtime.lastEmail.body, /PatientName: Ada/);
});

test('cancellation email uses the exact subject and required plain/HTML labels', () => {
  const { service, runtime } = updateSandbox();
  service.cancelOrderByStaff_(staff, { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' }, 'cancel-email');
  assert.equal(runtime.lastEmail.subject, '[Medication Reservation Cancelled] Order ID: MED-20260719-0001');
  for (const label of ['Department:', 'Patient:', 'Previous status:', 'New status:', 'Cancel reason:', 'Cancelled by:', 'Cancelled at:']) assert.match(runtime.lastEmail.body, new RegExp(label));
  assert.doesNotMatch(runtime.lastEmail.body, /Actor:/);
  assert.doesNotMatch(runtime.lastEmail.htmlBody, /Actor:/);
  assert.match(runtime.lastEmail.htmlBody, /Previous status:/);
});

test('disabled notifications and email-log failures are independently recorded without reversing an update', () => {
  const disabled = updateSandbox({ settings: { UPDATE_EMAIL_ENABLED: 'FALSE' } });
  assert.equal(disabled.service.updateOrderByStaff_(staff, updatePayload(), 'email-disabled').Version, 2);
  assert.equal(disabled.records.EmailLog[0].Result, 'SKIPPED_DISABLED');
  assert.equal(disabled.events.includes('email'), false);

  const loggingFailure = updateSandbox({ failAt: 'append:EmailLog' });
  assert.equal(loggingFailure.service.updateOrderByStaff_(staff, updatePayload(), 'email-log-failure').Version, 2);
  assert.equal(loggingFailure.records.AuditLog.at(-1).Action, 'EMAIL_LOG');
  assert.equal(loggingFailure.records.AuditLog.at(-1).Result, 'FAILURE');

  const settingFailure = updateSandbox({ failNotificationSetting: 'UPDATE_EMAIL_ENABLED' });
  assert.equal(settingFailure.service.updateOrderByStaff_(staff, updatePayload(), 'email-setting-failure').Version, 2);
  assert.equal(settingFailure.records.OrderHeaders[0].Version, 2);
  assert.equal(settingFailure.events.includes('email'), false, 'an unavailable notification policy must fail closed');
});

test('every post-commit notification stage preserves business success and replay reconciles without duplicate delivery', () => {
  for (const stage of ['lock', 'claim-read', 'claim-update', 'send', 'terminalization']) {
    const { service, records, events, runtime } = updateSandbox({ failNotificationStage: stage });
    const first = service.updateOrderByStaff_(staff, updatePayload(), `post-commit-${stage}`);
    assert.equal(first.Version, 2, stage);
    assert.equal(records.OrderHeaders[0].Version, 2, stage);
    const business = records.RequestLog.find((row) => row.Action === 'UPDATE_ORDER');
    assert.equal(business.Result, 'SUCCESS', stage);
    assert.ok(JSON.parse(business.ResponseData).postCommitNotification, `${stage} must retain a durable notification job`);
    runtime.notificationFailureDisabled = true;
    const replay = service.updateOrderByStaff_(staff, updatePayload(), `post-commit-${stage}`);
    assert.equal(replay.replayed, true, stage);
    const sends = events.filter((event) => event === 'email').length;
    assert.equal(sends <= 1, true, `${stage} must never send twice`);
    if (['lock', 'claim-read', 'claim-update'].includes(stage)) assert.equal(sends, 1, `${stage} must reconcile the unsent job`);
  }
});

test('post-commit RequestLog lookup failure cannot turn committed business success into an API error', () => {
  const { service, records } = updateSandbox({ failFinalizerRequestRead: true });
  const result = service.updateOrderByStaff_(staff, updatePayload(), 'post-commit-request-read');
  assert.equal(result.Version, 2);
  assert.equal(records.OrderHeaders[0].Version, 2);
  assert.equal(records.RequestLog.find((row) => row.Action === 'UPDATE_ORDER').Result, 'SUCCESS');
});

test('a stale finalizer cannot overwrite a terminal RequestLog outcome with UNCERTAIN', () => {
  const sandbox = updateSandbox();
  sandbox.service.updateOrderByStaff_(staff, updatePayload(), 'terminal-request-race');
  const entry = sandbox.records.RequestLog.find((row) => row.Action === 'UPDATE_ORDER');
  const terminal = JSON.parse(entry.ResponseData);
  assert.equal(terminal.postCommitNotification.status, 'TERMINAL');
  const staleEntry = clone(entry);
  const stale = JSON.parse(staleEntry.ResponseData);
  stale.postCommitNotification.status = 'PENDING';
  stale.postCommitNotification.outcome = null;
  staleEntry.ResponseData = JSON.stringify(stale);
  sandbox.records.EmailLog[0].Result = 'SENDING';
  sandbox.service.finalizePostCommitNoticeSafe_(staff, staleEntry);
  assert.equal(JSON.parse(entry.ResponseData).postCommitNotification.status, 'TERMINAL');
  assert.equal(JSON.parse(entry.ResponseData).postCommitNotification.outcome.result, 'SUCCESS');
});

test('a definitive EmailLog result upgrades an earlier UNCERTAIN RequestLog outcome', () => {
  for (const result of ['SUCCESS', 'FAILED']) {
    const sandbox = updateSandbox();
    sandbox.service.updateOrderByStaff_(staff, updatePayload(), `uncertain-upgrade-${result}`);
    const entry = sandbox.records.RequestLog.find((row) => row.Action === 'UPDATE_ORDER');
    const response = JSON.parse(entry.ResponseData);
    response.postCommitNotification.status = 'UNCERTAIN';
    response.postCommitNotification.outcome = {
      result: 'UNCERTAIN', errorMessage: 'EMAIL_DELIVERY_UNCERTAIN',
      emailLogId: response.postCommitNotification.emailLogId,
    };
    entry.ResponseData = JSON.stringify(response);
    Object.assign(sandbox.records.EmailLog[0], { Result: result, ErrorMessage: result === 'FAILED' ? 'EMAIL_DELIVERY_FAILED' : '' });
    sandbox.service.finalizePostCommitNoticeSafe_(staff, clone(entry));
    const upgraded = JSON.parse(entry.ResponseData).postCommitNotification;
    assert.equal(upgraded.status, 'TERMINAL', result);
    assert.equal(upgraded.outcome.result, result);
  }
});

test('cancellation uses the same durable post-commit finalizer and never becomes an API failure', () => {
  const { service, records, runtime } = updateSandbox({ failNotificationStage: 'claim-read' });
  const payload = { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' };
  assert.equal(service.cancelOrderByStaff_(staff, payload, 'cancel-post-commit').Status, 'CANCELLED');
  assert.ok(JSON.parse(records.RequestLog.find((row) => row.Action === 'CANCEL_ORDER').ResponseData).postCommitNotification);
  runtime.notificationFailureDisabled = true;
  assert.equal(service.cancelOrderByStaff_(staff, payload, 'cancel-post-commit').replayed, true);
});

test('every injected update write-stage failure leaves a terminal replay and restores the owned header version', () => {
  for (const failAt of ['update:OrderHeaders', 'batch:OrderItems', 'append:OrderChangeLog', 'append:AuditLog', 'composite:RequestLog']) {
    const { service, records } = updateSandbox({ failAt });
    assert.throws(() => service.updateOrderByStaff_(staff, updatePayload(), `failure-${failAt}`), /injected/);
    assert.equal(records.OrderHeaders[0].Version, 1, failAt);
    assert.equal(records.RequestLog.length, 1, failAt);
    assert.equal(records.RequestLog[0].Result, 'TRANSACTION_FAILURE', failAt);
    if (failAt === 'composite:RequestLog') {
      const rollback = records.OrderChangeLog.find((row) => row.Result === 'ROLLED_BACK');
      assert.ok(rollback, 'rollback history must be explicit');
      assert.equal(rollback.OrderVersionBefore, 2);
      assert.equal(rollback.OrderVersionAfter, 1);
    }
    assert.throws(() => service.updateOrderByStaff_(staff, updatePayload(), `failure-${failAt}`), (error) => error.errorCode === 'REQUEST_REPLAY', failAt);
  }
});

test('an injected cancellation write failure leaves a terminal replay rather than a version conflict', () => {
  const { service, records } = updateSandbox({ failAt: 'update:OrderHeaders' });
  const payload = { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' };
  assert.throws(() => service.cancelOrderByStaff_(staff, payload, 'cancel-failure'), /injected/);
  assert.equal(records.OrderHeaders[0].Version, 1);
  assert.equal(records.RequestLog[0].Result, 'TRANSACTION_FAILURE');
  assert.match(JSON.parse(records.RequestLog[0].ResponseData).requestSignature, /^[a-f0-9]{64}$/);
  assert.throws(() => service.cancelOrderByStaff_(staff, payload, 'cancel-failure'), (error) => error.errorCode === 'REQUEST_REPLAY');
});

test('a later cancellation failure restores the owned active action tokens', () => {
  const { service, records } = updateSandbox({ failAt: 'append:OrderChangeLog' });
  const payload = { OrderID: 'MED-20260719-0001', expectedVersion: 1, ReasonCode: 'PATIENT_CANCELLED' };
  assert.throws(() => service.cancelOrderByStaff_(staff, payload, 'cancel-token-rollback'), /injected/);
  assert.equal(records.OrderHeaders[0].Status, 'SUBMITTED');
  assert.equal(records.OrderHeaders[0].Version, 1);
  assert.equal(records.ActionTokens.every((row) => row.Status === 'ACTIVE' && row.UsedAt === '' && row.UsedBy === ''), true);
});

test('history reads are authorized, immutable, and scoped to the requested order', () => {
  const { service, records } = updateSandbox({ records: {
    OrderChangeLog: [{ OrderID: 'MED-20260719-0001', FieldName: 'PatientName' }, { OrderID: 'other', FieldName: 'HN' }],
    AppointmentResponseLog: [{ OrderID: 'MED-20260719-0001', ActionType: 'RESCHEDULE' }, { OrderID: 'other', ActionType: 'RECEIVED' }],
  } });
  assert.equal(service.getOrderChangeLog_(staff, 'MED-20260719-0001').length, 1);
  assert.equal(service.getAppointmentHistory_(staff, 'MED-20260719-0001').length, 1);
  assert.throws(() => service.getOrderChangeLog_(foreignStaff, 'MED-20260719-0001'), (error) => error.errorCode === 'ACCESS_DENIED');
  assert.equal(records.OrderChangeLog.length, 2);
});

test('router passes a normalized payload OrderID to immutable history handlers', () => {
  const seen = [];
  const api = vm.runInNewContext(`${source('backend/ApiRouter.gs')}\n({ routeApiRequest_ });`, {
    ApiError, requireSession_: () => staff,
    getOrderChangeLog_: (_context, orderId) => { seen.push(['changes', orderId]); return []; },
    getAppointmentHistory_: (_context, orderId) => { seen.push(['appointments', orderId]); return []; },
  });
  for (const [action, label] of [['GET_ORDER_CHANGE_LOG', 'changes'], ['GET_APPOINTMENT_HISTORY', 'appointments']]) {
    api.routeApiRequest_({ action, method: 'POST', requestId: `history-${label}`, sessionToken: 'token', payload: { OrderID: ' MED-20260719-0001 ' } });
  }
  assert.deepEqual(seen, [['changes', 'MED-20260719-0001'], ['appointments', 'MED-20260719-0001']]);
});

test('router role-guards the ADMIN cancellation decision action', () => {
  const seen = [];
  const api = vm.runInNewContext(`${source('backend/ApiRouter.gs')}\n({ routeApiRequest_ });`, {
    ApiError_: ApiError,
    requireSession_: () => admin,
    requireRole_: (context, roles) => {
      if (!roles.includes(context.user.Role)) throw new ApiError('ACCESS_DENIED', 'Access denied.');
    },
    decideCancellationByAdmin_: (_context, payload, requestId) => { seen.push({ payload, requestId }); return { Status: 'CANCELLED' }; },
  });
  const result = api.routeApiRequest_({
    action: 'DECIDE_CANCELLATION', method: 'POST', requestId: 'decision-route', sessionToken: 'token',
    payload: { OrderID: 'MED-20260719-0001', expectedVersion: 2, decision: 'APPROVE' },
  });
  assert.equal(result.Status, 'CANCELLED');
  assert.equal(seen[0].requestId, 'decision-route');
});
