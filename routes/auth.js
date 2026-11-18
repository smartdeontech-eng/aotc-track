const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const db = require('../utils/db');
const totp = require('../utils/totp');
const { validatePassword } = require('../utils/passwordPolicy');
const {
  requireAuth, requireRole, requirePermission, requireAnyPermission, JWT_SECRET,
  PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, ROLES,
  SESSION_ROLE_PRESETS, resolveSessionPreset,
} = require('../middleware/auth');
const { sendPasswordResetEmail, sendForgotEmailRequest, sendMail } = require('../utils/mailer');
const { sendSms } = require('../utils/sms');
const { notifyApprovers, notifyUser } = require('../utils/approvalNotify');
const { logNotification } = require('../utils/notifications');
const { isDisabled, DISABLED_MESSAGE } = require('../utils/accountStatus');
const webauthn = require('../utils/webauthn');

const router = express.Router();

// Cookies only get the `secure` flag in production because localhost dev is
// plain HTTP — browsers silently drop `secure` cookies over HTTP, which
// would otherwise break local testing. In production (behind HTTPS/nginx)
// this ensures the session cookie is never sent over an unencrypted connection.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
function cookieOptions(maxAge) {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge };
}

// The address that actually connected. The FIRST X-Forwarded-For value is
// whatever the client typed, so it is never used. In production `trust proxy`
// is set and req.ip is what Apache saw; if it is ever loopback anyway, the
// LAST X-Forwarded-For value is the one Apache appended.
function clientIp(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!/^(::ffff:)?127\.|^::1$/.test(ip)) return ip;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : ip;
}

function logLogin(entry) {
  require('../utils/pulse-reporter').report(entry, { lookupUser: (id) => db.findById('users', id) }); // to DeonTech Pulse (off unless PULSE_APP is set)
  try {
    db.insert('login_logs', {
      event: 'login',
      ip: '',
      userAgent: '',
      ...entry,
    });
  } catch (e) {
    console.error('[login-log] failed to write log entry:', e.message);
  }
}

function safeUser(user) {
  const {
    passwordHash, twoFactorSecret, twoFactorTempSecret, backupCodeHashes, passwordResetTokenHash,
    twoFactorTempOtpHash, loginOtpHash, stepUpOtpHash, passkeys, ...safe
  } = user;
  // Expose only non-sensitive passkey metadata (never the stored public keys).
  safe.passkeys = (passkeys || []).map(p => ({
    id: p.id, deviceName: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
  }));
  return safe;
}

// ---- Linked accounts (one person, several committee/group workspaces) ----
// A person signs in with ONE credential — their "primary" account. Every extra
// committee or group they serve is held as a linked "workspace" account: a
// separate user record, entity-scoped with its own role/permissions/position,
// but with NO usable credentials of its own. It's reachable only by switching
// from the primary session (POST /switch), never by a direct login — so all
// the existing per-entity scoping (which reads db.findById('users', id).entity)
// keeps working untouched: at any instant the session is one ordinary account.
//
// Grouping: a workspace account carries linkedTo = <primary id>; the primary
// (and any standalone account) has no linkedTo. primaryIdOf() collapses either
// side to the group's primary id; personGroup() returns the whole set.
function primaryIdOf(user) {
  if (!user) return null;
  return user.linkedTo ? Number(user.linkedTo) : Number(user.id);
}
function personGroup(user) {
  const pid = primaryIdOf(user);
  if (!pid) return [];
  const primary = db.findById('users', pid);
  const secondaries = db.findAll('users', u => Number(u.linkedTo) === pid);
  return primary ? [primary, ...secondaries] : secondaries;
}

// Session length: 12 hours normally, 30 days if "Remember me" was checked.
function sessionDuration(remember) {
  return remember
    ? { expiresIn: '30d', maxAge: 30 * 24 * 60 * 60 * 1000 }
    : { expiresIn: '12h', maxAge: 12 * 60 * 60 * 1000 };
}

// Issue the real session cookie + return the standard user payload. This is
// the "you're now logged in" step shared by password, 2FA, OTP and passkey
// logins — kept in one place so every path sets an identical cookie/claims.
// Embeds the account's current sessionVersion so a later bump (see
// bumpSessionVersion) invalidates this token — see requireAuth.
function finalizeLogin(res, user, remember) {
  const { expiresIn, maxAge } = sessionDuration(remember);
  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, sv: user.sessionVersion || 0 },
    JWT_SECRET,
    { expiresIn }
  );
  res.cookie('token', token, cookieOptions(maxAge));
  return { id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions || [] };
}

// Increments the account's sessionVersion, which immediately invalidates
// every session token issued before the call (they carry the old version —
// see requireAuth). Used anywhere a password is reset/changed on someone's
// behalf, or as part of full account recovery, so a compromised session
// doesn't just ride out its remaining cookie lifetime (up to 30 days).
// extraPatch lets the caller fold in other fields in the same db.update.
function bumpSessionVersion(userId, extraPatch = {}) {
  const user = db.findById('users', userId);
  if (!user) return null;
  return db.update('users', userId, { sessionVersion: (user.sessionVersion || 0) + 1, ...extraPatch });
}

// The seed admin account (id 1) gets extra protection beyond every other
// account — see the /me and /me/confirm routes below, and forgot-password
// further down. SEED_ADMIN_RECOVERY_EMAIL is a source-level constant on
// purpose, not a database field: nothing reachable through the app can ever
// repoint it, so it survives even a scenario where the account's own login
// email has been changed by an attacker.
const SEED_ADMIN_ID = 1;
const SEED_ADMIN_RECOVERY_EMAIL = process.env.NOTIFY_EMAIL || 'admin@pcg-aotc.com';

// ---- One-time codes (email / SMS second factor) ----
// A 6-digit numeric code, hashed at rest (never stored in the clear), valid
// for 10 minutes. Used both to confirm a channel during 2FA setup and as the
// login second factor when the user's chosen method is email or SMS.
const OTP_TTL_MS = 10 * 60 * 1000;
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  const shown = name.slice(0, 1);
  return `${shown}${'•'.repeat(Math.max(1, name.length - 1))}@${domain}`;
}
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 3) return '•••';
  return `•••••${d.slice(-3)}`;
}
// Deliver a code by the user's method. Returns a masked destination for the UI
// (so the user knows where to look) or null if the channel isn't usable.
async function deliverOtp(user, method, code, purpose) {
  const isSetup = purpose === 'setup';
  const line = `Your AOTC Track ${isSetup ? 'verification' : 'login'} code is ${code}. It expires in 10 minutes.`;
  if (method === 'email') {
    if (!user.email) return null;
    // DEV FALLBACK: with no SMTP configured (local testing), print the code
    // to the server console instead of failing — never active in production.
    if (!process.env.SMTP_HOST && process.env.NODE_ENV !== 'production') {
      console.log(`[dev-otp] ${purpose} code for ${user.email}: ${code}`);
      return maskEmail(user.email) + ' (dev: see server console)';
    }
    await sendMail({
      to: user.email,
      subject: `AOTC Track ${isSetup ? 'verification' : 'login'} code`,
      html: `<p>${line}</p><p style="color:#667">If you didn't request this, you can ignore this email.</p>`,
    });
    return maskEmail(user.email);
  }
  if (method === 'sms') {
    if (!user.phone) return null;
    const r = await sendSms({ to: user.phone, message: line });
    if (r && (r.skipped || r.error)) return null;
    return maskPhone(user.phone);
  }
  return null;
}

// Short-lived signed cookie used to carry a WebAuthn challenge between the
// "options" and "verify" requests, so we never trust a client-supplied
// challenge. Purpose is 'wa-reg' (enrolling) or 'wa-auth' (logging in).
function setChallengeCookie(res, name, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(name, token, { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 5 * 60 * 1000 });
}
function readChallengeCookie(req, name, expectedPurpose) {
  const raw = req.cookies && req.cookies[name];
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    if (payload.purpose !== expectedPurpose) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---- Login lockout (brute-force protection) ----
// Uses the login_logs history that's already recorded — no extra state to manage.
const LOCKOUT_THRESHOLD = 5;       // failed attempts...
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;   // ...within this window...
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // ...trigger this long a cooldown

// Bookkeeping entries that are logged success:false but are NOT failed
// attempts — 'awaiting-2fa' means the password was CORRECT, and
// 'must-change-password' likewise. Counting them locked out legitimate
// users who signed in several times in one window.
const NOT_A_FAILURE = new Set(['locked-out', 'awaiting-2fa', 'must-change-password']);
function recentFailedAttempts(email) {
  const since = Date.now() - LOCKOUT_WINDOW_MS;
  return db.findAll('login_logs', l =>
    l.email && String(l.email).toLowerCase() === email.toLowerCase() &&
    !l.success && !NOT_A_FAILURE.has(l.reason) &&
    new Date(l.createdAt).getTime() > since
  );
}

function checkLockout(email) {
  const attempts = recentFailedAttempts(email);
  if (attempts.length < LOCKOUT_THRESHOLD) return null;
  const mostRecent = attempts.reduce((a, b) => new Date(a.createdAt) > new Date(b.createdAt) ? a : b);
  const unlockAt = new Date(mostRecent.createdAt).getTime() + LOCKOUT_DURATION_MS;
  const msRemaining = unlockAt - Date.now();
  if (msRemaining <= 0) return null;
  return Math.ceil(msRemaining / 60000); // minutes remaining
}

// ---- Login (step 1: email + password) ----
// People can sign in with their email address OR their phone number — both
// are unique identifiers on the account. Phone matching tolerates spacing
// and the +233 country prefix (0244000000 == +233 24 400 0000).
function canonPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length > 9) d = '0' + d.slice(3);
  return d.length >= 9 ? d : null;
}
function findUserByIdentifier(identifier) {
  const idStr = String(identifier || '').trim();
  if (!idStr) return null;
  if (idStr.includes('@')) {
    return db.findOne('users', u => u.email.toLowerCase() === idStr.toLowerCase());
  }
  const p = canonPhone(idStr);
  if (p) {
    const byPhone = db.findOne('users', u => u.phone && canonPhone(u.phone) === p);
    if (byPhone) return byPhone;
  }
  // fall back to email match anyway (covers odd addresses without '@' typos)
  return db.findOne('users', u => u.email.toLowerCase() === idStr.toLowerCase());
}

// Which channel should the login code use?
//  - Accounts on an authenticator app (totp) never get sent codes → null.
//  - If an admin pinned a channel on the account (otpChannel email/sms), use it.
//  - Otherwise FOLLOW THE LOGIN: signed in with an email → code by email;
//    signed in with a phone number → code by SMS.
//  - Falls back to the other channel when the preferred one has no destination.
function chooseOtpChannel(user, identifier) {
  if (!['email', 'sms'].includes(user.twoFactorMethod)) return null;
  const pinned = ['email', 'sms'].includes(user.otpChannel) ? user.otpChannel : null;
  const idType = String(identifier || '').includes('@') ? 'email'
    : (canonPhone(identifier) ? 'sms' : 'email');
  let chan = pinned || idType;
  if (chan === 'sms' && !user.phone) chan = 'email';
  if (chan === 'email' && !user.email) chan = 'sms';
  return chan;
}

router.post('/login', (req, res) => {
  const { email, password, remember } = req.body; // `email` field carries email OR phone
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';

  if (!email || !password) return res.status(400).json({ error: 'Email/phone and password are required.' });

  const user = findUserByIdentifier(email);
  // Lockout is tracked against the account's canonical email, so switching
  // between phone and email identifiers can't bypass it.
  const lockoutKey = user ? user.email : String(email);
  const minutesLeft = checkLockout(lockoutKey);
  if (minutesLeft !== null) {
    logLogin({ userId: user ? user.id : null, email: lockoutKey, success: false, reason: 'locked-out', ip, userAgent });
    return res.status(429).json({ error: `Too many failed attempts. Please try again in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    logLogin({ userId: user ? user.id : null, email: lockoutKey, success: false, reason: 'incorrect-credentials', ip, userAgent });
    return res.status(401).json({ error: 'Incorrect email/phone or password.' });
  }
  // Only after the password is right, so "switched off" never reveals
  // whether an account exists to someone guessing.
  if (isDisabled(user)) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'account-disabled', ip, userAgent });
    return res.status(403).json({ error: DISABLED_MESSAGE, disabled: true });
  }

  // A brand-new account (or one an admin just reset) must set its own
  // password before getting a real session — this closes the window where
  // a known default/admin-set password would otherwise work indefinitely.
  const chan = chooseOtpChannel(user, email);

  if (user.mustChangePassword) {
    const pendingToken = jwt.sign({ id: user.id, purpose: 'password-change-required', remember: !!remember, chan: chan || undefined }, JWT_SECRET, { expiresIn: '10m' });
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'must-change-password', ip, userAgent });
    return res.json({ mustChangePassword: true, pendingToken });
  }

  if (user.twoFactorEnabled) {
    const pendingToken = jwt.sign({ id: user.id, purpose: '2fa-pending', remember: !!remember, chan: chan || undefined }, JWT_SECRET, { expiresIn: '5m' });
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'awaiting-2fa', ip, userAgent });
    return res.json({ twoFactorRequired: true, pendingToken, method: chan || user.twoFactorMethod || 'totp' });
  }

  logLogin({ userId: user.id, email: user.email, success: true, reason: 'ok', ip, userAgent });
  res.json(finalizeLogin(res, user, remember));
});

// ---- Complete a forced password change (new account, or admin-reset one) ----
router.post('/login/complete-password-change', (req, res) => {
  const { pendingToken, newPassword } = req.body;
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';
  if (!pendingToken || !newPassword) return res.status(400).json({ error: 'Missing required fields.' });

  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
    if (payload.purpose !== 'password-change-required') throw new Error('wrong purpose');
  } catch (e) {
    return res.status(401).json({ error: 'This step expired. Please log in again.' });
  }

  const user = db.findById('users', payload.id);
  if (!user) return res.status(401).json({ error: 'Please log in again.' });

  const result = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!result.valid) {
    return res.status(400).json({ error: 'Password is not strong enough.', failedRules: result.failedRules });
  }
  db.update('users', user.id, { passwordHash: bcrypt.hashSync(newPassword, 10), mustChangePassword: false });

  if (user.twoFactorEnabled) {
    const twoFaToken = jwt.sign({ id: user.id, purpose: '2fa-pending', remember: !!payload.remember, chan: payload.chan || undefined }, JWT_SECRET, { expiresIn: '5m' });
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'awaiting-2fa', ip, userAgent });
    return res.json({ twoFactorRequired: true, pendingToken: twoFaToken, method: payload.chan || user.twoFactorMethod || 'totp' });
  }

  logLogin({ userId: user.id, email: user.email, success: true, reason: 'ok-after-forced-password-change', ip, userAgent });
  res.json(finalizeLogin(res, user, payload.remember));
});

// ---- Login (step 2a): send an email/SMS code (only when that's the method) ----
// Called by the login page right after step 1 returns method 'email'/'sms',
// and again if the user taps "resend". The code is hashed onto the user record
// with a 10-minute expiry; the response only reveals a masked destination.
router.post('/login/send-otp', async (req, res) => {
  const { pendingToken } = req.body;
  if (!pendingToken) return res.status(400).json({ error: 'Missing session. Please log in again.' });

  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
    if (payload.purpose !== '2fa-pending') throw new Error('wrong purpose');
  } catch (e) {
    return res.status(401).json({ error: 'This verification step expired. Please log in again.' });
  }

  const user = db.findById('users', payload.id);
  if (!user || !user.twoFactorEnabled) return res.status(401).json({ error: 'Please log in again.' });
  // Channel chosen at the password step (follows the identifier used, or the
  // admin-pinned channel) — falls back to the account's own method.
  const method = ['email', 'sms'].includes(payload.chan) ? payload.chan : user.twoFactorMethod;
  if (method !== 'email' && method !== 'sms') {
    return res.status(400).json({ error: 'This account uses an authenticator app, not a sent code.' });
  }

  const code = generateOtp();
  db.update('users', user.id, {
    loginOtpHash: bcrypt.hashSync(code, 10),
    loginOtpExpires: Date.now() + OTP_TTL_MS,
  });
  let sentTo;
  try {
    sentTo = await deliverOtp(user, method, code, 'login');
  } catch (e) {
    console.error('[2fa-otp] send failed:', e.message);
    return res.status(502).json({ error: 'Could not send your code right now. Please try again.' });
  }
  if (!sentTo) {
    return res.status(400).json({ error: `No ${method === 'email' ? 'email address' : 'phone number'} on file, or it can't receive codes. Ask an admin, or use a backup code.` });
  }
  res.json({ ok: true, sentTo, method });
});

// ---- Login (step 2b): verify the second factor ----
// Accepts a TOTP code (authenticator method), an emailed/texted OTP
// (email/sms method), or a one-time backup code (any method).
router.post('/login/verify-2fa', (req, res) => {
  const { pendingToken, code, backupCode } = req.body;
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';
  if (!pendingToken) return res.status(400).json({ error: 'Missing session. Please log in again.' });

  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
    if (payload.purpose !== '2fa-pending') throw new Error('wrong purpose');
  } catch (e) {
    return res.status(401).json({ error: 'This verification step expired. Please log in again.' });
  }

  const user = db.findById('users', payload.id);
  if (!user || !user.twoFactorEnabled) return res.status(401).json({ error: 'Please log in again.' });

  const minutesLeft = checkLockout(user.email);
  if (minutesLeft !== null) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'locked-out', ip, userAgent });
    return res.status(429).json({ error: `Too many failed attempts. Please try again in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }

  const method = user.twoFactorMethod || 'totp';
  let ok = false;
  let usedBackupCode = null;
  let reason = 'ok-via-2fa';
  if (backupCode) {
    const hashes = user.backupCodeHashes || [];
    const idx = hashes.findIndex(h => bcrypt.compareSync(String(backupCode).trim(), h));
    if (idx !== -1) { ok = true; usedBackupCode = idx; reason = 'ok-via-backup-code'; }
  } else if (code) {
    if (method === 'email' || method === 'sms') {
      const notExpired = user.loginOtpHash && user.loginOtpExpires && Date.now() < user.loginOtpExpires;
      ok = !!notExpired && bcrypt.compareSync(String(code).trim(), user.loginOtpHash);
      reason = `ok-via-${method}-otp`;
    } else {
      ok = totp.verifyToken(user.twoFactorSecret, code);
    }
  }

  if (!ok) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'invalid-2fa-code', ip, userAgent });
    return res.status(401).json({ error: 'Incorrect code. Please try again.' });
  }

  const patch = {};
  if (usedBackupCode !== null) {
    patch.backupCodeHashes = (user.backupCodeHashes || []).filter((_, i) => i !== usedBackupCode);
  }
  // Burn a used email/SMS code so it can't be replayed.
  if (method === 'email' || method === 'sms') {
    patch.loginOtpHash = null;
    patch.loginOtpExpires = null;
  }
  if (Object.keys(patch).length) db.update('users', user.id, patch);

  logLogin({ userId: user.id, email: user.email, success: true, reason, ip, userAgent });
  res.json(finalizeLogin(res, user, payload.remember));
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ---- Switch active workspace (linked accounts) ----
// Moves this session to another of the SAME person's committee/group
// workspaces, with no password/2FA re-prompt: the person already authenticated
// at login, and the target must belong to their own person-group. After this,
// the session simply *is* that account — role, permissions, entity scope and
// nav all follow it, exactly as if they'd logged into it directly.
router.post('/switch/:id', requireAuth, (req, res) => {
  const current = db.findById('users', req.user.id);
  if (!current) return res.status(401).json({ error: 'Please log in again.' });
  const target = db.findById('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'That workspace no longer exists.' });
  // Only ever within one person's own group of linked accounts.
  if (primaryIdOf(target) !== primaryIdOf(current)) {
    return res.status(403).json({ error: 'You can only switch between your own workspaces.' });
  }
  if (Number(target.id) === Number(current.id)) {
    return res.json({ ok: true, id: target.id, role: target.role, entity: target.entity || null });
  }
  if (isDisabled(target)) return res.status(403).json({ error: 'That workspace has been switched off.' });
  // Reissue the session cookie as the target account, preserving the remaining
  // lifetime of the current session so a "remember me" login stays long-lived.
  const remainingSec = Math.max(60, (req.user.exp || 0) - Math.floor(Date.now() / 1000));
  const token = jwt.sign(
    { id: target.id, name: target.name, email: target.email, role: target.role, sv: target.sessionVersion || 0 },
    JWT_SECRET,
    { expiresIn: remainingSec }
  );
  res.cookie('token', token, cookieOptions(remainingSec * 1000));
  res.json({ ok: true, id: target.id, role: target.role, entity: target.entity || null });
});

router.get('/me', requireAuth, (req, res) => {
  const fresh = db.findById('users', req.user.id);
  if (!fresh) return res.status(401).json({ error: 'Account no longer exists.' });
  // If this person holds several committee/group workspaces under one login,
  // hand the shell the full set (with which one is active) so it can render the
  // switcher + per-entity nav. Empty for ordinary single-workspace accounts.
  const group = personGroup(fresh);
  const workspaces = group.length > 1
    ? group.map(u => ({ id: u.id, role: u.role, entity: u.entity || null, active: u.id === fresh.id }))
    : [];
  res.json({
    id: fresh.id, name: fresh.name, email: fresh.email, role: fresh.role,
    entity: fresh.entity || null, // committee/group scope — drives nav + workspace
    workspaces, // [] unless this person has 2+ linked committee/group workspaces
    // Unread inbox count — piggybacked here so the shell can badge the bell
    // without an extra round-trip on every page load.
    unreadNotifications: db.findAll('user_notifications', n =>
      Number(n.userId) === Number(fresh.id) && !n.readAt).length,
    // Named as a polling officer for an election that is confirmed or open —
    // shows "Polling Desk" in the menu (Elections).
    pollOfficer: db.findAll('elections', e => ['confirmed', 'open'].includes(e.status)
      && (e.officers || []).some(o => Number(o.userId) === primaryIdOf(fresh))).length > 0,
    permissions: fresh.permissions || [], twoFactorEnabled: !!fresh.twoFactorEnabled,
    twoFactorMethod: fresh.twoFactorMethod || (fresh.twoFactorEnabled ? 'totp' : null),
    phone: fresh.phone || '', hasPhone: !!fresh.phone,
    passkeys: (fresh.passkeys || []).map(p => ({
      id: p.id, deviceName: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
    })),
  });
});

// Applies a validated name/email/phone patch, handles the email-changed
// side effects (old-address notice, security notification, session-version
// bump), and reissues the requester's own session cookie so the change is
// reflected immediately without forcing a re-login. Shared by the direct
// (PUT /me) and step-up-confirmed (POST /me/confirm) paths below.
//
// sessionVersion is bumped here, from `user`'s *current* value, rather than
// being pre-computed and carried inside a pendingToken — the step-up flow
// can sit unconfirmed for up to 10 minutes, during which something else
// (e.g. an admin-assisted password reset) could have already bumped it; a
// stale precomputed value would silently undo that bump instead of stacking
// on top of it.
function applyProfileChange(req, res, user, patch, emailChanged, oldEmail) {
  if (emailChanged) patch.sessionVersion = (user.sessionVersion || 0) + 1;
  const updated = db.update('users', user.id, patch);
  if (emailChanged) {
    sendMail({
      to: oldEmail,
      subject: 'Your AOTC Track login email was changed',
      html: `<p>The login email on your AOTC Track account (${user.name}) was just changed from this address to <strong>${updated.email}</strong>.</p><p>If this was you, no action is needed. If it wasn't, contact another administrator immediately — password resets and account recovery will go to the new address from now on.</p>`,
    }).catch(err => console.error('[profile-email-change-notice]', err.message));
    logNotification({
      level: 'warning', source: 'security',
      message: `${updated.name}'s login email was changed (was ${oldEmail}, now ${updated.email}).`,
    });
  }
  const remainingSec = Math.max(60, (req.user.exp || 0) - Math.floor(Date.now() / 1000));
  const token = jwt.sign(
    { id: updated.id, name: updated.name, email: updated.email, role: updated.role, sv: updated.sessionVersion || 0 },
    JWT_SECRET,
    { expiresIn: remainingSec }
  );
  res.cookie('token', token, cookieOptions(remainingSec * 1000));
  res.json(safeUser(updated));
}

// Verifies a 2FA-style code for a step-up confirmation (not a full login).
// Same rules as the login second factor — TOTP, a backup code, or a
// previously-sent OTP — but uses its own stepUpOtpHash slot rather than
// loginOtpHash, so a step-up confirmation in flight can never collide with
// an actual login 2FA attempt happening on the same account at the same time.
function verifyStepUpCode(user, { code, backupCode }) {
  if (backupCode) {
    const hashes = user.backupCodeHashes || [];
    const idx = hashes.findIndex(h => bcrypt.compareSync(String(backupCode).trim(), h));
    return idx === -1 ? { ok: false } : { ok: true, usedBackupCode: idx };
  }
  if (!code) return { ok: false };
  const method = user.twoFactorMethod || 'email';
  if (method === 'totp') {
    return { ok: totp.verifyToken(user.twoFactorSecret, code) };
  }
  const notExpired = user.stepUpOtpHash && user.stepUpOtpExpires && Date.now() < user.stepUpOtpExpires;
  return { ok: !!notExpired && bcrypt.compareSync(String(code).trim(), user.stepUpOtpHash) };
}

// Builds and validates the intended name/email/phone patch, without writing
// it anywhere. Returns { patch, emailChanged, oldEmail } or throws a
// { status, error } object the route can respond with directly.
function buildProfilePatch(user, { name, email, phone }) {
  const patch = {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw { status: 400, error: 'Name cannot be empty.' };
    patch.name = trimmed;
  }
  let emailChanged = false;
  if (email !== undefined) {
    const trimmed = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw { status: 400, error: 'Please enter a valid email address.' };
    }
    const clash = db.findOne('users', u => u.id !== user.id && u.email.toLowerCase() === trimmed);
    if (clash) throw { status: 409, error: 'Another account already uses that email.' };
    if (trimmed !== user.email.toLowerCase()) emailChanged = true;
    patch.email = trimmed;
  }
  let phoneChanged = false;
  if (phone !== undefined) {
    const trimmed = String(phone).trim();
    if (trimmed !== (user.phone || '')) phoneChanged = true;
    patch.phone = trimmed;
  }
  return { patch, emailChanged, phoneChanged };
}

// ---- Self-service profile edit (My Account) ----
// Anyone logged in can fix their own name/email/phone here — e.g. adding a
// phone number so SMS 2FA becomes available. Deliberately separate from
// PUT /users/:id (the Staff-page endpoint): that one is staff.manage-only
// and now refuses to touch another admin's account at all, so an admin
// (including the original seed admin) can only ever change their own
// identity through this route — never have it changed by a different admin.
//
// Changing the login email is dangerous if a mere stolen session (not the
// actual password) is enough to do it: the login email is exactly what
// "Forgot password" trusts, so hijacking it silently would hand an attacker
// a persistent, self-service way back in even after a password reset. So
// this route requires the current password to make *any* change, and an
// email change additionally notifies the old address, logs a security
// notification, and signs out every other active session.
//
// For the seed admin specifically, an email or phone change goes further:
// the password check alone doesn't help against an attacker who already has
// the real password, so instead of applying immediately, we send a step-up
// code to whichever 2FA channel is currently on file and hand back a
// pendingToken — the change only lands once POST /me/confirm verifies that
// code. The code always goes to the *current* channel, never the new one
// being switched to, since the point is proving you still control the old
// one before letting it be replaced.
router.put('/me', requireAuth, async (req, res) => {
  const user = db.findById('users', req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  const { name, email, phone, currentPassword } = req.body;
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  let built;
  try {
    built = buildProfilePatch(user, { name, email, phone });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.error || 'Invalid request.' });
  }
  const { patch, emailChanged, phoneChanged } = built;

  if (user.id === SEED_ADMIN_ID && (emailChanged || phoneChanged)) {
    const pendingToken = jwt.sign(
      { id: user.id, purpose: 'profile-change-pending', patch },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const method = user.twoFactorMethod || 'email';
    if (method === 'totp') {
      return res.json({ confirmationRequired: true, pendingToken, method });
    }
    const code = generateOtp();
    db.update('users', user.id, { stepUpOtpHash: bcrypt.hashSync(code, 10), stepUpOtpExpires: Date.now() + OTP_TTL_MS });
    let sentTo;
    try {
      sentTo = await deliverOtp(user, method, code, 'setup');
    } catch (e) {
      console.error('[profile-step-up] send failed:', e.message);
      return res.status(502).json({ error: 'Could not send a confirmation code right now. Please try again.' });
    }
    if (!sentTo) {
      return res.status(400).json({ error: `No ${method === 'email' ? 'email address' : 'phone number'} on file to send a confirmation code to. Ask another administrator for help.` });
    }
    return res.json({ confirmationRequired: true, pendingToken, method, sentTo });
  }

  applyProfileChange(req, res, user, patch, emailChanged, user.email);
});

// Second step of the seed-admin email/phone step-up flow — see PUT /me.
router.post('/me/confirm', requireAuth, (req, res) => {
  const { pendingToken, code, backupCode } = req.body;
  if (!pendingToken) return res.status(400).json({ error: 'Missing confirmation. Please try again.' });
  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
    if (payload.purpose !== 'profile-change-pending') throw new Error('wrong purpose');
  } catch (e) {
    return res.status(401).json({ error: 'This confirmation step expired. Please try again.' });
  }
  if (payload.id !== req.user.id) {
    return res.status(403).json({ error: 'This confirmation belongs to a different account.' });
  }
  const user = db.findById('users', payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });

  const result = verifyStepUpCode(user, { code, backupCode });
  if (!result.ok) {
    return res.status(401).json({ error: 'Incorrect code. Please try again.' });
  }
  // Burn the used code/backup code so it can't be replayed.
  const burn = { stepUpOtpHash: null, stepUpOtpExpires: null };
  if (result.usedBackupCode !== undefined && result.usedBackupCode !== null) {
    burn.backupCodeHashes = (user.backupCodeHashes || []).filter((_, i) => i !== result.usedBackupCode);
  }
  db.update('users', user.id, burn);

  const patch = payload.patch || {};
  const emailChanged = !!patch.email && patch.email !== user.email.toLowerCase();
  // Re-check the email is still free — it's been up to 10 minutes since
  // this was first validated, so someone else could theoretically have
  // taken it in the meantime.
  if (emailChanged) {
    const clash = db.findOne('users', u => u.id !== user.id && u.email.toLowerCase() === patch.email);
    if (clash) return res.status(409).json({ error: 'Another account has since taken that email. Please start again.' });
  }
  applyProfileChange(req, res, user, patch, emailChanged, user.email);
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.findById('users', req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const result = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!result.valid) {
    return res.status(400).json({ error: 'Password is not strong enough.', failedRules: result.failedRules });
  }
  // Bumping the session version here kicks out any other session on this
  // account (e.g. one an attacker is holding) — but that would also log out
  // *this* request's own cookie, so we immediately reissue a fresh token
  // carrying the new version to keep the person who just changed it signed in.
  const updated = bumpSessionVersion(user.id, { passwordHash: bcrypt.hashSync(newPassword, 10), mustChangePassword: false });
  const remainingSec = Math.max(60, (req.user.exp || 0) - Math.floor(Date.now() / 1000));
  const token = jwt.sign(
    { id: updated.id, name: updated.name, email: updated.email, role: updated.role, sv: updated.sessionVersion || 0 },
    JWT_SECRET,
    { expiresIn: remainingSec }
  );
  res.cookie('token', token, cookieOptions(remainingSec * 1000));
  res.json({ ok: true });
});

// ---- Forgot password (email-based reset link) ----
// No matter what the seed admin's login email currently says — including if
// an attacker changed it via PUT /auth/me after a full compromise — its
// reset link only ever goes to SEED_ADMIN_RECOVERY_EMAIL (declared above).
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const generic = { ok: true, message: "If that email is registered, we've sent a password reset link to it." };
  if (!email) return res.json(generic);
  const submitted = String(email).trim().toLowerCase();

  // Resolve the account normally (by whatever email is currently on file),
  // but also let the hardcoded recovery address itself resolve straight to
  // the seed admin — so that address works to recover that account even if
  // its login email was changed to something else in the meantime.
  let user = db.findOne('users', u => u.email.toLowerCase() === submitted);
  if (!user && submitted === SEED_ADMIN_RECOVERY_EMAIL.toLowerCase()) {
    user = db.findById('users', SEED_ADMIN_ID);
  }
  // A switched-off account gets no reset link (the same "check your email"
  // reply goes back either way, so this reveals nothing).
  if (user && isDisabled(user)) user = null;

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.update('users', user.id, {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    });
    const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resetLink = `${base.replace(/\/$/, '')}/reset-password.html?id=${user.id}&token=${rawToken}`;
    // For the seed admin, deliver to the hardcoded address regardless of
    // whatever user.email currently is — that's the entire point.
    const deliverTo = user.id === SEED_ADMIN_ID ? { ...user, email: SEED_ADMIN_RECOVERY_EMAIL } : user;
    sendPasswordResetEmail(deliverTo, resetLink).catch(err => console.error('[forgot-password]', err.message));
  }
  res.json(generic);
});

router.post('/reset-password', (req, res) => {
  const { id, token, newPassword } = req.body;
  if (!id || !token || !newPassword) return res.status(400).json({ error: 'Missing required fields.' });

  const user = db.findById('users', id);
  if (!user || !user.passwordResetTokenHash || !user.passwordResetExpiresAt) {
    return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
  }
  if (new Date(user.passwordResetExpiresAt) < new Date()) {
    return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
  }
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(user.passwordResetTokenHash))) {
    return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
  }
  const result = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!result.valid) {
    return res.status(400).json({ error: 'Password is not strong enough.', failedRules: result.failedRules });
  }
  // This link proves control of the account's registered email, so we treat
  // it as full account recovery, not just a password change: it also strips
  // any authenticator app/SMS setup and passkeys, and bumps the session
  // version to sign out every active session. That matters most when this is
  // the *only* way back into a compromised account (e.g. the sole admin) —
  // if an attacker had added their own 2FA method or passkey, leaving those
  // in place would lock the real owner right back out after they'd just
  // proven who they are. It re-anchors on email-code 2FA rather than
  // dropping to no 2FA at all — safe to do here specifically, since clicking
  // this link already proved control of that exact inbox.
  bumpSessionVersion(user.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    mustChangePassword: false,
    twoFactorEnabled: true, twoFactorMethod: 'email',
    twoFactorSecret: null, twoFactorTempSecret: null, twoFactorTempMethod: null,
    twoFactorTempOtpHash: null, twoFactorTempOtpExpires: null, backupCodeHashes: [],
    passkeys: [],
  });
  res.json({ ok: true });
});

// ---- Forgot login email (no SMTP-less fallback here; notifies admins) ----
router.post('/forgot-email', async (req, res) => {
  const { phone, name } = req.body;
  const generic = { ok: true, message: 'If we found a matching account, an administrator has been notified and will help you sign in.' };
  if (!phone) return res.json(generic);

  const user = db.findOne('users', u => (u.phone || '').replace(/\s+/g, '') === String(phone).replace(/\s+/g, ''));
  if (user) {
    const admins = db.findAll('users', u => u.role === 'admin');
    sendForgotEmailRequest({ user, requestedName: name || '', admins }).catch(err => console.error('[forgot-email]', err.message));
  }
  res.json(generic);
});

// Any logged-in user can see their own recent login activity (no staff.manage required).
router.get('/my-login-logs', requireAuth, (req, res) => {
  let logs = db.findAll('login_logs', l => l.userId === req.user.id);
  logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(logs.slice(0, 20));
});

// ---- Account activity (business actions: invoices, customers, products, job cards) ----
// Own activity — any logged-in user, same visibility rule as my-login-logs above.
router.get('/my-activity', requireAuth, (req, res) => {
  let logs = db.findAll('activity_logs', l => l.userId === req.user.id);
  logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(logs.slice(0, 100));
});

// Every staff account's activity — admin oversight, same gate as login-logs below.
router.get('/activity-logs', requireAuth, requirePermission('staff.manage'), (req, res) => {
  let logs = db.findAll('activity_logs');
  const { userId } = req.query;
  if (userId) logs = logs.filter(l => l.userId === Number(userId));
  logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(logs.slice(0, 300));
});

// ---- System notifications (SMS/email delivery failures, gateway account
// alerts, low-stock crossings, backup failures) — things that currently
// only ever printed to the server console. Admin-only: these are
// operational alerts about the business, not a per-user activity feed. ----
router.get('/notifications', requireAuth, requirePermission('staff.manage'), (req, res) => {
  let notes = db.findAll('notifications');
  notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notes.slice(0, 200));
});

router.post('/notifications/mark-read', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const unread = db.findAll('notifications', n => !n.readAt);
  const now = new Date().toISOString();
  unread.forEach(n => db.update('notifications', n.id, { readAt: now }));
  res.json({ ok: true, marked: unread.length });
});

// ---- Two-factor authentication ----
// Every account is required to have 2FA on at all times — email and SMS are
// the two accepted baseline channels (deliberately interchangeable, so
// someone who's lost access to one — inbox down, new phone — can switch to
// the other without ever dropping to zero factors). TOTP (an authenticator
// app) is available as an optional stronger method on top of that baseline.
// There is no "off" — only "change method", which reuses this same
// setup/enable handshake regardless of what method is currently active:
//   'totp'  — an authenticator app (Microsoft/Google Authenticator, Authy…)
//   'email' — a 6-digit code emailed at each login
//   'sms'   — a 6-digit code texted at each login
// Setup is a two-step handshake so we confirm the new channel actually works
// before switching over: /2fa/setup starts it, /2fa/enable confirms a code.
// Changing method requires the current password, since this is otherwise a
// quiet way for a hijacked session to redirect future codes to an attacker's
// own inbox/phone.
router.post('/2fa/setup', requireAuth, async (req, res) => {
  const { password } = req.body;
  const method = req.body.method || 'totp';
  const user = db.findById('users', req.user.id);
  if (!bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }

  if (method === 'totp') {
    const secret = totp.generateSecret();
    db.update('users', user.id, { twoFactorTempSecret: secret, twoFactorTempMethod: 'totp' });
    const otpauthUrl = totp.otpauthURL({ issuer: 'AOTC Track', accountName: user.email, secret });
    try {
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
      return res.json({ method, secret, otpauthUrl, qrCodeDataUrl });
    } catch (e) {
      // QR generation failing should never block setup — the secret can be typed in manually.
      return res.json({ method, secret, otpauthUrl, qrCodeDataUrl: null });
    }
  }

  if (method === 'email' || method === 'sms') {
    if (method === 'sms' && !user.phone) {
      return res.status(400).json({ error: 'Add a phone number to your account first (ask an admin), then set up SMS codes.' });
    }
    const code = generateOtp();
    db.update('users', user.id, {
      twoFactorTempMethod: method,
      twoFactorTempSecret: null,
      twoFactorTempOtpHash: bcrypt.hashSync(code, 10),
      twoFactorTempOtpExpires: Date.now() + OTP_TTL_MS,
    });
    let sentTo;
    try {
      sentTo = await deliverOtp(user, method, code, 'setup');
    } catch (e) {
      console.error('[2fa-setup] send failed:', e.message);
      return res.status(502).json({ error: 'Could not send a test code right now. Please try again.' });
    }
    if (!sentTo) {
      return res.status(400).json({ error: `Couldn't send a code to your ${method === 'email' ? 'email' : 'phone'}. Check it's on file and able to receive messages.` });
    }
    return res.json({ method, sentTo });
  }

  return res.status(400).json({ error: 'Unknown 2FA method.' });
});

router.post('/2fa/enable', requireAuth, (req, res) => {
  const { token } = req.body;
  const user = db.findById('users', req.user.id);
  const method = user.twoFactorTempMethod || (user.twoFactorTempSecret ? 'totp' : null);
  if (!method) return res.status(400).json({ error: 'Start setup again — nothing pending.' });

  let ok = false;
  if (method === 'totp') {
    ok = !!user.twoFactorTempSecret && totp.verifyToken(user.twoFactorTempSecret, token);
  } else if (method === 'email' || method === 'sms') {
    const notExpired = user.twoFactorTempOtpHash && user.twoFactorTempOtpExpires && Date.now() < user.twoFactorTempOtpExpires;
    ok = !!notExpired && bcrypt.compareSync(String(token || '').trim(), user.twoFactorTempOtpHash);
  }
  if (!ok) {
    const hint = method === 'totp' ? 'Check your authenticator app and try again.' : 'Check the code we sent and try again.';
    return res.status(400).json({ error: `Incorrect code. ${hint}` });
  }

  const backupCodes = totp.generateBackupCodes();
  const backupCodeHashes = backupCodes.map(c => bcrypt.hashSync(c, 10));
  db.update('users', user.id, {
    twoFactorEnabled: true,
    twoFactorMethod: method,
    twoFactorSecret: method === 'totp' ? user.twoFactorTempSecret : null,
    twoFactorTempSecret: null,
    twoFactorTempMethod: null,
    twoFactorTempOtpHash: null,
    twoFactorTempOtpExpires: null,
    backupCodeHashes,
  });
  res.json({ ok: true, method, backupCodes });
});

// Note: there is deliberately no /2fa/disable route. There's no "off" state
// to disable into — someone wanting a different channel (e.g. giving up
// their authenticator app for email/SMS, or switching email <-> SMS) just
// runs /2fa/setup + /2fa/enable again with the method they want; that flow
// already handles switching to/from any of the three methods at any time.

// ================= Passkeys / biometric login (WebAuthn) =================
// A passkey lets someone sign in with the phone's Face ID / fingerprint (or a
// laptop's Touch ID / Windows Hello) instead of typing a password. It's a
// public-key credential bound to this site and this device: the private key
// never leaves the device's secure hardware, and unlocking it requires the
// user's biometric — so a passkey is already two factors (device + biometric)
// and, per the product decision, a passkey login does NOT then ask for a TOTP
// code. Passwords still get the normal 2FA step.
//
// Storage: user.passkeys = [{ id, publicKey, counter, transports, deviceName,
// createdAt, lastUsedAt }], id/publicKey base64url-encoded strings.

function findUserByPasskeyId(credId) {
  return db.findOne('users', u => (u.passkeys || []).some(p => p.id === credId));
}

// Step 1 of enrolment: hand the browser a challenge + params. Auth required —
// you enrol a device only while already logged in.
router.post('/passkey/register/options', requireAuth, async (req, res) => {
  const user = db.findById('users', req.user.id);
  const { rpName, rpID, origin } = webauthn.getRP(req);
  try {
    const options = await webauthn.generateRegistrationOptions({
      rpName,
      rpID,
      userID: Buffer.from(String(user.id)),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: (user.passkeys || []).map(p => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    setChallengeCookie(res, 'wa_reg', { purpose: 'wa-reg', uid: user.id, challenge: options.challenge, origin, rpID });
    res.json(options);
  } catch (e) {
    console.error('[passkey] register options failed:', e.message);
    res.status(500).json({ error: 'Could not start passkey setup.' });
  }
});

// Step 2 of enrolment: verify the attestation and store the credential.
router.post('/passkey/register/verify', requireAuth, async (req, res) => {
  const user = db.findById('users', req.user.id);
  const chal = readChallengeCookie(req, 'wa_reg', 'wa-reg');
  res.clearCookie('wa_reg');
  if (!chal || chal.uid !== user.id) {
    return res.status(400).json({ error: 'Setup expired. Please try again.' });
  }
  try {
    const verification = await webauthn.verifyRegistrationResponse({
      response: req.body.attResp,
      expectedChallenge: chal.challenge,
      expectedOrigin: chal.origin,
      expectedRPID: chal.rpID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Could not verify this device. Please try again.' });
    }
    const cred = verification.registrationInfo.credential;
    const passkeys = user.passkeys || [];
    if (passkeys.some(p => p.id === cred.id)) {
      return res.status(409).json({ error: 'This device is already set up.' });
    }
    const deviceName = String(req.body.deviceName || '').trim().slice(0, 40) || 'This device';
    passkeys.push({
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: cred.counter || 0,
      transports: cred.transports || req.body.attResp?.response?.transports || [],
      deviceName,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    db.update('users', user.id, { passkeys });
    res.json({ ok: true, passkey: { id: cred.id, deviceName, createdAt: passkeys[passkeys.length - 1].createdAt } });
  } catch (e) {
    console.error('[passkey] register verify failed:', e.message);
    res.status(400).json({ error: 'Could not verify this device. Please try again.' });
  }
});

router.get('/passkey/list', requireAuth, (req, res) => {
  const user = db.findById('users', req.user.id);
  res.json({
    passkeys: (user.passkeys || []).map(p => ({
      id: p.id, deviceName: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
    })),
  });
});

router.delete('/passkey/:id', requireAuth, (req, res) => {
  const user = db.findById('users', req.user.id);
  const passkeys = user.passkeys || [];
  const next = passkeys.filter(p => p.id !== req.params.id);
  if (next.length === passkeys.length) return res.status(404).json({ error: 'Passkey not found.' });
  db.update('users', user.id, { passkeys: next });
  res.json({ ok: true });
});

// Login step 1: hand the browser a challenge. allowCredentials is left empty so
// the browser offers whatever discoverable passkeys it holds for this site —
// the user just taps and authenticates with Face ID / fingerprint, no email
// typed. No auth here (this IS the login).
router.post('/passkey/login/options', async (req, res) => {
  const { rpID, origin } = webauthn.getRP(req);
  try {
    const options = await webauthn.generateAuthenticationOptions({
      rpID,
      allowCredentials: [],
      userVerification: 'preferred',
    });
    setChallengeCookie(res, 'wa_auth', {
      purpose: 'wa-auth', challenge: options.challenge, origin, rpID, remember: !!req.body.remember,
    });
    res.json(options);
  } catch (e) {
    console.error('[passkey] login options failed:', e.message);
    res.status(500).json({ error: 'Could not start biometric sign-in.' });
  }
});

// Login step 2: verify the assertion, find the owning user, issue the session.
router.post('/passkey/login/verify', async (req, res) => {
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';
  const chal = readChallengeCookie(req, 'wa_auth', 'wa-auth');
  res.clearCookie('wa_auth');
  if (!chal) return res.status(400).json({ error: 'Sign-in expired. Please try again.' });

  const authResp = req.body.authResp;
  if (!authResp || !authResp.id) return res.status(400).json({ error: 'No passkey provided.' });

  const user = findUserByPasskeyId(authResp.id);
  const passkey = user && (user.passkeys || []).find(p => p.id === authResp.id);
  if (!user || !passkey) {
    logLogin({ userId: null, email: null, success: false, reason: 'passkey-unknown', ip, userAgent });
    return res.status(401).json({ error: 'This passkey isn\'t recognised. Sign in with your password.' });
  }
  if (isDisabled(user)) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'account-disabled', ip, userAgent });
    return res.status(403).json({ error: DISABLED_MESSAGE, disabled: true });
  }

  const minutesLeft = checkLockout(user.email);
  if (minutesLeft !== null) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'locked-out', ip, userAgent });
    return res.status(429).json({ error: `Too many failed attempts. Please try again in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }

  try {
    const verification = await webauthn.verifyAuthenticationResponse({
      response: authResp,
      expectedChallenge: chal.challenge,
      expectedOrigin: chal.origin,
      expectedRPID: chal.rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter || 0,
        transports: passkey.transports || [],
      },
    });
    if (!verification.verified) {
      logLogin({ userId: user.id, email: user.email, success: false, reason: 'passkey-failed', ip, userAgent });
      return res.status(401).json({ error: 'Biometric sign-in failed. Please try again.' });
    }
    // Bump the signature counter (clone/replay detection) and stamp last use.
    const passkeys = user.passkeys.map(p => p.id === passkey.id
      ? { ...p, counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() }
      : p);
    db.update('users', user.id, { passkeys });

    // A forced password change (new account, or an admin/self reset) must
    // hold here too — otherwise a passkey would bypass it entirely, since
    // this is a separate login path from the password form that normally
    // enforces it.
    if (user.mustChangePassword) {
      const pendingToken = jwt.sign({ id: user.id, purpose: 'password-change-required', remember: !!chal.remember }, JWT_SECRET, { expiresIn: '10m' });
      logLogin({ userId: user.id, email: user.email, success: false, reason: 'must-change-password', ip, userAgent });
      return res.json({ mustChangePassword: true, pendingToken });
    }

    logLogin({ userId: user.id, email: user.email, success: true, reason: 'ok-via-passkey', ip, userAgent });
    res.json(finalizeLogin(res, user, chal.remember));
  } catch (e) {
    console.error('[passkey] login verify failed:', e.message);
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'passkey-error', ip, userAgent });
    res.status(400).json({ error: 'Biometric sign-in failed. Please try again.' });
  }
});

// ---- Permission catalog (for building the staff permissions UI) ----
router.get('/permissions', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const { SENSITIVE_PERMISSIONS } = require('../middleware/auth');
  res.json({ permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULT_PERMISSIONS, sensitive: SENSITIVE_PERMISSIONS, sessionRoles: SESSION_ROLE_PRESETS });
});

// Two rules on every change to someone's permissions (Oct 2026):
//  1. A SENSITIVE permission (middleware/auth.js) may be granted or removed
//     only by the admin tier. Before this, anyone with staff.manage could hand
//     out the Session Clerk's approvals, money sign-off, and so on.
//  2. Nobody below the admin tier changes their OWN permissions — on any of
//     their own accounts (a person's workspaces are linked accounts).
// Returns an error message, or null when the change is allowed.
function permissionChangeError(req, target, before, after) {
  if (['admin', 'localadmin'].includes(req.user.role)) return null;
  const { SENSITIVE_PERMISSIONS } = require('../middleware/auth');
  const b = new Set(before || []), a = new Set(after || []);
  const changed = [...new Set([...b, ...a])].filter(p => b.has(p) !== a.has(p));
  if (!changed.length) return null;
  const me = db.findById('users', req.user.id) || {};
  const myRoot = Number(me.linkedTo || me.id);
  if (target && Number(target.linkedTo || target.id) === myRoot) {
    return 'You cannot change your own permissions. Ask an administrator.';
  }
  const sens = changed.filter(p => SENSITIVE_PERMISSIONS.includes(p));
  if (sens.length) {
    return `Only an administrator can grant or remove: ${sens.map(p => PERMISSIONS[p] || p).join('; ')}.`;
  }
  return null;
}

// ---- Login activity log (admin / staff.manage) ----
router.get('/login-logs', requireAuth, requirePermission('staff.manage'), (req, res) => {
  let logs = db.findAll('login_logs');
  const { userId } = req.query;
  if (userId) logs = logs.filter(l => l.userId === Number(userId));
  logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(logs.slice(0, 300));
});

// ---- Admin: manage staff accounts ----
router.get('/users', requireAuth, requirePermission('staff.manage'), (req, res) => {
  res.json(db.findAll('users').map(safeUser));
});

router.post('/users', requireAuth, requirePermission('staff.manage'), (req, res) => {
  let { name, email, password, role, permissions, phone, entity, position } = req.body;
  // AOTC Track: attaching to "The Session" — the chosen Session office (sent as
  // sessionRole) decides the account role, the permission bundle and the title.
  // Resolve it up front so the usual role/permission validation below applies to
  // the real values (sensitive presets therefore stay admin-only to assign).
  if (entity && entity.type === 'session') {
    const preset = resolveSessionPreset(req.body.sessionRole || role);
    if (!preset) return res.status(400).json({ error: 'Choose a Session role.' });
    role = preset.role;
    permissions = preset.permissions.slice();
    if (!position) position = preset.position;
    entity = { type: 'session', id: 0 };
  }
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password, and role are required.' });
  }
  if (!require('../middleware/auth').ROLES.includes(role)) {
    return res.status(400).json({ error: 'That is not a valid access level.' });
  }
  // Only a real admin may create another admin, or hand out the
  // admin-equivalent staff.manage right (staff.manage can be granted to
  // non-admins, but such a holder must not be able to mint new admins).
  // Admin tier = admin + localadmin. Control flows down, never up: only a
  // real admin can create admin-tier accounts (a Local Admin cannot mint
  // another Local Admin or an Admin).
  const ADMIN_TIER = ['admin', 'localadmin'];
  const callerIsAdmin = req.user.role === 'admin';
  if (ADMIN_TIER.includes(role) && !callerIsAdmin) {
    return res.status(403).json({ error: 'Only an administrator can create an admin-level account.' });
  }
  if (Array.isArray(permissions) && permissions.includes('staff.manage') && !callerIsAdmin) {
    return res.status(403).json({ error: 'Only an administrator can grant staff-management access.' });
  }
  {
    const want = Array.isArray(permissions) ? permissions : (ROLE_DEFAULT_PERMISSIONS[role] || []);
    const err = permissionChangeError(req, null, [], want);
    if (err) return res.status(403).json({ error: err });
  }
  if (db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }
  const result = validatePassword(password, { email, name });
  if (!result.valid) {
    return res.status(400).json({ error: 'Password is not strong enough.', failedRules: result.failedRules });
  }
  // AOTC Track: committees with a special module grant its permission
  // automatically (M&E -> visitors, CFL -> counselling, Harvest -> fundraising,
  // Finance -> finance.quarterly).
  let grantedPerms = Array.isArray(permissions) ? permissions : (ROLE_DEFAULT_PERMISSIONS[role] || []);
  if (entity && entity.type === 'committee') {
    const com = db.findById('committees', Number(entity.id));
    const SPECIAL_PERM = { visitors: 'visitors.manage', counselling: 'counselling.manage', fundraising: 'fundraising.manage', finance: 'finance.quarterly' };
    if (com && com.special && SPECIAL_PERM[com.special] && !grantedPerms.includes(SPECIAL_PERM[com.special])) {
      grantedPerms = [...grantedPerms, SPECIAL_PERM[com.special]];
    }
  }
  const user = db.insert('users', {
    name, email, role, phone: phone || '',
    // Church position/title (Chairperson, Secretary, Coordinator...) — display
    // only; access is governed by role + permissions, never by position.
    position: typeof position === 'string' ? position.trim() : '',
    // AOTC Track: committee/group accounts are scoped to their entity
    // ({ type: 'committee'|'group'|'congregation', id }); admins/viewers
    // may leave this null.
    entity: entity && entity.type ? { type: entity.type, id: Number(entity.id) } : null,
    permissions: grantedPerms,
    passwordHash: bcrypt.hashSync(password, 10),
    // Every staff account gets email-code 2FA on by default — nobody logs in
    // with just a password. This is a floor, not the ceiling: the account
    // holder can upgrade to an authenticator app or passkey any time from
    // My Account, which replaces this default (see /2fa/enable).
    twoFactorEnabled: true,
    twoFactorMethod: 'email',
    mustChangePassword: true, // the admin-set password is temporary — force a change on first login
  });
  res.status(201).json(safeUser(user));
});

// ---- Access requests (Coordinator proposes -> Admin / Session Clerk approves) ----
// The Reporting Coordinator (users.request) captures a would-be user's details
// and submits them. An administrator OR the Session Clerk reviews, sets an
// initial password, and on approval the account is created and the login
// details are sent by SMS + email. Admin accounts can NEVER be created this way.
const accessApprover = [requireAuth, requireAnyPermission('staff.manage', 'approvals.manage')];
function canApproveAccess(req) {
  if (['admin', 'localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  const perms = u.permissions || [];
  return perms.includes('staff.manage') || perms.includes('approvals.manage');
}
function actorName(req) {
  return (db.findById('users', req.user.id) || {}).name || 'Unknown';
}

// Normalise the assignments array a request carries (each = an entity + access
// level + position). Falls back to the old single-entity fields.
function normalizeAssignments(body) {
  let list = Array.isArray(body.assignments) ? body.assignments : [];
  if (!list.length && body.role) list = [{ role: body.role, position: body.position, entity: body.entity }];
  return list.map(a => ({
    role: a.role,
    position: typeof a.position === 'string' ? a.position.trim() : '',
    entity: a.entity && a.entity.type ? { type: a.entity.type, id: Number(a.entity.id) } : null,
  })).filter(a => a.role);
}

// Create a linked "workspace" account (another committee/group) under a primary
// person — mirrors POST /users/:id/workspaces. Returns {ws} on success,
// {skipped:true} if the person already holds that entity, {error} otherwise.
function insertLinkedWorkspace(root, entity, role, position) {
  const isSession = entity && entity.type === 'session';
  if (!entity || (!isSession && (!['committee', 'group'].includes(entity.type) || !entity.id))) {
    return { error: 'Choose a committee, a group, or the Session.' };
  }
  let entRec, grantedPerms;
  if (isSession) {
    // For a Session attach, `role` carries the chosen Session office (preset id).
    const preset = resolveSessionPreset(role);
    if (!preset) return { error: 'Choose a Session role.' };
    role = preset.role;
    position = position || preset.position;
    grantedPerms = preset.permissions.slice().filter(p => p !== 'staff.manage');
    entity = { type: 'session', id: 0 };
    entRec = { name: 'The Session' };
  } else {
    if (!ROLES.includes(role) || ['admin', 'localadmin'].includes(role)) return { error: 'Invalid access level for a workspace.' };
    const coll = entity.type === 'committee' ? 'committees' : 'groups';
    entRec = db.findById(coll, Number(entity.id));
    if (!entRec) return { error: 'That committee or group no longer exists.' };
    grantedPerms = (ROLE_DEFAULT_PERMISSIONS[role] || []).slice().filter(p => p !== 'staff.manage');
    if (entity.type === 'committee' && entRec.special) {
      const SPECIAL_PERM = { visitors: 'visitors.manage', counselling: 'counselling.manage', fundraising: 'fundraising.manage', finance: 'finance.quarterly' };
      const sp = SPECIAL_PERM[entRec.special];
      if (sp && !grantedPerms.includes(sp)) grantedPerms.push(sp);
    }
  }
  const dup = personGroup(root).find(u => u.entity && u.entity.type === entity.type && Number(u.entity.id) === Number(entity.id));
  if (dup) return { skipped: true };
  const baseEmail = String(root.email || `user${root.id}@aotc.local`);
  const at = baseEmail.lastIndexOf('@');
  const localp = at > 0 ? baseEmail.slice(0, at) : baseEmail;
  const domain = at > 0 ? baseEmail.slice(at + 1) : 'aotc.local';
  let candidate = `${localp}+${entity.type}${entity.id}@${domain}`;
  let n = 2;
  while (db.findOne('users', u => u.email.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${localp}+${entity.type}${entity.id}-${n}@${domain}`; n++;
  }
  const ws = db.insert('users', {
    name: root.name, email: candidate, role, phone: '',
    position: typeof position === 'string' ? position.trim() : '',
    entity: { type: entity.type, id: Number(entity.id) },
    permissions: grantedPerms,
    passwordHash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
    twoFactorEnabled: false, mustChangePassword: false, linkedTo: root.id,
  });
  return { ws };
}

// Minimal directory of existing people (primary, non-admin accounts) for the
// "add a committee/group to an existing person" picker — includes the entities
// each already holds so the requester can avoid duplicates.
router.get('/access-people', requireAuth, requireAnyPermission('users.request', 'staff.manage', 'approvals.manage'), (req, res) => {
  const primaries = db.findAll('users', u => !u.linkedTo && !['admin', 'localadmin'].includes(u.role));
  res.json(primaries.map(u => ({
    id: u.id, name: u.name, email: u.email,
    entities: personGroup(u).map(x => x.entity).filter(Boolean),
  })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

router.post('/access-requests', requireAuth, requireAnyPermission('users.request', 'staff.manage'), (req, res) => {
  const kind = req.body.kind === 'add-workspace' ? 'add-workspace' : 'new-user';
  const notes = String(req.body.notes || '').trim();
  const who = actorName(req);
  const assignments = normalizeAssignments(req.body);
  if (!assignments.length) return res.status(400).json({ error: 'Add at least one committee/group with an access level.' });
  for (const a of assignments) {
    if (!ROLES.includes(a.role) || ['admin', 'localadmin'].includes(a.role)) {
      return res.status(400).json({ error: 'Choose a valid, non-admin access level for each assignment.' });
    }
  }

  if (kind === 'add-workspace') {
    const target = db.findById('users', Number(req.body.targetUserId));
    if (!target) return res.status(400).json({ error: 'Choose the existing person to add a committee/group for.' });
    const root = db.findById('users', primaryIdOf(target)) || target;
    if (['admin', 'localadmin'].includes(root.role)) {
      return res.status(400).json({ error: 'Administrators already have access to every committee and group.' });
    }
    for (const a of assignments) if (!a.entity) return res.status(400).json({ error: 'Each added workspace must be a committee or group.' });
    const rec = db.insert('access_requests', {
      kind, targetUserId: root.id, targetName: root.name, name: root.name, email: root.email || '',
      assignments, notes, status: 'pending', requestedBy: who, requestedById: req.user.id,
    });
    notifyApprovers('Workspace request awaiting approval',
      `${who} requested additional committee/group access for ${root.name}. Approve or decline on the Access Requests page.`,
      req.user.id, '/access.html');
    return res.json({ pending: true, request: rec });
  }

  // new-user
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  for (let i = 1; i < assignments.length; i++) if (!assignments[i].entity) return res.status(400).json({ error: 'Each additional committee/group needs an entity selected.' });
  if (db.findOne('users', u => u.email && u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }
  if (db.findOne('access_requests', r => r.kind !== 'add-workspace' && r.status === 'pending' && r.email && r.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A request for that email is already awaiting approval.' });
  }
  const rec = db.insert('access_requests', {
    kind: 'new-user', name, email, phone, assignments,
    role: assignments[0].role, position: assignments[0].position, entity: assignments[0].entity,
    notes, status: 'pending', requestedBy: who, requestedById: req.user.id,
  });
  notifyApprovers('Access request awaiting approval',
    `${who} requested platform access for ${name}. Approve or decline on the Access Requests page.`,
    req.user.id, '/access.html');
  res.json({ pending: true, request: rec });
});

// Approvers see every request; a proposer sees only their own.
router.get('/access-requests', requireAuth, (req, res) => {
  let list = db.findAll('access_requests');
  if (!canApproveAccess(req)) list = list.filter(r => Number(r.requestedById) === Number(req.user.id));
  if (req.query.status) list = list.filter(r => r.status === req.query.status);
  res.json(list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.post('/access-requests/:id/approve', ...accessApprover, async (req, res) => {
  const rec = db.findById('access_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending request found.' });
  const who = actorName(req);
  const assignments = (Array.isArray(rec.assignments) && rec.assignments.length)
    ? rec.assignments : [{ role: rec.role, position: rec.position, entity: rec.entity }];
  for (const a of assignments) {
    if (!ROLES.includes(a.role) || ['admin', 'localadmin'].includes(a.role)) {
      return res.status(400).json({ error: 'This request cannot be approved into that access level — decline it and create the account directly.' });
    }
  }

  // ---- Add committee/group to an existing person (no new login, no password) ----
  if (rec.kind === 'add-workspace') {
    const target = db.findById('users', Number(rec.targetUserId));
    const root = target ? db.findById('users', primaryIdOf(target)) : null;
    if (!root) return res.status(404).json({ error: 'That person no longer exists — decline this request.' });
    let linked = 0, skipped = 0;
    for (const a of assignments) {
      if (!a.entity) continue;
      const r = insertLinkedWorkspace(root, a.entity, a.role, a.position);
      if (r && r.ws) linked++; else if (r && r.skipped) skipped++;
    }
    db.update('access_requests', rec.id, { status: 'approved', decidedBy: who, decidedAt: new Date().toISOString() });
    notifyUser(db.findById('users', rec.requestedById), 'Workspace request approved',
      `${linked} committee/group workspace${linked === 1 ? '' : 's'} added for ${root.name} by ${who}${skipped ? ` (${skipped} already held)` : ''}.`, { url: '/access.html' });
    return res.json({ ok: true, linked, skipped });
  }

  // ---- New person: create the primary account + any extra linked workspaces ----
  const primary = assignments[0];
  if (db.findOne('users', u => u.email && u.email.toLowerCase() === rec.email.toLowerCase())) {
    db.update('access_requests', rec.id, { status: 'declined', decidedBy: who, decidedAt: new Date().toISOString(), reason: 'A user with this email already exists.' });
    return res.status(409).json({ error: `A user with ${rec.email} already exists — the request was closed.` });
  }
  const password = String(req.body.password || '');
  const result = validatePassword(password, { email: rec.email, name: rec.name });
  if (!result.valid) return res.status(400).json({ error: 'The initial password is not strong enough.', failedRules: result.failedRules });

  // Permissions = the role's defaults (+ any special committee module), never staff.manage via this path.
  let grantedPerms = (ROLE_DEFAULT_PERMISSIONS[primary.role] || []).filter(p => p !== 'staff.manage');
  if (primary.entity && primary.entity.type === 'committee') {
    const com = db.findById('committees', Number(primary.entity.id));
    const SPECIAL_PERM = { visitors: 'visitors.manage', counselling: 'counselling.manage', fundraising: 'fundraising.manage', finance: 'finance.quarterly' };
    if (com && com.special && SPECIAL_PERM[com.special] && !grantedPerms.includes(SPECIAL_PERM[com.special])) {
      grantedPerms = [...grantedPerms, SPECIAL_PERM[com.special]];
    }
  }
  const user = db.insert('users', {
    name: rec.name, email: rec.email, role: primary.role, phone: rec.phone || '',
    position: primary.position || '',
    entity: primary.entity && primary.entity.type ? { type: primary.entity.type, id: Number(primary.entity.id) } : null,
    permissions: grantedPerms,
    passwordHash: bcrypt.hashSync(password, 10),
    twoFactorEnabled: true, twoFactorMethod: 'email',
    mustChangePassword: true, // the admin-set password is temporary — force a change on first login
  });
  // Extra committees/groups become linked workspaces under this new person.
  let linked = 0;
  for (let i = 1; i < assignments.length; i++) {
    const a = assignments[i];
    if (!a.entity) continue;
    const r = insertLinkedWorkspace(user, a.entity, a.role, a.position);
    if (r && r.ws) linked++;
  }
  db.update('access_requests', rec.id, { status: 'approved', decidedBy: who, decidedAt: new Date().toISOString(), createdUserId: user.id });

  // Send the initial login details by SMS + email (both live once SMTP is set).
  const base = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const loginUrl = base + '/login.html';
  const smsMsg = `PCG-AOTC Track: An account has been created for you. Sign in at ${loginUrl} with email ${rec.email} and temporary password '${password}' — you'll be asked to change it on first login.`;
  try { if (rec.phone) await sendSms({ to: rec.phone, message: smsMsg }); } catch (e) {}
  try {
    if (rec.email) await sendMail({
      to: rec.email,
      subject: 'AOTC Track — your account is ready',
      html: `<p>Hello ${rec.name},</p><p>An account has been created for you on AOTC Track.</p>`
        + `<p><b>Sign in:</b> <a href="${loginUrl}">${loginUrl}</a><br><b>Email:</b> ${rec.email}<br><b>Temporary password:</b> '${password}'</p>`
        + `<p>For your security you'll be asked to set your own password the first time you log in.</p>`,
    });
  } catch (e) {}

  notifyUser(db.findById('users', rec.requestedById), 'Access request approved',
    `The account for ${rec.name} was approved by ${who} and their login details have been sent.`, { url: '/access.html' });
  res.json({ ok: true, user: safeUser(user), linked });
});

router.post('/access-requests/:id/decline', ...accessApprover, (req, res) => {
  const rec = db.findById('access_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending request found.' });
  const who = actorName(req);
  const reason = String(req.body.reason || '').trim();
  db.update('access_requests', rec.id, { status: 'declined', decidedBy: who, decidedAt: new Date().toISOString(), reason });
  notifyUser(db.findById('users', rec.requestedById), 'Access request declined',
    `Your access request for ${rec.name} was declined by ${who}${reason ? ': ' + reason : '.'}`, { url: '/access.html' });
  res.json({ ok: true });
});

// ---- Add a linked workspace (another committee/group) to a person ----
// Attaches a second (third, …) committee/group to an existing person, under
// their ONE login. The new record is entity-scoped with its own role,
// permissions and position, but has no direct credentials — it's reachable
// only by switching from the primary session (POST /switch). Admins/Local
// Admins already see every entity, so workspaces don't apply to them.
router.post('/users/:id/workspaces', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const asked = db.findById('users', req.params.id);
  if (!asked) return res.status(404).json({ error: 'Person not found.' });
  // Always attach to the group's PRIMARY — never nest a workspace under a workspace.
  const rootId = primaryIdOf(asked);
  const root = db.findById('users', rootId);
  if (!root) return res.status(404).json({ error: 'Person not found.' });
  if (['admin', 'localadmin'].includes(root.role)) {
    return res.status(400).json({ error: 'Admin accounts already have access to every committee and group.' });
  }

  let { entity, role, permissions, position } = req.body;
  const isSession = entity && entity.type === 'session';
  if (!entity || (!isSession && (!['committee', 'group'].includes(entity.type) || !entity.id))) {
    return res.status(400).json({ error: 'Choose a committee, a group, or the Session for this workspace.' });
  }
  const ROLES = require('../middleware/auth').ROLES;
  let wsRole, entRec, grantedPerms;
  if (isSession) {
    // `role` carries the chosen Session office (preset id); it sets the account
    // role, the permission bundle and the title.
    const preset = resolveSessionPreset(role);
    if (!preset) return res.status(400).json({ error: 'Choose a Session role for this workspace.' });
    wsRole = preset.role;
    position = position || preset.position;
    grantedPerms = preset.permissions.slice().filter(p => p !== 'staff.manage');
    entity = { type: 'session', id: 0 };
    entRec = { name: 'The Session' };
  } else {
    wsRole = role || 'secretary';
    if (!ROLES.includes(wsRole) || ['admin', 'localadmin'].includes(wsRole)) {
      return res.status(400).json({ error: 'That is not a valid access level for a workspace.' });
    }
    const coll = entity.type === 'committee' ? 'committees' : 'groups';
    entRec = db.findById(coll, Number(entity.id));
    if (!entRec) return res.status(400).json({ error: 'That committee or group no longer exists.' });
    // Permissions: caller-supplied, else the role's defaults; never staff.manage
    // on a scoped hat; plus the committee's special-module grant.
    grantedPerms = (Array.isArray(permissions) ? permissions : (ROLE_DEFAULT_PERMISSIONS[wsRole] || [])).slice().filter(p => p !== 'staff.manage');
  }

  // No duplicate: a person can't hold two workspaces on the same entity.
  const dup = personGroup(root).find(u =>
    u.entity && u.entity.type === entity.type && Number(u.entity.id) === Number(entity.id));
  if (dup) return res.status(409).json({ error: `${root.name} is already attached to ${entRec.name}.` });

  {
    const err = permissionChangeError(req, root, [], grantedPerms);
    if (err) return res.status(403).json({ error: err });
  }
  if (!isSession && entity.type === 'committee' && entRec.special) {
    const SPECIAL_PERM = { visitors: 'visitors.manage', counselling: 'counselling.manage', fundraising: 'fundraising.manage', finance: 'finance.quarterly' };
    const sp = SPECIAL_PERM[entRec.special];
    if (sp && !grantedPerms.includes(sp)) grantedPerms.push(sp);
  }

  // Synthetic, unique login email — never typed by anyone; the person always
  // signs in as the primary. Keeps the unique-email invariant intact.
  const base = String(root.email || `user${root.id}@aotc.local`);
  const at = base.lastIndexOf('@');
  const local = at > 0 ? base.slice(0, at) : base;
  const domain = at > 0 ? base.slice(at + 1) : 'aotc.local';
  let candidate = `${local}+${entity.type}${entity.id}@${domain}`;
  let n = 2;
  while (db.findOne('users', u => u.email.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${local}+${entity.type}${entity.id}-${n}@${domain}`;
    n++;
  }

  const ws = db.insert('users', {
    name: root.name,
    email: candidate,
    role: wsRole,
    phone: '', // the primary owns the phone identifier — keeps phone-login unambiguous
    position: typeof position === 'string' ? position.trim() : '',
    entity: { type: entity.type, id: Number(entity.id) },
    permissions: grantedPerms,
    // Unusable password: this account is reachable only by switching from the
    // primary session, never by a direct login.
    passwordHash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
    twoFactorEnabled: false,
    mustChangePassword: false,
    linkedTo: rootId,
  });
  res.status(201).json(safeUser(ws));
});

// Update a user's role, permissions, and phone.
// staff.manage is normally admin-only but can be granted to non-admin staff.
// The admin-boundary changes below additionally require the caller to BE an
// admin, so a non-admin staff.manage holder can't escalate (promote anyone —
// including themselves — to admin, hand out staff.manage, or demote the only
// admin and lock everyone out).
router.put('/users/:id', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const user = db.findById('users', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Admin accounts are off-limits here entirely, even to other admins — an
  // admin's own name/email/phone can only be changed by that admin, via My
  // Account (PUT /auth/me). This protects the original seed admin (and any
  // other admin) from having their identity edited by a peer admin, while
  // still letting each admin manage themselves.
  if (user.role === 'admin' && user.id !== req.user.id) {
    return res.status(403).json({ error: 'Admin accounts can only be edited by that admin, from My Account.' });
  }
  const callerIsAdmin = req.user.role === 'admin';
  // Local Admin accounts can only be managed by a real admin (or themselves).
  if (user.role === 'localadmin' && user.id !== req.user.id && !callerIsAdmin) {
    return res.status(403).json({ error: 'Only an administrator can edit a Local Admin account.' });
  }
  const { name, email, role, permissions, phone, entity, position, otpChannel } = req.body;
  const patch = {};
  if (entity !== undefined) {
    patch.entity = entity && entity.type ? { type: entity.type, id: Number(entity.id) } : null;
  }
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty.' });
    patch.name = trimmed;
  }
  if (email !== undefined) {
    const trimmed = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    // Email is the login identifier — must stay unique across accounts.
    const clash = db.findOne('users', u => u.id !== user.id && u.email.toLowerCase() === trimmed);
    if (clash) return res.status(409).json({ error: 'Another account already uses that email.' });
    patch.email = trimmed;
  }
  if (role) {
    if (!require('../middleware/auth').ROLES.includes(role)) {
      return res.status(400).json({ error: 'That is not a valid access level.' });
    }
    // A linked workspace is a scoped hat, never an admin identity.
    if (user.linkedTo && ['admin', 'localadmin'].includes(role)) {
      return res.status(400).json({ error: 'A workspace cannot be given admin access.' });
    }
    // Only an admin may grant the admin role or alter an existing admin's role.
    if ((['admin', 'localadmin'].includes(role) || ['admin', 'localadmin'].includes(user.role)) && !callerIsAdmin) {
      return res.status(403).json({ error: 'Only an administrator can grant or change admin-level access.' });
    }
    // Never demote the last remaining admin — that would lock everyone out of admin.
    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = db.findAll('users', u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'This is the only administrator account and cannot be demoted.' });
      }
    }
    patch.role = role;
  }
  if (Array.isArray(permissions)) {
    // Granting staff.manage is an admin-equivalent right — admin-only.
    if (permissions.includes('staff.manage') && !(user.permissions || []).includes('staff.manage') && !callerIsAdmin) {
      return res.status(403).json({ error: 'Only an administrator can grant staff-management access.' });
    }
    const err = permissionChangeError(req, user, user.permissions || [], permissions);
    if (err) return res.status(403).json({ error: err });
    patch.permissions = permissions;
  }
  if (phone !== undefined) patch.phone = phone;
  if (position !== undefined) patch.position = String(position).trim();
  // Where login codes go: 'auto' (follow the identifier used at login),
  // or pinned to 'email' / 'sms'. Editable by staff managers at any time.
  if (otpChannel !== undefined) {
    if (!['auto', 'email', 'sms'].includes(otpChannel)) {
      return res.status(400).json({ error: 'Login-code channel must be auto, email, or sms.' });
    }
    if (otpChannel === 'sms' && !(phone !== undefined ? phone : user.phone)) {
      return res.status(400).json({ error: 'Add a phone number before pinning login codes to SMS.' });
    }
    patch.otpChannel = otpChannel;
  }
  const updated = db.update('users', req.params.id, patch);
  // Keep a person's linked workspaces showing the same name as their primary.
  if (patch.name && !user.linkedTo) {
    db.findAll('users', u => Number(u.linkedTo) === Number(user.id))
      .forEach(sec => db.update('users', sec.id, { name: patch.name }));
  }
  res.json(safeUser(updated));
});

// Give every account in a role the role's default permissions it is missing.
// Adds only — never removes — and only the admin tier may do it, because some
// defaults are sensitive. Exists because editing ROLE_DEFAULT_PERMISSIONS never
// reached existing accounts: the Treasurer's account predated
// finance.weekly.confirm, so no-one could confirm a weekly return.
router.post('/roles/:role/apply-defaults', requireAuth, (req, res) => {
  if (!['admin', 'localadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Only an administrator can do this.' });
  const role = req.params.role;
  if (!ROLE_DEFAULT_PERMISSIONS[role] || ['admin', 'localadmin'].includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  const defaults = ROLE_DEFAULT_PERMISSIONS[role].filter(p => p !== 'staff.manage');
  const changed = [];
  db.findAll('users', u => u.role === role).forEach(u => {
    const have = u.permissions || [];
    const add = defaults.filter(p => !have.includes(p));
    if (!add.length) return;
    db.update('users', u.id, { permissions: [...have, ...add] });
    changed.push({ id: u.id, name: u.name, added: add });
    require('../utils/activityLog').logActivity({ ...require('../utils/scope').actor(req), action: `Added role defaults: ${add.join(', ')}`, entityType: 'user', entityId: u.id, entityLabel: u.name });
  });
  res.json({ ok: true, changed });
});

// Switch an account off or on (Oct 2026). Off: the person can't sign in, any
// open session stops on its next request (sessionVersion is bumped too, so
// even a cached token is dead), and they leave every notification list.
// Nothing they recorded changes. On: everything comes back as it was.
// A login carries its workspaces with it; a single workspace can also be
// switched off on its own.
router.post('/users/:id/status', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const target = db.findById('users', Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (req.body.enabled !== true && req.body.enabled !== false) return res.status(400).json({ error: 'Say whether to switch the account on or off.' });
  const enable = req.body.enabled === true;
  const me = db.findById('users', req.user.id) || {};
  const root = u => Number(u.linkedTo || u.id);
  if (root(target) === root(me)) return res.status(403).json({ error: 'You cannot switch your own account off or on.' });
  if (['admin', 'localadmin'].includes(target.role) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can switch an admin account on or off.' });
  }
  if (!enable && target.role === 'admin') {
    const others = db.findAll('users', u => u.role === 'admin' && !u.disabled && u.id !== target.id).length;
    if (!others) return res.status(400).json({ error: 'This is the only working administrator account; it cannot be switched off.' });
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!enable && !reason) return res.status(400).json({ error: 'Give a short reason — it is kept on the account and in the activity log.' });
  if (!!target.disabled === !enable) return res.json({ ok: true, unchanged: true, user: safeUser(target) });
  const { actor } = require('../utils/scope');
  const who = actor(req).userName;
  const now = new Date().toISOString();
  const updated = enable
    ? db.update('users', target.id, { disabled: false, enabledAt: now, enabledBy: who })
    : bumpSessionVersion(target.id, { disabled: true, disabledAt: now, disabledBy: who, disabledReason: reason });
  require('../utils/activityLog').logActivity({ ...actor(req),
    action: enable ? 'SWITCHED ON account' : `SWITCHED OFF account: ${reason}`,
    entityType: 'user', entityId: target.id, entityLabel: target.name });
  res.json({ ok: true, user: safeUser(updated) });
});

// Admin-assisted password reset (for staff who can't complete the email flow)
router.post('/users/:id/reset-password', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const user = db.findById('users', req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Resetting another admin's password is an account takeover of an admin —
  // only a real admin may do it (not merely a staff.manage holder).
  if (['admin', 'localadmin'].includes(user.role) && user.id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can reset an admin-level account\'s password.' });
  }
  const { newPassword } = req.body;
  const result = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!result.valid) {
    return res.status(400).json({ error: 'Password is not strong enough.', failedRules: result.failedRules });
  }
  // Bumping the session version signs out any session already open on this
  // account — including one an attacker is holding — rather than leaving it
  // to ride out its remaining cookie lifetime (up to 30 days).
  bumpSessionVersion(user.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    // Clear any authenticator-app / passkey-adjacent 2FA state (covers the
    // "lost my phone" case this reset is usually for), but don't drop below
    // the email-code floor everyone is required to have. Passkeys are
    // cleared too — if this reset is because the account was compromised,
    // an attacker-registered passkey would otherwise still let them straight
    // back in, bypassing the new password entirely.
    twoFactorEnabled: true, twoFactorMethod: 'email',
    twoFactorSecret: null, twoFactorTempSecret: null, twoFactorTempMethod: null,
    twoFactorTempOtpHash: null, twoFactorTempOtpExpires: null, backupCodeHashes: [],
    passkeys: [],
    mustChangePassword: true, // this is a temporary password the admin just set
  });
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requirePermission('staff.manage'), (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const target = db.findById('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  // Deleting an admin-level account is an admin-only action, and the last
  // admin can never be deleted.
  if (['admin', 'localadmin'].includes(target.role)) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an administrator can delete an admin-level account.' });
    }
    const adminCount = db.findAll('users', u => u.role === 'admin').length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'This is the only administrator account and cannot be deleted.' });
    }
  }
  // Removing a person removes all their linked committee/group workspaces too
  // (a workspace has no independent login, so it must never be orphaned).
  if (!target.linkedTo) {
    db.findAll('users', u => Number(u.linkedTo) === Number(target.id))
      .forEach(sec => db.remove('users', sec.id));
  }
  db.remove('users', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
