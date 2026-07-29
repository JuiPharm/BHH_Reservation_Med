const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const pages = [
  'index.html', 'login.html', 'dashboard.html', 'new-order.html', 'order-detail.html',
  'edit-order.html', 'reschedule.html', 'appointment-action.html', 'admin.html',
  'admin-order-detail.html', 'unauthorized.html', 'error.html',
];

function page(name) {
  return fs.readFileSync(path.join(root, 'frontend', name), 'utf8');
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/giu).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('each required page has an accessible shared application shell', () => {
  for (const name of pages) {
    assert.equal(fs.existsSync(path.join(root, 'frontend', name)), true, `${name} is missing`);
    const html = page(name);
    assert.match(html, /<a[^>]+class="skip-link"[^>]+href="#main-content"/);
    assert.match(html, /<header\b/);
    assert.match(html, /<nav\b[^>]*aria-label=/);
    assert.match(html, /<main\b[^>]*id="main-content"/);
    assert.match(html, /<footer\b/);
    assert.match(html, /role="status"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /<script[^>]+type="module"/);
  }
});

test('shell provides a non-sensitive identity area and a logo fallback', () => {
  const html = page('dashboard.html');
  assert.match(html, /id="identity-name"/);
  assert.match(html, /id="identity-staff-id"/);
  assert.match(html, /id="identity-department"/);
  assert.match(html, /id="identity-role"/);
  assert.match(html, /<img[^>]+alt="โลโก้ระบบจองยาเฉพาะราย"/);
  assert.match(html, /class="brand-fallback"/);
  assert.equal(fs.existsSync(path.join(root, 'frontend/assets/logo-placeholder.svg')), true);
});

test('login labels the StaffID text field for credential managers', () => {
  const html = page('login.html');
  assert.match(html, /<label[^>]+for="staff-id"[^>]*>รหัสเจ้าหน้าที่<\/label>/);
  assert.match(html, /<input[^>]+id="staff-id"[^>]+type="text"[^>]+autocomplete="username"/);
  assert.match(html, /<label[^>]+for="pin"[^>]*>รหัส PIN<\/label>/);
});

test('login client uses the backend credential payload contract', () => {
  const source = fs.readFileSync(path.join(root, 'frontend/js/auth.js'), 'utf8');
  assert.match(source, /apiRequest\('LOGIN',\s*\{/);
  assert.match(source, /\bstaffId\b/);
  assert.match(source, /\bpin\b/);
});

test('logo fallback becomes visible after a logo loading failure', () => {
  const css = fs.readFileSync(path.join(root, 'frontend/css/main.css'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'frontend/js/auth.js'), 'utf8');
  assert.match(css, /\.brand-fallback:not\(\[hidden\]\)\s*\{\s*display:\s*inline/);
  assert.match(source, /image\.hidden = true/);
  assert.match(source, /fallback\.hidden = false/);
});

test('every identity shell offers an accessible logout action', () => {
  for (const name of pages) {
    const html = page(name);
    assert.match(html, /data-action="logout"/, `${name} has no logout action`);
    assert.match(html, /id="identity-role"/, `${name} has no role identity placeholder`);
  }
});

test('login controls announce field-local validation errors', () => {
  const html = page('login.html');
  const source = fs.readFileSync(path.join(root, 'frontend/js/auth.js'), 'utf8');
  assert.match(html, /data-field-error="staff-id"[^>]*role="alert"/);
  assert.match(html, /data-field-error="pin"[^>]*role="alert"/);
  assert.match(source, /รหัสเจ้าหน้าที่เป็นข้อมูลที่จำเป็น/);
  assert.match(source, /รหัส PIN เป็นข้อมูลที่จำเป็น/);
  assert.match(source, /showFieldErrors\(localErrors, form\)/);
  assert.match(source, /clearFieldError/);
});

test('navigation links provide a 44px minimum touch target', () => {
  const css = fs.readFileSync(path.join(root, 'frontend/css/main.css'), 'utf8');
  assert.match(css, /\.site-nav a\s*\{[^}]*min-height:\s*44px[^}]*\}/s);
  assert.match(css, /\.site-nav a\s*\{[^}]*padding-block:\s*[^;]+;[^}]*\}/s);
});

test('identity values wrap instead of overflowing narrow screens', () => {
  const css = fs.readFileSync(path.join(root, 'frontend/css/main.css'), 'utf8');
  assert.match(css, /\.identity\s*\{[^}]*min-width:\s*0[^}]*\}/s);
  assert.match(css, /\.identity\s*\{[^}]*max-width:\s*100%[^}]*\}/s);
  assert.match(css, /\.identity span\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*\}/s);
});

test('focus indicator has at least 3:1 contrast against white', () => {
  const variables = fs.readFileSync(path.join(root, 'frontend/css/variables.css'), 'utf8');
  const match = variables.match(/--focus:\s*(#[a-f\d]{6})/iu);
  assert.ok(match, 'focus color must be a six-digit hex color');
  assert.ok(
    contrastRatio(match[1], '#ffffff') >= 3,
    `${match[1]} does not meet the 3:1 focus-indicator contrast requirement against white`,
  );
});
