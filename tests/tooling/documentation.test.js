const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const documents = [
  'README.md',
  'backend/README.md',
  'docs/architecture.md',
  'docs/api.md',
  'docs/deployment-checklist.md',
  'docs/uat-checklist.md',
  'docs/limitations.md',
];

function documentation() {
  return documents.map((file) => {
    const absolute = path.join(root, file);
    assert.equal(fs.existsSync(absolute), true, `missing handoff document: ${file}`);
    return fs.readFileSync(absolute, 'utf8');
  }).join('\n');
}

test('operator documentation defines the complete secure deployment contract', () => {
  const text = documentation();
  for (const name of ['SPREADSHEET_ID', 'FRONTEND_BASE_URL', 'APP_SECRET', 'TOKEN_SIGNING_SECRET', 'DEPLOYMENT_ENV']) {
    assert.match(text, new RegExp(`\\b${name}\\b`), `missing Script Property: ${name}`);
  }
  for (const sheet of [
    'Users', 'Departments', 'OrderHeaders', 'OrderItems', 'OrderChangeLog', 'EmailLog', 'AuditLog',
    'Settings', 'MasterData', 'Sessions', 'RequestLog', 'AppointmentResponseLog', 'AppointmentReminderLog', 'ActionTokens',
  ]) assert.match(text, new RegExp(`\\b${sheet}\\b`), `missing sheet: ${sheet}`);

  for (const entryPoint of [
    'setupApplication', 'initializeDatabase', 'getDatabaseHealth', 'setupAppointmentReminderTrigger',
    'scheduledSchemaCheck', 'processAppointmentDueReminders', 'expireActionTokens',
  ]) assert.match(text, new RegExp(`\\b${entryPoint}\\b`), `missing setup or scheduled job: ${entryPoint}`);

  assert.match(text, /execute as[\s\S]{0,120}owner/i);
  assert.match(text, /who has access[\s\S]{0,160}(?:anyone|organization|domain)/i);
  assert.match(text, /CORS[\s\S]{0,240}(?:cannot|constrain|limited|not)/i);
  assert.match(text, /Apps Script[\s\S]{0,240}(?:CORS|execution|timing)/i);
  assert.match(text, /360[\s\S]{0,80}390[\s\S]{0,80}430[\s\S]{0,80}768[\s\S]{0,80}1024[\s\S]{0,80}1280[\s\S]{0,80}1440/);
  assert.match(text, /200%\s+zoom/i);
  assert.match(text, /keyboard(?:-only)?/i);
  for (const role of ['staff', 'admin', 'email', 'reminder', 'reschedule']) {
    assert.match(text, new RegExp(`\\b${role}\\b`, 'i'), `missing UAT role or flow: ${role}`);
  }
  assert.match(text, /additive[\s\S]{0,160}(?:migration|schema|column)/i);
  assert.match(text, /rollback/i);
  assert.match(text, /runSchemaTests[\s\S]{0,120}runAuthTests[\s\S]{0,120}runOrderTests[\s\S]{0,120}runOrderUpdateTests[\s\S]{0,120}runEmailTests[\s\S]{0,120}runAppointmentTests/);
});

test('operator-only setupApplication entry point is present and not an API route', () => {
  const code = fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8');
  const router = fs.readFileSync(path.join(root, 'backend', 'ApiRouter.gs'), 'utf8');
  const apiGuide = fs.readFileSync(path.join(root, 'docs', 'api.md'), 'utf8');
  const backendGuide = fs.readFileSync(path.join(root, 'backend', 'README.md'), 'utf8');
  assert.match(code, /function\s+setupApplication\s*\(/);
  assert.doesNotMatch(router, /setupApplication/i);
  assert.doesNotMatch(apiGuide, /INITIALIZE_DATABASE/);
  assert.match(backendGuide, /32-byte[\s\S]{0,80}Base64URL/i);
  assert.match(backendGuide, /development[\s\S]{0,80}test[\s\S]{0,80}staging[\s\S]{0,80}production/i);
});

test('initial PIN hash helper emits the backend bounded-work HMAC record format without embedding a PIN', () => {
  const { createInitialPinHash } = require(path.join(root, 'scripts', 'hash-initial-pin.js'));
  const appSecret = Buffer.alloc(32, 9).toString('base64url');
  const hash = createInitialPinHash('strong-1234', appSecret, Buffer.alloc(16, 7));
  assert.match(hash, /^HMAC-SHA256\$v2\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.throws(() => createInitialPinHash('1234', appSecret, Buffer.alloc(16, 7)), /at least 8 characters/i);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts', 'hash-initial-pin.js'), 'utf8'), /strong-1234/);
});
