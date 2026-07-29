const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const moduleUrl = (name) => pathToFileURL(path.join(root, 'frontend/js', name)).href;

async function modules() {
  const [admin, appointment, reschedule, session] = await Promise.all([
    import(moduleUrl('admin.js')),
    import(moduleUrl('appointment-action.js')),
    import(moduleUrl('reschedule.js')),
    import(moduleUrl('session.js')),
  ]);
  return { admin, appointment, reschedule, session };
}

test('admin dashboard uses backend authorization and only its permitted department filter', async () => {
  const { admin } = await modules();
  let call;
  await admin.loadAdminDashboard({ department: 'ICU', role: 'ADMIN', HN: 'ignore' }, async (action, payload) => {
    call = { action, payload };
    return { data: { recentOrders: [] } };
  });
  assert.deepEqual(call, { action: 'GET_ADMIN_DASHBOARD', payload: { department: 'ICU' } });
  const html = fs.readFileSync(path.join(root, 'frontend/admin.html'), 'utf8');
  assert.doesNotMatch(html, /data-roles=/);
});

test('receiving rejects quantities outside the requested amount before sending the exact payload', async () => {
  const { admin } = await modules();
  const invalid = admin.validateReceivedItemsModel({
    OrderID: 'MED-1', expectedVersion: 3,
    Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'RECEIVED', RequestedQuantity: 2, ReceivedQuantity: 1, ReceivedDate: '2030-01-01', ReceivedUnit: 'TABLET' }],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors['Items[0].ReceivedQuantity']);
  let call;
  await admin.submitReceivedItems({
    OrderID: 'MED-1', expectedVersion: 3,
    Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'PARTIALLY_RECEIVED', RequestedQuantity: 2, ReceivedQuantity: 1, ReceivedDate: '2030-01-01', ReceivedUnit: 'TABLET', AdminNote: '' }],
  }, async (action, payload, options) => {
    call = { action, payload, requestId: options.requestId };
    return { data: { Version: 4 } };
  }, () => 'receive-1');
  assert.deepEqual(call, {
    action: 'UPDATE_RECEIVED_ITEMS', requestId: 'receive-1', payload: {
      OrderID: 'MED-1', expectedVersion: 3,
      Items: [{ OrderItemID: 'MED-1-01', ItemStatus: 'PARTIALLY_RECEIVED', ReceivedDate: '2030-01-01', ReceivedQuantity: 1, ReceivedUnit: 'TABLET', AdminNote: '' }],
    },
  });
});

test('email send is explicitly confirmed and failed delivery is the only retryable state', async () => {
  const { admin } = await modules();
  let calls = 0;
  await admin.confirmAndSendOrderEmail('MED-1', 4, async () => { calls += 1; }, async () => false);
  assert.equal(calls, 0);
  assert.deepEqual(admin.emailDeliveryState({ result: 'FAILED', emailLogId: 'EML-1' }), { retryable: true, manualReview: false });
  assert.deepEqual(admin.emailDeliveryState({ result: 'UNCERTAIN', emailLogId: 'EML-1' }), { retryable: false, manualReview: true });
  assert.deepEqual(admin.emailResultState({ email: { result: 'SUCCESS', emailLogId: 'EML-success' } }), { retryable: false, manualReview: false, emailLogId: 'EML-success', message: 'ระบบบันทึกผลการส่งอีเมลแล้ว' });
  assert.deepEqual(admin.emailResultState({ email: { result: 'FAILED', emailLogId: 'EML-new' } }), { retryable: true, manualReview: false, emailLogId: 'EML-new', message: 'การส่งอีเมลล้มเหลว สามารถลองส่งซ้ำได้' });
  assert.deepEqual(admin.emailControlState({ manualReview: true }), { sendDisabled: true, retryDisabled: true });
});

test('email reconciliation errors lock the exact send and resend operation without issuing another request', async () => {
  const { admin } = await modules();
  const pending = Object.assign(new Error('pending'), { errorCode: 'EMAIL_DELIVERY_PENDING' });
  let sends = 0;
  const send = async (_action, _payload, options) => { sends += 1; assert.equal(options.requestId, 'email-pending-1'); throw pending; };
  await assert.rejects(() => admin.confirmAndSendOrderEmail('MED-PENDING', 4, send, async () => true, () => 'email-pending-1'), { errorCode: 'EMAIL_DELIVERY_PENDING' });
  await assert.rejects(() => admin.confirmAndSendOrderEmail('MED-PENDING', 4, send, async () => true, () => 'email-pending-2'), { errorCode: 'EMAIL_RECONCILIATION_REQUIRED' });
  assert.equal(sends, 1);
  assert.deepEqual(admin.emailDeliveryState(pending), { retryable: false, manualReview: true });

  let resends = 0;
  const uncertain = Object.assign(new Error('uncertain'), { errorCode: 'EMAIL_DELIVERY_UNCERTAIN' });
  const resend = async (_action, _payload, options) => { resends += 1; assert.equal(options.requestId, 'email-resend-1'); throw uncertain; };
  await assert.rejects(() => admin.confirmAndResendFailedEmail('EML-PENDING', resend, async () => true, () => 'email-resend-1'), { errorCode: 'EMAIL_DELIVERY_UNCERTAIN' });
  await assert.rejects(() => admin.confirmAndResendFailedEmail('EML-PENDING', resend, async () => true, () => 'email-resend-2'), { errorCode: 'EMAIL_RECONCILIATION_REQUIRED' });
  assert.equal(resends, 1);
});

test('ambiguous retries are keyed to the exact mutation payload rather than a module-wide request id', async () => {
  const { admin, appointment, reschedule } = await modules();
  const network = () => Object.assign(new Error('offline'), { errorCode: 'NETWORK_ERROR' });
  const receiveIds = [];
  const receiveA = { OrderID: 'MED-RECEIVE', expectedVersion: 1, Items: [{ OrderItemID: 'I-1', ItemStatus: 'PARTIALLY_RECEIVED', RequestedQuantity: 2, ReceivedQuantity: 1, ReceivedDate: '2030-01-01', ReceivedUnit: 'TABLET', AdminNote: '' }] };
  const receiveB = { ...receiveA, expectedVersion: 2 };
  await assert.rejects(() => admin.submitReceivedItems(receiveA, async (_a, _p, o) => { receiveIds.push(o.requestId); throw network(); }, () => 'receive-key-1'), { errorCode: 'NETWORK_ERROR' });
  await admin.submitReceivedItems(receiveB, async (_a, _p, o) => { receiveIds.push(o.requestId); return { data: {} }; }, () => 'receive-key-2');
  assert.deepEqual(receiveIds, ['receive-key-1', 'receive-key-2']);

  const actionIds = [];
  await assert.rejects(() => appointment.confirmAppointmentAction({ token: 'token-key', actionType: 'RECEIVED' }, async (_a, _p, o) => { actionIds.push(o.requestId); throw network(); }, async () => true, () => 'action-key-1'), { errorCode: 'NETWORK_ERROR' });
  await appointment.confirmAppointmentAction({ token: 'token-key', actionType: 'NO_SHOW', reasonCode: 'UNKNOWN', reasonDetail: '' }, async (_a, _p, o) => { actionIds.push(o.requestId); return { data: {} }; }, async () => true, () => 'action-key-2');
  assert.deepEqual(actionIds, ['action-key-1', 'action-key-2']);

  const rescheduleIds = [];
  const scheduleA = { reference: 'reference-key', expectedVersion: 1, newRequiredDate: '2030-01-02', reason: 'Reason' };
  await assert.rejects(() => reschedule.submitReschedule(scheduleA, async (_a, _p, o) => { rescheduleIds.push(o.requestId); throw network(); }, () => 'reschedule-key-1'), { errorCode: 'NETWORK_ERROR' });
  await reschedule.submitReschedule({ ...scheduleA, reason: 'Changed reason' }, async (_a, _p, o) => { rescheduleIds.push(o.requestId); return { data: {} }; }, () => 'reschedule-key-2');
  assert.deepEqual(rescheduleIds, ['reschedule-key-1', 'reschedule-key-2']);
});

test('appointment action accepts an opaque token, performs no mutation while loading, and requires no-show detail conditionally', async () => {
  const { appointment } = await modules();
  assert.equal(appointment.tokenFromSearch('?token=opaque-token&HN=ignored'), 'opaque-token');
  const calls = [];
  await appointment.loadAppointmentAction('opaque-token', async (action, payload, options) => {
    calls.push({ action, payload, method: options.method });
    return { data: { actionType: 'NO_SHOW', requiresReason: true, noShowReasons: [{ code: 'UNREACHABLE', label: 'Unreachable' }] } };
  });
  assert.deepEqual(calls, [{ action: 'GET_APPOINTMENT_ACTION', payload: { token: 'opaque-token' }, method: 'GET' }]);
  const invalid = appointment.validateAppointmentAction({ token: 'opaque-token', actionType: 'NO_SHOW', reasonCode: 'OTHER', reasonDetail: '' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.reasonDetail);
  assert.deepEqual(appointment.noShowReasonOptions({ noShowReasons: [{ code: 'UNREACHABLE', label: 'Unreachable' }, { code: '', label: 'Invalid' }] }), [{ code: 'UNREACHABLE', label: 'Unreachable' }]);
  const page = fs.readFileSync(path.join(root, 'frontend/appointment-action.html'), 'utf8');
  assert.match(page, /<select id="no-show-reason" name="reasonCode"/);
});

test('appointment action keeps a canonical localized no-show code selectable and submits it unchanged', async () => {
  const { appointment } = await modules();
  const reasons = appointment.noShowReasonOptions({ noShowReasons: [
    { code: 'ไม่มาตามนัด custom reason', label: 'ผู้ป่วยแจ้งเหตุผลเฉพาะ' },
    null,
    { code: '   ', label: 'Empty code' },
  ] });
  assert.deepEqual(reasons, [{ code: 'ไม่มาตามนัด custom reason', label: 'ผู้ป่วยแจ้งเหตุผลเฉพาะ' }]);
  let call;
  await appointment.confirmAppointmentAction({ token: 'opaque-token', actionType: 'NO_SHOW', reasonCode: reasons[0].code, reasonDetail: '' }, async (action, payload, options) => {
    call = { action, payload, requestId: options.requestId };
    return { data: { Status: 'COMPLETED' } };
  }, async () => true, () => 'localized-reason-1');
  assert.deepEqual(call, {
    action: 'SUBMIT_PATIENT_NO_SHOW', requestId: 'localized-reason-1',
    payload: { token: 'opaque-token', reasonCode: 'ไม่มาตามนัด custom reason', reasonDetail: '' },
  });
});

test('appointment mutations wait for confirmation and reuse their request id after an ambiguous retry', async () => {
  const { appointment } = await modules();
  const sent = [];
  const request = async (action, payload, options) => {
    sent.push({ action, payload, requestId: options.requestId });
    if (sent.length === 1) { const error = new Error('offline'); error.errorCode = 'NETWORK_ERROR'; throw error; }
    return { data: { Status: 'COMPLETED' } };
  };
  await assert.rejects(() => appointment.confirmAppointmentAction({ token: 'opaque-token', actionType: 'RECEIVED' }, request, async () => true, () => 'action-1'), { errorCode: 'NETWORK_ERROR' });
  await appointment.confirmAppointmentAction({ token: 'opaque-token', actionType: 'RECEIVED' }, request, async () => true, () => 'action-2');
  assert.deepEqual(sent, [
    { action: 'CONFIRM_PATIENT_RECEIVED', payload: { token: 'opaque-token' }, requestId: 'action-1' },
    { action: 'CONFIRM_PATIENT_RECEIVED', payload: { token: 'opaque-token' }, requestId: 'action-1' },
  ]);
});

test('reschedule page hands a validated opaque reference through the fixed login return path', async () => {
  const { reschedule, session } = await modules();
  const storage = new Map();
  const location = { replace: (target) => { location.target = target; } };
  await reschedule.beginReschedule('opaque-reference', {
    request: async (action, payload, options) => {
      assert.deepEqual({ action, payload, method: options.method }, { action: 'GET_RESCHEDULE_REFERENCE', payload: { reference: 'opaque-reference' }, method: 'GET' });
      return { data: { actionType: 'RESCHEDULE', requiresLogin: true } };
    },
    session: null,
    storage: { setItem: (key, value) => storage.set(key, value) },
    location,
  });
  assert.equal(storage.size, 1);
  assert.equal([...storage.values()][0], 'opaque-reference');
  assert.equal(location.target, 'login.html');
  assert.equal(session.loginSuccessDestination({ getItem: () => 'opaque-reference' }), 'reschedule.html');
  assert.equal(session.loginSuccessDestination({ getItem: () => '' }), 'dashboard.html');
  const page = fs.readFileSync(path.join(root, 'frontend/reschedule.html'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'frontend/js/auth.js'), 'utf8');
  assert.doesNotMatch(page, /data-requires-auth=/);
  assert.match(page, /src="js\/reschedule\.js"/);
  assert.match(auth, /loginSuccessDestination\(/);
});

test('reschedule keeps an existing opaque handoff when the public preview has a transient network failure', async () => {
  const { reschedule } = await modules();
  const storage = new Map([['medication-reservation.reschedule-reference.v1', 'opaque-reference']]);
  const network = Object.assign(new Error('offline'), { errorCode: 'NETWORK_ERROR' });
  await assert.rejects(() => reschedule.beginReschedule('opaque-reference', {
    request: async () => { throw network; }, session: { sessionToken: 'session' }, storage: { getItem: (key) => storage.get(key), removeItem: (key) => storage.delete(key) },
  }), { errorCode: 'NETWORK_ERROR' });
  assert.equal(storage.get('medication-reservation.reschedule-reference.v1'), 'opaque-reference');
});

test('reschedule submits a reason with expected Version', async () => {
  const { reschedule } = await modules();
  const invalid = reschedule.validateRescheduleModel({ reference: 'opaque-reference', expectedVersion: 4, newRequiredDate: '2030-01-01', reason: '' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.reason);
  let call;
  await reschedule.submitReschedule({ reference: 'opaque-reference', expectedVersion: 4, newRequiredDate: '2030-01-02', reason: 'Clinic request' }, async (action, payload, options) => {
    call = { action, payload, requestId: options.requestId };
    return { data: { Version: 5 } };
  }, () => 'reschedule-1');
  assert.deepEqual(call, { action: 'SUBMIT_APPOINTMENT_RESCHEDULE', requestId: 'reschedule-1', payload: { reference: 'opaque-reference', expectedVersion: 4, newRequiredDate: '2030-01-02', reason: 'Clinic request' } });
});

class FakeElement {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.name = ''; this.focused = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelectorAll(selector) { return this._all().filter((node) => this._matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  _all() { return this.children.flatMap((child) => [child, ...child._all()]); }
  _matches(node, selector) {
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!attribute) return false;
    const [, name, expected] = attribute;
    const value = name.startsWith('data-') ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] : node.attributes[name] || node[name];
    return value !== undefined && (expected === undefined || String(value) === expected);
  }
  focus() { this.focused = true; }
}

test('receiving row integrates indexed server errors with local aria error targets', async () => {
  const { admin } = await modules();
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  try {
    const row = admin.receivedRow({ OrderItemID: 'ITEM-1', RequestedQuantity: 2, Unit: 'TABLET' }, 0);
    const root = new FakeElement('form'); root.append(row);
    const { showFieldErrors } = await import(moduleUrl('ui.js'));
    globalThis.CSS = { escape: (value) => value };
    showFieldErrors({ 'Items[0].ReceivedQuantity': 'จำนวนไม่ถูกต้อง' }, root);
    const input = row.querySelector('[name="ReceivedQuantity"]');
    const error = row.querySelector('[data-medication-field-error="ReceivedQuantity"]');
    assert.match(input.attributes['aria-describedby'], /received-error-0-ReceivedQuantity/);
    assert.equal(input.attributes['aria-invalid'], 'true');
    assert.equal(input.focused, true);
    assert.equal(error.textContent, 'จำนวนไม่ถูกต้อง');
  } finally { globalThis.document = priorDocument; }
});

test('appointment and reschedule pages do not place order or patient details in their URL builders', () => {
  const sources = ['appointment-action.js', 'reschedule.js'].map((name) => fs.readFileSync(path.join(root, 'frontend/js', name), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /[?&](?:HN|PatientName|OrderID)=/i);
  assert.doesNotMatch(sources, /innerHTML/);
});

test('admin detail exposes accessible cancellation decision controls and submits a versioned idempotent action', async () => {
  const { admin } = await modules();
  const html = fs.readFileSync(path.join(root, 'frontend/admin-order-detail.html'), 'utf8');
  assert.match(html, /id="cancellation-decision"/);
  assert.match(html, /id="approve-cancellation"/);
  assert.match(html, /id="reject-cancellation"/);
  assert.match(html, /for="cancellation-decision-reason"/);
  let received;
  const result = await admin.submitCancellationDecision({
    OrderID: 'MED-1', expectedVersion: 2, decision: 'REJECT', decisionReason: 'Already fulfilled',
  }, async (action, payload, options) => {
    received = { action, payload, requestId: options.requestId };
    return { data: { Status: 'NOTIFIED', Version: 3 } };
  }, () => 'decision-1');
  assert.deepEqual(received, {
    action: 'DECIDE_CANCELLATION',
    payload: { OrderID: 'MED-1', expectedVersion: 2, decision: 'REJECT', decisionReason: 'Already fulfilled' },
    requestId: 'decision-1',
  });
  assert.equal(result.Status, 'NOTIFIED');
});

test('staff cancellation OTHER detail has frontend maximum-length parity', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/order-detail.html'), 'utf8');
  assert.match(html, /name="ReasonDetail"[^>]*maxlength="1000"/);
});
