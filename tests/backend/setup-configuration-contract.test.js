const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../backend/SetupConfigurationService.gs'), 'utf8');
const { validateSetupConfiguration_ } = vm.runInNewContext(`${source}\n({ validateSetupConfiguration_ });`);

function randomLike(offset) {
  const alphabet = ['AbCdEfGhIj', 'KlMnOpQrSt', 'UvWxYz0123', '456789_-'].join('');
  return Array.from({ length: 43 }, (_, index) => alphabet[(index + offset) % alphabet.length]).join('');
}

function properties(values = {}) {
  const result = {};
  result['SPREADSHEET_ID'] = values.spreadsheetId || 'a'.repeat(20);
  result['FRONTEND_BASE_URL'] = values.frontendBaseUrl || 'https://example.github.io/medication-reservation/';
  result['APP_SECRET'] = values.appSecret || randomLike(0);
  result['TOKEN_SIGNING_SECRET'] = values.tokenSigningSecret || randomLike(1);
  result['DEPLOYMENT_ENV'] = values.deploymentEnv || 'production';
  return result;
}

test('setup configuration accepts canonical values and normalizes a Pages path without trailing slash', () => {
  const result = validateSetupConfiguration_(properties());

  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(result.errors), []);
  assert.equal(result.normalized.FRONTEND_BASE_URL, 'https://example.github.io/medication-reservation');
});

test('setup configuration accepts only exact 32-byte Base64URL secret encodings', () => {
  const unpadded = randomLike(0);
  const padded = unpadded + '=';

  assert.equal(validateSetupConfiguration_(properties({ appSecret: unpadded, tokenSigningSecret: randomLike(1) })).valid, true);
  assert.equal(validateSetupConfiguration_(properties({ appSecret: padded, tokenSigningSecret: randomLike(1) })).valid, true);

  for (const invalid of [
    unpadded.slice(0, 42),
    unpadded + 'x',
    unpadded + '==',
    unpadded.slice(0, -1) + '+',
    ' ' + unpadded,
    unpadded + ' ',
  ]) {
    const result = validateSetupConfiguration_(properties({ appSecret: invalid, tokenSigningSecret: randomLike(1) }));
    assert.equal(result.valid, false, `must reject invalid secret shape (${JSON.stringify(invalid)})`);
    assert.deepEqual(Array.from(result.errors, (error) => error.field), ['APP_SECRET']);
  }
});

test('setup configuration returns field-specific safe errors for malformed or unsafe values', () => {
  const input = properties({
    spreadsheetId: 'short',
    frontendBaseUrl: 'https://user:password@example.github.io/path?token=leak',
    appSecret: 'placeholder',
    tokenSigningSecret: 'placeholder',
    deploymentEnv: 'preview',
  });
  const result = validateSetupConfiguration_(input);

  assert.equal(result.valid, false);
  assert.deepEqual(Array.from(result.errors, (error) => error.field), [
    'SPREADSHEET_ID', 'FRONTEND_BASE_URL', 'APP_SECRET', 'TOKEN_SIGNING_SECRET', 'DEPLOYMENT_ENV',
  ]);
  assert.equal(JSON.stringify(result.errors).includes('password'), false);
  assert.equal(JSON.stringify(result.errors).includes('placeholder'), false);
});

test('setup configuration rejects equal secrets, whitespace, and noncanonical deployment values', () => {
  const sameSecret = randomLike(2);
  const result = validateSetupConfiguration_(properties({
    appSecret: sameSecret,
    tokenSigningSecret: sameSecret,
    frontendBaseUrl: 'https://example.github.io/path#fragment',
    deploymentEnv: ' production ',
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(Array.from(result.errors, (error) => error.field), [
    'FRONTEND_BASE_URL', 'APP_SECRET', 'TOKEN_SIGNING_SECRET', 'DEPLOYMENT_ENV',
  ]);
});

test('setup configuration compares padded and unpadded encodings canonically for distinctness', () => {
  const secret = randomLike(3);

  for (const [appSecret, tokenSigningSecret] of [[secret, secret + '='], [secret + '=', secret]]) {
    const result = validateSetupConfiguration_(properties({ appSecret, tokenSigningSecret }));
    assert.equal(result.valid, false);
    assert.deepEqual(Array.from(result.errors, (error) => error.field), ['APP_SECRET', 'TOKEN_SIGNING_SECRET']);
    assert.deepEqual(Array.from(result.errors, (error) => error.code), ['SECRETS_MUST_DIFFER', 'SECRETS_MUST_DIFFER']);
    assert.equal(JSON.stringify(result.errors).includes(secret), false);
  }
});

test('setup configuration does not reject valid CSPRNG output based on character diversity', () => {
  const result = validateSetupConfiguration_(properties({
    appSecret: 'A'.repeat(43),
    tokenSigningSecret: 'B'.repeat(43),
  }));

  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(result.errors), []);
});
