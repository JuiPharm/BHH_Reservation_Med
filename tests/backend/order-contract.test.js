const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function source(path) { return fs.readFileSync(path, 'utf8'); }

function apiError(errorCode, safeMessage, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage;
  this.errors = errors;
}

function createOrderSandbox(options = {}) {
  const records = {
    OrderHeaders: [], OrderItems: [], RequestLog: [], AuditLog: [], EmailLog: [],
    Users: [{ StaffID: '00123', Email: 'trusted@example.invalid', Active: 'TRUE' }],
    Departments: [{ DepartmentCode: 'ER', CCEmail: '', Active: 'TRUE' }],
    ...(options.records || {}),
  };
  const events = [];
  let failAuditOnce = !!options.failAuditOnce;
  let notificationFailureUsed = false;
  const fieldMaps = {
    OrderHeaders: { OrderID: 1 }, OrderItems: { OrderItemID: 1 }, RequestLog: { RequestID: 1, Action: 2, OrderID: 3, StaffID: 4, CreatedAt: 5, Result: 6, ResponseData: 7 },
  };
  const context = {
    ApiError_: apiError,
    Array, Date, JSON, Math, Number, Object, RegExp, String, isFinite,
    Utilities: { formatDate: () => '20260719', getUuid: () => 'uuid-1' },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    getSetting_: () => 'MED',
    getMasterData_: () => ({ DOSAGE_FORM: [{ Code: 'TABLET' }], UNIT: [{ Code: 'TABLET' }], PRIORITY: [{ Code: 'NORMAL' }] }),
    readRecords_: (name, query = {}) => {
      if (name === 'EmailLog' && options.failNotificationClaimRead && !context.notificationFailureDisabled && !notificationFailureUsed
        && records.RequestLog.some((row) => row.Action === 'CREATE_ORDER' && row.Result === 'SUCCESS')
        && records.EmailLog.some((row) => row.Result === 'PENDING')) {
        notificationFailureUsed = true;
        throw new Error('notification claim read failed');
      }
      const rows = records[name] || [];
      const filtered = query.predicate ? rows.filter(query.predicate) : rows.slice();
      return query.limit == null ? filtered : filtered.slice(0, query.limit);
    },
    appendRecords_: (name, rows) => {
      events.push(`append:${name}`);
      if (name === 'AuditLog' && failAuditOnce) { failAuditOnce = false; throw new Error('audit write failed'); }
      if (name === 'EmailLog' && options.failEmailLogAppend) throw new Error('email log write failed');
      const target = records[name] || (records[name] = []);
      const startRow = target.length + 2;
      rows.forEach((row) => target.push({ ...row }));
      return { startRow, rowCount: rows.length };
    },
    updateRecordByKey_: (name, key, value, updates) => {
      const row = (records[name] || []).find((entry) => String(entry[key]) === String(value));
      if (!row) return null;
      Object.assign(row, { ...updates });
      return { ...row };
    },
    updateRecordByCompositeKey_: (name, keys, updates) => {
      const matches = (records[name] || []).filter((row) => Object.entries(keys).every(([key, value]) => String(row[key] || '') === String(value || '')));
      if (matches.length !== 1) throw new Error('Composite key must match exactly one record.');
      Object.assign(matches[0], { ...updates });
      return { ...matches[0] };
    },
    LockService: { getScriptLock: () => ({ waitLock: () => events.push('lock'), releaseLock: () => events.push('unlock') }) },
    requireOrderAccess_: (trusted, order) => {
      if (!trusted || !trusted.user || (trusted.user.Role !== 'ADMIN' && String(trusted.user.Department) !== String(order.Department))) throw new apiError('ACCESS_DENIED', 'Access denied.');
      return order;
    },
    getSheetOrThrow_: (name) => ({
      name,
      getLastRow: () => (records[name] || []).length + 1,
      getRange: (startRow, column, rowCount) => ({
        getDisplayValues: () => (records[name] || []).slice(startRow - 2, startRow - 2 + rowCount).map((record) => {
          const key = Object.keys(fieldMaps[name]).find((candidate) => fieldMaps[name][candidate] === column);
          return [String(record[key] || '')];
        }),
        setValues: (values) => {
          const target = (records[name] || [])[startRow - 2];
          if (name === 'RequestLog' && column === fieldMaps.RequestLog.Result) {
            target.Result = values[0][0];
            target.ResponseData = values[0][1];
          }
        },
      }),
      deleteRows: (startRow, rowCount) => {
        events.push(`delete:${name}`);
        if (options.deleteFailureFor === name) throw new Error('delete failed');
        records[name].splice(startRow - 2, rowCount);
      },
    }),
    getHeaderMap_: (sheet) => fieldMaps[sheet.name],
    readRecordAtRow_: (sheet, rowNumber) => ({ ...(records[sheet.name] || [])[rowNumber - 2] }),
    MailApp: { sendEmail: (message) => { events.push('email'); if (options.emailFails) throw new Error('mail failed'); context.lastEmail = message; } },
  };
  const files = ['backend/OrderIdService.gs', 'backend/OrderItemService.gs', 'backend/AuditService.gs', 'backend/ChangeLogService.gs', 'backend/EmailService.gs', 'backend/OrderService.gs'];
  const service = vm.runInNewContext(`${files.map(source).join('\n')}\n({ createOrder_, listDepartmentOrders_, getOrderDetail_, getStaffDashboard_, generateOrderIds_, rollbackCreateAppendRanges_ });`, context);
  return { service, records, events, context };
}

function validPayload(overrides = {}) {
  return {
    HN: '07-01-000001', PatientName: 'Ada', WardClinic: 'ER', RequiredDate: '2026-07-20',
    Items: [{ GenericName: 'Amoxicillin', Strength: '500 mg', DosageForm: 'TABLET', RequestedQuantity: 2, Unit: 'TABLET', Prescriber: 'Dr Test' }],
    ...overrides,
  };
}

const staff = { user: { StaffID: '00123', FullName: 'Ada Staff', Department: 'ER', Email: 'trusted@example.invalid', Role: 'STAFF' } };

test('daily IDs support 99 unique item suffixes and reject a 100th item', () => {
  const { service } = createOrderSandbox();
  const ids = service.generateOrderIds_(99, new Date('2026-07-19T00:00:00Z'));
  assert.equal(ids.itemIds[0], 'MED-20260719-0001-01');
  assert.equal(ids.itemIds[98], 'MED-20260719-0001-99');
  assert.throws(() => service.generateOrderIds_(100, new Date()), (error) => error.errorCode === 'VALIDATION_ERROR');
});

test('creation persists a multi-item order, logs the authenticated requester email, and replays before locking', () => {
  const { service, records, events, context } = createOrderSandbox();
  const payload = validPayload({ RequesterEmail: 'attacker@example.invalid', Items: [validPayload().Items[0], { GenericName: 'Second', DosageForm: 'TABLET', RequestedQuantity: 1, Unit: 'TABLET', Prescriber: 'Dr Test' }] });
  const first = service.createOrder_(staff, payload, 'req-1');
  const locksAfterCreate = events.filter((event) => event === 'lock').length;
  const replay = service.createOrder_(staff, payload, 'req-1');
  assert.equal(first.OrderID, 'MED-20260719-0001');
  assert.equal(replay.OrderID, first.OrderID);
  assert.equal(replay.replayed, true);
  assert.equal(events.filter((event) => event === 'lock').length, locksAfterCreate, 'successful replay must not lock');
  assert.equal(records.OrderHeaders[0].RequesterEmail, 'trusted@example.invalid');
  assert.equal(records.OrderItems.length, 2);
  assert.equal(records.EmailLog[0].Result, 'SUCCESS');
  assert.ok(events.indexOf('unlock') < events.indexOf('email'), 'email must run after the lock is released');
  assert.equal(context.lastEmail.to, 'trusted@example.invalid');
  assert.match(context.lastEmail.htmlBody, /MED-20260719-0001/);
  assert.match(context.lastEmail.body, /MED-20260719-0001/);
});

test('creation rechecks a request log entry acquired while waiting for the lock', () => {
  const sandbox = createOrderSandbox();
  let requestReads = 0;
  const originalRead = sandbox.context.readRecords_;
  sandbox.context.readRecords_ = (name, options) => {
    if (name === 'RequestLog') {
      requestReads += 1;
      if (requestReads === 2) return [{ RequestID: 'raced', Action: 'CREATE_ORDER', StaffID: '00123', OrderID: 'MED-20260719-0042', Result: 'SUCCESS', ResponseData: '{"ItemCount":1,"Status":"SUBMITTED"}' }];
    }
    return originalRead(name, options);
  };
  const replay = sandbox.service.createOrder_(staff, validPayload(), 'raced');
  assert.equal(replay.OrderID, 'MED-20260719-0042');
  assert.equal(replay.replayed, true);
  assert.equal(sandbox.events.filter((event) => event === 'lock').length, 1);
  assert.equal(sandbox.records.OrderHeaders.length, 0);
});

test('creation validates required prescriber, optional priority, and Task 2 length limits before it locks', () => {
  const { service, events } = createOrderSandbox();
  assert.throws(() => service.createOrder_(staff, validPayload({ Items: [{ GenericName: 'A', DosageForm: 'TABLET', RequestedQuantity: 1, Unit: 'TABLET', Prescriber: '' }] }), 'missing-prescriber'), (error) => error.errorCode === 'VALIDATION_ERROR' && error.errors.some((entry) => entry.field === 'Items[0].Prescriber'));
  assert.throws(() => service.createOrder_(staff, validPayload({ PatientName: 'x'.repeat(201) }), 'too-long'), (error) => error.errorCode === 'VALIDATION_ERROR' && error.errors.some((entry) => entry.field === 'PatientName'));
  assert.equal(events.includes('lock'), false);
  assert.equal(service.createOrder_(staff, validPayload(), 'optional-priority').Status, 'SUBMITTED');
});

test('rollback proves every append range before deleting any row and always writes a failure audit', () => {
  const { service, records, events } = createOrderSandbox({ failAuditOnce: true });
  assert.throws(() => service.createOrder_(staff, validPayload(), 'rollback-all'), /audit write failed/);
  assert.deepEqual(records.OrderHeaders, []);
  assert.deepEqual(records.OrderItems, []);
  assert.equal(records.RequestLog.length, 1);
  assert.equal(records.RequestLog[0].Result, 'TRANSACTION_FAILURE');
  assert.equal(records.AuditLog.at(-1).Result, 'TRANSACTION_FAILURE');
  assert.deepEqual(events.filter((event) => event.startsWith('delete:')), ['delete:OrderItems', 'delete:OrderHeaders']);
});

test('rollback mutates nothing when one ownership proof fails and preserves the original error', () => {
  const sandbox = createOrderSandbox({ failAuditOnce: true });
  const originalAppend = sandbox.context.appendRecords_;
  sandbox.context.appendRecords_ = (name, rows) => {
    const result = originalAppend(name, rows);
    if (name === 'RequestLog') sandbox.records.OrderItems[0].OrderItemID = 'foreign-item';
    return result;
  };
  assert.throws(() => sandbox.service.createOrder_(staff, validPayload(), 'rollback-proof'), /audit write failed/);
  assert.equal(sandbox.events.some((event) => event.startsWith('delete:')), false);
  assert.equal(sandbox.records.OrderHeaders.length, 1);
  assert.equal(sandbox.records.OrderItems.length, 1);
  assert.equal(sandbox.records.RequestLog.length, 1);
  assert.equal(sandbox.records.RequestLog[0].Result, 'TRANSACTION_FAILURE');
  assert.equal(sandbox.records.AuditLog.at(-1).Result, 'TRANSACTION_FAILURE');
});

test('rollback contains deletion errors, preserves the original error, and records transaction failure', () => {
  const { service, records, events } = createOrderSandbox({ failAuditOnce: true, deleteFailureFor: 'OrderItems' });
  assert.throws(() => service.createOrder_(staff, validPayload(), 'rollback-delete-error'), /audit write failed/);
  assert.deepEqual(events.filter((event) => event.startsWith('delete:')), ['delete:OrderItems']);
  assert.equal(records.OrderHeaders.length, 1);
  assert.equal(records.OrderItems.length, 1);
  assert.equal(records.RequestLog[0].Result, 'TRANSACTION_FAILURE');
  assert.equal(records.AuditLog.at(-1).Result, 'TRANSACTION_FAILURE');
});

test('email failure is logged and never reverses a completed order', () => {
  const { service, records, events } = createOrderSandbox({ emailFails: true });
  const result = service.createOrder_(staff, validPayload(), 'email-failure');
  assert.equal(result.Status, 'SUBMITTED');
  assert.equal(records.OrderHeaders.length, 1);
  assert.equal(records.EmailLog[0].Result, 'FAILED');
  assert.ok(events.indexOf('unlock') < events.indexOf('email'));
});

test('email-log storage failure creates an operational audit without reversing the order', () => {
  const { service, records } = createOrderSandbox({ failEmailLogAppend: true });
  assert.equal(service.createOrder_(staff, validPayload(), 'email-log-failure').Status, 'SUBMITTED');
  assert.equal(records.OrderHeaders.length, 1);
  assert.equal(records.EmailLog.length, 0);
  assert.equal(records.AuditLog.at(-1).Action, 'EMAIL_LOG');
  assert.equal(records.AuditLog.at(-1).Result, 'FAILURE');
});

test('create persists and reconciles the same durable post-commit notification job', () => {
  const sandbox = createOrderSandbox({ failNotificationClaimRead: true });
  assert.equal(sandbox.service.createOrder_(staff, validPayload(), 'create-post-commit').Status, 'SUBMITTED');
  const business = sandbox.records.RequestLog.find((row) => row.Action === 'CREATE_ORDER');
  assert.equal(business.Result, 'SUCCESS');
  assert.ok(JSON.parse(business.ResponseData).postCommitNotification);
  sandbox.context.notificationFailureDisabled = true;
  const replay = sandbox.service.createOrder_(staff, validPayload(), 'create-post-commit');
  assert.equal(replay.replayed, true);
  assert.equal(sandbox.events.filter((event) => event === 'email').length, 1);
});

test('whitespace-only required text is rejected before lock acquisition', () => {
  const { service, events } = createOrderSandbox();
  assert.throws(() => service.createOrder_(staff, validPayload({ PatientName: '   ' }), 'blank-patient'), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => service.createOrder_(staff, validPayload({ Items: [{ GenericName: ' ', DosageForm: 'TABLET', RequestedQuantity: 1, Unit: 'TABLET', Prescriber: '  ' }] }), 'blank-item'), (error) => error.errorCode === 'VALIDATION_ERROR' && error.errors.some((entry) => entry.field === 'Items[0].GenericName') && error.errors.some((entry) => entry.field === 'Items[0].Prescriber'));
  assert.equal(events.includes('lock'), false);
});

test('a failed transaction replays as a deterministic failure and cannot create a duplicate', () => {
  const { service, records } = createOrderSandbox({ failAuditOnce: true, deleteFailureFor: 'OrderItems' });
  assert.throws(() => service.createOrder_(staff, validPayload(), 'failed-retry'), /audit write failed/);
  assert.throws(() => service.createOrder_(staff, validPayload(), 'failed-retry'), (error) => error.errorCode === 'REQUEST_REPLAY');
  assert.equal(records.OrderHeaders.length, 1);
  assert.equal(records.RequestLog.length, 1);
});

test('department lists normalize pagination and detail authorization happens before lazy item reads', () => {
  const { service, records, context } = createOrderSandbox({ records: { OrderHeaders: [
    { OrderID: 'MED-20260719-0001', Department: 'ER', Status: 'SUBMITTED', ItemCount: 1 },
    { OrderID: 'MED-20260719-0002', Department: 'ICU', Status: 'SUBMITTED', ItemCount: 1 },
  ], OrderItems: [{ OrderID: 'MED-20260719-0001', OrderItemID: 'MED-20260719-0001-01', ItemNo: 1 }] } });
  const list = service.listDepartmentOrders_(staff, { page: '2.8', pageSize: '999.7' });
  assert.deepEqual(JSON.parse(JSON.stringify(list)), { page: 2, pageSize: 100, total: 1, orders: [] });
  const foreign = { user: { Department: 'ICU', Role: 'STAFF' } };
  let itemReads = 0;
  const originalRead = context.readRecords_;
  context.readRecords_ = (name, options) => { if (name === 'OrderItems') itemReads += 1; return originalRead(name, options); };
  context.requireOrderAccess_ = () => { throw new apiError('ACCESS_DENIED', 'Access denied.'); };
  assert.throws(() => service.getOrderDetail_(foreign, 'MED-20260719-0001'), (error) => error.errorCode === 'ACCESS_DENIED');
  assert.equal(itemReads, 0);
});

test('authorized order detail returns the non-empty editable requester phone', () => {
  const { service } = createOrderSandbox({ records: {
    OrderHeaders: [{
      OrderID: 'MED-20260719-0001', Department: 'ER', Status: 'SUBMITTED', Version: 1,
      RequesterPhone: '0812345678', HN: '07-01-000001', PatientName: 'Ada', ItemCount: 1,
    }],
    OrderItems: [{ OrderID: 'MED-20260719-0001', OrderItemID: 'MED-20260719-0001-01' }],
  } });
  assert.equal(service.getOrderDetail_(staff, 'MED-20260719-0001').order.RequesterPhone, '0812345678');
});

test('staff dashboard allowlists status, order-ID search, sort, and pagination before calculating totals', () => {
  const matching = Array.from({ length: 26 }, (_value, index) => ({
    OrderID: `MATCH-${String(index + 1).padStart(2, '0')}`,
    Department: 'ER', Status: 'SUBMITTED', ItemCount: 1,
    CreatedAt: `2026-07-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`, RequiredDate: '2026-07-30',
  }));
  const { service } = createOrderSandbox({ records: { OrderHeaders: matching.concat([
    { OrderID: 'MATCH-IGNORE-STATUS', Department: 'ER', Status: 'CANCELLED', ItemCount: 1, CreatedAt: '2026-07-20T00:00:00.000Z' },
    { OrderID: 'MATCH-FOREIGN', Department: 'ICU', Status: 'SUBMITTED', ItemCount: 1, CreatedAt: '2026-07-21T00:00:00.000Z' },
  ]) } });
  const query = { filters: { Status: 'submitted', Department: 'ICU' }, search: 'match-', sort: 'OrderID:desc', page: 2 };
  const list = service.listDepartmentOrders_(staff, query);
  const dashboard = service.getStaffDashboard_(staff, query);
  assert.deepEqual(JSON.parse(JSON.stringify(list)), {
    page: 2, pageSize: 25, total: 26,
    orders: [{ OrderID: 'MATCH-01', CreatedAt: '2026-07-01T00:00:00.000Z', HN: '', PatientName: '', WardClinic: '', RequiredDate: '2026-07-30', Priority: '', Status: 'SUBMITTED', ItemCount: 1, Version: 0 }],
  });
  assert.equal(dashboard.totalOrders, 26);
  assert.equal(dashboard.page, 2);
  assert.equal(dashboard.total, 26);
  assert.equal(dashboard.recentOrders[0].OrderID, 'MATCH-01');
  const fallback = service.listDepartmentOrders_(staff, { filters: { HN: 'ignored' }, search: '', sort: 'HN:asc', page: 1 });
  assert.equal(fallback.total, 27, 'unallowlisted filters and sort fields must not change the department result');
  assert.equal(fallback.orders[0].OrderID, 'MATCH-IGNORE-STATUS', 'unknown sort falls back to the default allowlisted sort');
});

test('router accepts only payload.OrderID and dispatches the normalized ID to details', () => {
  const received = [];
  const context = {
    ApiError_: apiError,
    requireSession_: () => ({ user: { StaffID: '00123' } }),
    getOrderDetail_: (_trusted, orderId) => { received.push(orderId); return { OrderID: orderId }; },
  };
  const api = vm.runInNewContext(`${source('backend/ApiRouter.gs')}\n({ routeApiRequest_ });`, context);
  const request = { action: 'GET_ORDER_DETAIL', method: 'POST', sessionToken: 'token', requestId: 'r', payload: { OrderID: ' MED-20260719-0001 ' } };
  assert.deepEqual(JSON.parse(JSON.stringify(api.routeApiRequest_(request))), { OrderID: 'MED-20260719-0001' });
  assert.deepEqual(received, ['MED-20260719-0001']);
  assert.throws(() => api.routeApiRequest_({ ...request, payload: { orderId: 'MED-20260719-0001' } }), (error) => error.errorCode === 'VALIDATION_ERROR');
});
