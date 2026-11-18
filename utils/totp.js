// Minimal, dependency-free TOTP (RFC 6238) implementation — compatible with
// Microsoft Authenticator, Google Authenticator, Authy, and any standard
// authenticator app. No external npm package required for the core algorithm.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.substring(i, i + 5), 2)];
  }
  // Handle remaining bits (pad with zeros)
  const remainder = bits.length % 5;
  if (remainder !== 0) {
    const lastChunk = bits.substring(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// Generate a new random base32 secret (160 bits, the standard recommendation).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  // Write the 64-bit counter big-endian
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter % 2 ** 32, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (binCode % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

function totp(secretBase32, { step = 30, digits = 6, time = Date.now() } = {}) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(secretBase32, counter, digits);
}

// Verify a user-entered code, allowing +/- `window` steps of clock drift
// (default 1 step = up to ~30s either side, standard practice for TOTP apps).
function verifyToken(secretBase32, token, { step = 30, digits = 6, window = 1 } = {}) {
  if (!token || !/^\d{6}$/.test(String(token).trim())) return false;
  const cleanToken = String(token).trim();
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = hotp(secretBase32, counter + errorWindow, digits);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(cleanToken))) {
      return true;
    }
  }
  return false;
}

function otpauthURL({ issuer, accountName, secret }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Generate human-friendly one-time backup codes (used if the phone is lost).
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

module.exports = { generateSecret, totp, verifyToken, otpauthURL, generateBackupCodes, base32Encode, base32Decode };
