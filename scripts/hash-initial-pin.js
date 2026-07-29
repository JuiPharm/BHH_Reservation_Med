const crypto = require('node:crypto');

const PREFIX = 'HMAC-SHA256$v2$';

function base64WebSafe(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createInitialPinHash(pin, appSecret, salt = crypto.randomBytes(16)) {
  if (typeof pin !== 'string' || pin.length < 8) throw new Error('PIN must contain at least 8 characters.');
  if (pin.length > 128) throw new Error('PIN must not exceed 128 characters.');
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(String(appSecret || ''))) throw new Error('APP_SECRET must be a 32-byte Base64URL value.');
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new Error('Salt must be 16 bytes.');
  const key = Buffer.from(appSecret, 'base64url');
  if (key.length !== 32) throw new Error('APP_SECRET must be a 32-byte Base64URL value.');
  const message = Buffer.concat([Buffer.from('MEDICATION_RESERVATION_PIN_V2\0', 'utf8'), salt, Buffer.from(pin, 'utf8')]);
  const mac = crypto.createHmac('sha256', key).update(message).digest();
  return `${PREFIX}${base64WebSafe(salt)}$${base64WebSafe(mac)}`;
}

async function readHiddenValue(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this helper from a private interactive terminal.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let pin = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    const onData = (chunk) => {
      const value = chunk.toString('utf8');
      if (value === '\u0003') { finish(); reject(new Error('PIN entry cancelled.')); return; }
      if (value === '\r' || value === '\n') { finish(); process.stdout.write('\n'); resolve(pin); return; }
      if (value === '\u007f' || value === '\b') { pin = pin.slice(0, -1); return; }
      if (/^[\x20-\x7e]+$/.test(value)) pin += value;
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const pin = await readHiddenValue('Enter initial PIN (input is not echoed): ');
  const appSecret = await readHiddenValue('Enter APP_SECRET (input is not echoed): ');
  const hash = createInitialPinHash(pin, appSecret);
  process.stdout.write(`Copy this PINHash directly into the protected Users sheet, then clear your terminal: ${hash}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createInitialPinHash };
