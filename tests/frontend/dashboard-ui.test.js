const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const moduleUrl = (name) => pathToFileURL(path.join(root, 'frontend/js', name)).href;

async function modules() {
  const [dashboard, detail, edit] = await Promise.all([
    import(moduleUrl('dashboard.js')),
    import(moduleUrl('order-detail.js')),
    import(moduleUrl('edit-order.js')),
  ]);
  return { dashboard, detail, edit };
}

test('dashboard sends only its filter, search, sort, and page query to the department-scoped API', async () => {
  const { dashboard } = await modules();
  let received;
  await dashboard.loadDashboard({ filters: { Status: 'SUBMITTED' }, search: 'ORD', sort: 'CreatedAt:desc', page: 2 }, async (action, payload) => {
    received = { action, payload };
    return { data: { recentOrders: [] } };
  });
  assert.deepEqual(received, {
    action: 'GET_STAFF_DASHBOARD',
    payload: { filters: { Status: 'SUBMITTED' }, search: 'ORD', sort: 'CreatedAt:desc', page: 2 },
  });
});

test('dashboard search debounces input for 300 ms', async () => {
  const { dashboard } = await modules();
  let count = 0;
  const search = dashboard.createSearchDebouncer(() => { count += 1; }, 300);
  search('first');
  search('second');
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.equal(count, 1);
});

test('dashboard card click applies the card status filter', async () => {
  const { dashboard } = await modules();
  const card = new EventTarget();
  card.dataset = { status: 'SUBMITTED' };
  let status = '';
  dashboard.bindStatusCard(card, (filters) => { status = filters.Status; });
  card.dispatchEvent(new Event('click'));
  assert.equal(status, 'SUBMITTED');
});

test('dashboard pagination advances only while another page exists', async () => {
  const { dashboard } = await modules();
  assert.equal(dashboard.nextPage({ page: 1, pageSize: 25, total: 26 }), 2);
  assert.equal(dashboard.nextPage({ page: 2, pageSize: 25, total: 26 }), 2);
});

test('detail loading requests order items only when detail is opened', async () => {
  const { detail } = await modules();
  const calls = [];
  const result = await detail.loadOrderDetail('ORD-1', async (action, payload) => {
    calls.push({ action, payload });
    return { data: { order: { OrderID: 'ORD-1' }, items: [] } };
  });
  assert.deepEqual(calls, [{ action: 'GET_ORDER_DETAIL', payload: { OrderID: 'ORD-1' } }]);
  assert.equal(result.order.OrderID, 'ORD-1');
});

test('edit workflow presents a reload action for a Version conflict', async () => {
  const { edit } = await modules();
  const message = edit.versionConflictMessage({ errorCode: 'ORDER_VERSION_CONFLICT' });
  assert.equal(message.reload, true);
  assert.match(message.text, /โหลดข้อมูลล่าสุด/);
});

test('edit workflow preserves a loaded non-empty requester phone in an unrelated update payload', async () => {
  const { edit } = await modules();
  const loaded = edit.editableOrderValues({
    RequesterPhone: '0812345678', HN: '07-01-000001', PatientName: 'Ada',
    WardClinic: 'ER', RequiredDate: '2030-01-01', Priority: 'NORMAL',
  });
  const payload = edit.buildUpdatePayload('MED-1', 4, {
    ...loaded,
    PatientName: 'Ada Updated',
    Items: [{ OrderItemID: 'MED-1-01', GenericName: 'Medicine', BrandName: '', Strength: '10 mg', DosageForm: 'TABLET', RequestedQuantity: 1, Unit: 'TABLET', Prescriber: 'Dr Test' }],
  });
  assert.equal(payload.RequesterPhone, '0812345678');
  assert.equal(payload.PatientName, 'Ada Updated');
});

test('edit submissions reuse an ambiguous network request ID, but rotate it after a definitive result or reload', async () => {
  const { edit } = await modules();
  const sent = [];
  const ids = ['update-1', 'update-2', 'update-3', 'update-4', 'update-5'];
  const submit = edit.createUpdateSubmitter(async (_action, _payload, options) => {
    sent.push(options.requestId);
    if (sent.length === 1) { const error = new Error('offline'); error.errorCode = 'NETWORK_ERROR'; throw error; }
    if (sent.length === 3) { const error = new Error('invalid'); error.errorCode = 'VALIDATION_ERROR'; throw error; }
    if (sent.length === 5) { const error = new Error('offline'); error.errorCode = 'REQUEST_TIMEOUT'; throw error; }
    return { data: { Version: 2 } };
  }, () => ids.shift());
  await assert.rejects(() => submit({ OrderID: 'ORD-1', expectedVersion: 1 }), { errorCode: 'NETWORK_ERROR' });
  await submit({ OrderID: 'ORD-1', expectedVersion: 1 });
  await assert.rejects(() => submit({ OrderID: 'ORD-1', expectedVersion: 2 }), { errorCode: 'VALIDATION_ERROR' });
  await submit({ OrderID: 'ORD-1', expectedVersion: 2 });
  await assert.rejects(() => submit({ OrderID: 'ORD-1', expectedVersion: 3 }), { errorCode: 'REQUEST_TIMEOUT' });
  submit.resetAfterReload();
  await submit({ OrderID: 'ORD-1', expectedVersion: 3 });
  assert.deepEqual(sent, ['update-1', 'update-1', 'update-2', 'update-3', 'update-4', 'update-5']);
});

test('browser workflow modules declare their own ESM package boundary without changing CommonJS tooling', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/js/package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
});
