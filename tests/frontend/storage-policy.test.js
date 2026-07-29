const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const browserStorage = 'local' + 'Storage';

function frontendFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return frontendFiles(target);
    return /\.(?:html|js|css|json|svg)$/u.test(entry.name) ? [target] : [];
  });
}

function policyFiles() {
  return frontendFiles(path.join(root, 'frontend'));
}

function staticPhiViolations(source) {
  const violations = [];
  const hns = source.match(/\b07-\d{2}-\d{6}\b/gu) || [];
  for (const value of hns) violations.push(`HN value ${value}`);
  const namedValues = source.matchAll(/\b(?:patientName|patient_name|patient|hn)\b\s*[:=]\s*(['"])(?!\1\s*(?:[,;}\n]|$))[^'"\n]+\1/giu);
  for (const match of namedValues) violations.push(`named patient value ${match[0]}`);
  const urlValues = source.matchAll(/[?&](?:patientName|patient_name|patient|hn)=([^&#\s"']+)/giu);
  for (const match of urlValues) violations.push(`URL patient value ${match[0]}`);
  const urlSearchParams = source.matchAll(/\.set\(\s*['"](?:patientName|patient_name|patient|hn)['"]\s*,\s*[^)]+\)/giu);
  for (const match of urlSearchParams) violations.push(`URLSearchParams patient value ${match[0]}`);
  return violations;
}

test('frontend shell does not use persistent browser storage', () => {
  const files = policyFiles();
  assert.ok(files.length > 0);
  const prohibited = [browserStorage];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const token of prohibited) {
      assert.equal(text.includes(token), false, `${path.relative(root, file)} includes ${token}`);
    }
  }
});

test('frontend HTML, JavaScript, config, and static assets do not embed patient or HN values', () => {
  const files = policyFiles();
  assert.ok(files.some((file) => file.endsWith('.css')), 'CSS static assets must be included in the policy scan');
  assert.ok(files.some((file) => file.endsWith('.svg')), 'static assets must be included in the policy scan');
  assert.ok(files.some((file) => file.endsWith('config.js')), 'runtime config must be included in the policy scan');
  for (const file of files) {
    const violations = staticPhiViolations(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(violations, [], `${path.relative(root, file)} embeds ${violations.join(', ')}`);
  }
});

test('PHI asset scan permits field labels and workflow identifiers without values', () => {
  const labelMarkup = '<label for="hn">HN ผู้รับบริการ</label>';
  const workflowCode = 'const hn = form.elements.hn.value; const patient = workflow.patient;';
  assert.deepEqual(staticPhiViolations(labelMarkup), []);
  assert.deepEqual(staticPhiViolations(workflowCode), []);
});

test('session API stores only the bounded non-patient identity contract', () => {
  const source = fs.readFileSync(path.join(root, 'frontend/js/session.js'), 'utf8');
  for (const name of ['getSession', 'saveSession', 'clearSession', 'requireAuth']) {
    assert.match(source, new RegExp(`export\\s+(?:function|const)\\s+${name}\\b`));
  }
  assert.equal(source.includes(browserStorage), false);
});

function loadSessionModule(initialValue, initialReference = null) {
  let stored = initialValue;
  const storageName = 'session' + 'Storage';
  let reference = initialReference;
  const storage = {
    getItem: (key) => key.includes('reschedule-reference') ? reference : stored,
    setItem: (key, value) => { if (key.includes('reschedule-reference')) reference = value; else stored = value; },
    removeItem: (key) => { if (key.includes('reschedule-reference')) reference = null; else stored = null; },
  };
  const source = fs.readFileSync(path.join(root, 'frontend/js/session.js'), 'utf8')
    .replaceAll('export function ', 'function ');
  const context = { Date, JSON, globalThis: { [storageName]: storage } };
  const api = vm.runInNewContext(`${source}\n({ getSession, saveSession, clearSession, refreshSessionExpiry })`, context);
  return { api, value: () => stored, reference: () => reference };
}

test('saving a session excludes patient and HN values from browser session storage', () => {
  const { api, value } = loadSessionModule(null);
  api.saveSession({
    sessionToken: 'token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    user: {
      StaffID: '0007',
      FullName: 'เจ้าหน้าที่ทดสอบ',
      Department: 'เภสัชกรรม',
      Role: 'STAFF',
      HN: '07-12-345678',
      PatientName: 'Patient Example',
    },
  });
  assert.deepEqual(JSON.parse(value()), {
    sessionToken: 'token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    staffId: '0007',
    fullName: 'เจ้าหน้าที่ทดสอบ',
    department: 'เภสัชกรรม',
    role: 'STAFF',
  });
});

test('every protected response can refresh only the stored expiry without exposing or replacing identity', () => {
  const original = { sessionToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', staffId: '00123', fullName: 'Ada', department: 'ER', role: 'STAFF' };
  const { api, value } = loadSessionModule(JSON.stringify(original));
  assert.equal(api.refreshSessionExpiry('2030-01-01T00:15:00.000Z'), true);
  assert.deepEqual(JSON.parse(value()), { ...original, expiresAt: '2030-01-01T00:15:00.000Z' });
});

test('explicit logout and terminal expiry clear opaque handoff, but a deliberate logged-out login handoff survives', () => {
  const logout = loadSessionModule(JSON.stringify({ sessionToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z' }), 'opaque-reference');
  logout.api.clearSession();
  assert.equal(logout.value(), null);
  assert.equal(logout.reference(), null);

  const expired = loadSessionModule(JSON.stringify({ sessionToken: 'token', expiresAt: '2000-01-01T00:00:00.000Z' }), 'stale-reference');
  assert.equal(expired.api.getSession(), null);
  assert.equal(expired.reference(), null);

  const handoff = loadSessionModule(null, 'immediate-reference');
  assert.equal(handoff.api.getSession(), null);
  assert.equal(handoff.reference(), 'immediate-reference');
});

test('getSession clears a missing or malformed expiry value before returning identity', () => {
  for (const expiresAt of ['', 'not-a-date', 'Infinity']) {
    const { api, value } = loadSessionModule(JSON.stringify({ sessionToken: 'token', expiresAt }));
    assert.equal(api.getSession(), null, `expiry ${expiresAt} must fail closed`);
    assert.equal(value(), null, `expiry ${expiresAt} must be removed`);
  }
});
