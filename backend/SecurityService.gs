/** Apps Script cryptographic adapters. Stored PIN values use bounded-work salted HMAC records. */
const PIN_HASH_PREFIX_ = 'HMAC-SHA256$v2$';
const PIN_HASH_BYTES_ = 32;
const PIN_SALT_BYTES_ = 16;

function sha256Hex_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return bytesToHex_(digest);
}

function bytesToHex_(bytes) {
  return bytes.map(function (value) {
    const unsigned = value < 0 ? value + 256 : value;
    return (unsigned < 16 ? '0' : '') + unsigned.toString(16);
  }).join('');
}

function randomBytes_(length) {
  let hex = '';
  while (hex.length < length * 2) hex += Utilities.getUuid().replace(/-/g, '');
  const bytes = [];
  for (let index = 0; index < length * 2; index += 2) bytes.push(parseInt(hex.substr(index, 2), 16));
  return bytes;
}

function generateRandomToken_() {
  return Utilities.base64EncodeWebSafe(randomBytes_(48)).replace(/=+$/, '');
}

function pinPepperBytes_() {
  const encoded = String(PropertiesService.getScriptProperties().getProperty('APP_SECRET') || '').trim();
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded)) throw new Error('APP_SECRET is not configured correctly.');
  const bytes = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(encoded));
  if (bytes.length !== PIN_HASH_BYTES_) throw new Error('APP_SECRET is not configured correctly.');
  return bytes;
}

function computePinMac_(pin, salt) {
  const domain = Array.prototype.slice.call(Utilities.newBlob('MEDICATION_RESERVATION_PIN_V2\u0000').getBytes());
  const pinBytes = Array.prototype.slice.call(Utilities.newBlob(String(pin)).getBytes());
  return Array.prototype.slice.call(Utilities.computeHmacSha256Signature(domain.concat(salt, pinBytes), pinPepperBytes_()));
}

function base64WebSafeNoPadding_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function createPinHash_(pin) {
  assertProvisionedPinPolicy_(pin);
  const salt = randomBytes_(PIN_SALT_BYTES_);
  const mac = computePinMac_(pin, salt);
  return PIN_HASH_PREFIX_ + base64WebSafeNoPadding_(salt) + '$' + base64WebSafeNoPadding_(mac);
}

function assertProvisionedPinPolicy_(pin) {
  if (typeof pin !== 'string' || pin.length < 8 || pin.length > 128) throw new Error('PIN must contain 8 to 128 characters.');
}

function verifyPinHash_(pin, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.indexOf(PIN_HASH_PREFIX_) !== 0) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'HMAC-SHA256' || parts[1] !== 'v2') return false;
  try {
    const salt = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[2]));
    const expected = Array.prototype.slice.call(Utilities.base64DecodeWebSafe(parts[3]));
    if (salt.length !== PIN_SALT_BYTES_ || expected.length !== PIN_HASH_BYTES_) return false;
    if (!isCanonicalWebSafeBase64_(parts[2], salt) || !isCanonicalWebSafeBase64_(parts[3], expected)) return false;
    const actual = computePinMac_(pin, salt);
    return constantTimeEqual_(actual, expected);
  } catch (_ignored) {
    return false;
  }
}

function isCanonicalWebSafeBase64_(encoded, bytes) {
  return base64WebSafeNoPadding_(bytes) === encoded;
}

function constantTimeEqual_(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] & 255) ^ (right[index] & 255);
  return difference === 0;
}
