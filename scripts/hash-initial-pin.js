const crypto = require('crypto');

function base64WebSafeNoPadding(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashPin(pin, appSecret) {
  if (!pin || pin.length < 8) {
    console.error("PIN must be at least 8 characters.");
    process.exit(1);
  }
  if (!appSecret) {
    console.error("APP_SECRET is required.");
    process.exit(1);
  }

  // 1. Decode APP_SECRET
  const pepperBuf = Buffer.from(appSecret, 'base64');
  if (pepperBuf.length !== 32) {
    console.error("APP_SECRET must decode to exactly 32 bytes.");
    process.exit(1);
  }

  // 2. Generate random 16-byte salt
  const saltBuf = crypto.randomBytes(16);

  // 3. Construct domain + salt + pin
  const domainBuf = Buffer.from("MEDICATION_RESERVATION_PIN_V2\0", 'utf8');
  const pinBuf = Buffer.from(pin, 'utf8');
  const messageBuf = Buffer.concat([domainBuf, saltBuf, pinBuf]);

  // 4. Compute HMAC-SHA256
  const hmac = crypto.createHmac('sha256', pepperBuf);
  hmac.update(messageBuf);
  const macBuf = hmac.digest();

  // 5. Format string
  const hashString = "HMAC-SHA256$v2$" + base64WebSafeNoPadding(saltBuf) + "$" + base64WebSafeNoPadding(macBuf);

  console.log('----------------------------------------');
  console.log(`PIN      : ${pin}`);
  console.log(`Hash     : ${hashString}`);
  console.log('----------------------------------------');
  console.log(`Copy the Hash value and paste it into the 'PINHash' column of the 'Users' sheet.`);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node scripts/hash-initial-pin.js <PIN> <APP_SECRET>');
  console.log('Example: node scripts/hash-initial-pin.js 12345678 "your-base64-app-secret="');
} else {
  hashPin(args[0], args[1]);
}

