const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const SECURITY_PATH = 'backend/SecurityService.gs';
const APP_SECRET = crypto.randomBytes(32).toString('base64url');

function signedBytes(buffer) {
  return Array.from(buffer, (value) => (value > 127 ? value - 256 : value));
}

function loadSecurityService() {
  let hmacCalls = 0;
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key === 'APP_SECRET' ? APP_SECRET : null),
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64DecodeWebSafe: (value) => signedBytes(Buffer.from(String(value), 'base64url')),
      base64EncodeWebSafe: (value) => Buffer.from(value.map((byte) => byte & 255)).toString('base64url'),
      computeDigest: (_algorithm, value) => signedBytes(crypto.createHash('sha256').update(String(value)).digest()),
      computeHmacSha256Signature: (message, key) => {
        hmacCalls += 1;
        return signedBytes(crypto.createHmac('sha256', Buffer.from(key.map((byte) => byte & 255)))
          .update(Buffer.from(message.map((byte) => byte & 255))).digest());
      },
      getUuid: () => crypto.randomUUID(),
      newBlob: (value) => ({ getBytes: () => signedBytes(Buffer.from(String(value), 'utf8')) }),
    },
  };
  const source = fs.readFileSync(SECURITY_PATH, 'utf8');
  const service = vm.runInNewContext(`${source}\n({ createPinHash_, verifyPinHash_ });`, context);
  return { service, hmacCalls: () => hmacCalls };
}

test('PIN hashing uses a versioned salted HMAC record with constant cryptographic work', () => {
  const runtime = loadSecurityService();
  const first = runtime.service.createPinHash_('24682468');
  const second = runtime.service.createPinHash_('24682468');

  assert.match(first, /^HMAC-SHA256\$v2\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second, 'each PIN record must use a unique salt');
  assert.equal(runtime.service.verifyPinHash_('24682468', first), true);
  assert.equal(runtime.service.verifyPinHash_('wrong-pin', first), false);
  assert.equal(runtime.hmacCalls(), 4, 'each create or verify operation must perform exactly one HMAC');
});

test('legacy PBKDF2 records fail closed without running the expensive loop', () => {
  const runtime = loadSecurityService();
  const legacy = `PBKDF2-SHA256$v1$100000$${'A'.repeat(22)}$${'A'.repeat(43)}`;

  assert.equal(runtime.service.verifyPinHash_('24682468', legacy), false);
  assert.equal(runtime.hmacCalls(), 0);
});
