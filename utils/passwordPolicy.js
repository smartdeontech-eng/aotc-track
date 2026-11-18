// Shared password strength rules — used server-side (to reject weak passwords)
// and mirrored client-side (for the live strength meter) so the guidance and
// the enforcement always agree.

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'letmein', 'welcome1', 'admin123', 'changeme', 'changeme123',
  'iloveyou', 'football', 'monkey123', 'abc12345', 'passw0rd', 'sunshine',
]);

const MIN_LENGTH = 10;

function checks(password, context = {}) {
  const pw = String(password || '');
  const lower = pw.toLowerCase();
  const emailLocal = (context.email || '').split('@')[0].toLowerCase();
  const nameParts = (context.name || '').toLowerCase().split(/\s+/).filter(Boolean);

  return {
    length: pw.length >= MIN_LENGTH,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    number: /[0-9]/.test(pw),
    symbol: /[^A-Za-z0-9]/.test(pw),
    notCommon: !COMMON_PASSWORDS.has(lower),
    notPersonal: !(
      (emailLocal && emailLocal.length > 2 && lower.includes(emailLocal)) ||
      nameParts.some(p => p.length > 2 && lower.includes(p))
    ),
  };
}

// Returns { valid, score (0-5), failedRules: string[] }
function validatePassword(password, context = {}) {
  const c = checks(password, context);
  const score = Object.values(c).filter(Boolean).length;
  const messages = {
    length: `At least ${MIN_LENGTH} characters`,
    upper: 'At least one uppercase letter (A-Z)',
    lower: 'At least one lowercase letter (a-z)',
    number: 'At least one number (0-9)',
    symbol: 'At least one symbol (e.g. ! @ # $ %)',
    notCommon: 'Not a commonly used password',
    notPersonal: "Doesn't contain your name or email",
  };
  const failedRules = Object.keys(c).filter(k => !c[k]).map(k => messages[k]);
  // Require the five core composition rules; the last two are soft warnings
  // that don't block but are surfaced to the user.
  const valid = c.length && c.upper && c.lower && c.number && c.symbol && c.notCommon;
  return { valid, score, failedRules, checks: c };
}

module.exports = { validatePassword, checks, MIN_LENGTH };
