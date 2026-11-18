const test = require('node:test');
const assert = require('node:assert');
const { validatePassword } = require('../utils/passwordPolicy');

test('rejects weak / too-short / common passwords', () => {
  assert.strictEqual(validatePassword('password').valid, false);
  assert.strictEqual(validatePassword('short1!A').valid, false);
  assert.strictEqual(validatePassword('changeme123').valid, false);
});

test('accepts a strong password', () => {
  assert.strictEqual(validatePassword('Kf3xamp-742#', { email: 'a@b.com', name: 'Test' }).valid, true);
});

test('flags a password containing the user name (soft rule)', () => {
  const r = validatePassword('Benjamin-2026!', { name: 'Benjamin Ofori' });
  assert.ok(r.failedRules.some(m => /name or email/i.test(m)));
});
