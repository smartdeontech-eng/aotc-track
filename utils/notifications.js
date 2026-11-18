// System / provider alerts that would otherwise only ever appear in the
// server console and then be gone — SMS delivery failures (including
// gateway account-level alerts, e.g. mNotify flagging the sending account),
// email delivery failures, low-stock crossings, and backup failures.
// Written here so they're visible from the app's Notifications tab instead
// of silently scrolling off a terminal nobody is watching.
// Append-only, same pattern as login_logs / activity_logs.
const db = require('./db');

// level: 'error' | 'warning'
// source: 'sms' | 'email' | 'stock' | 'backup'
function logNotification({ level = 'error', source, message, meta }) {
  try {
    db.insert('notifications', {
      level,
      source: source || '',
      message: message || '',
      meta: meta || null,
      readAt: null,
    });
  } catch (e) {
    console.error('[notifications] failed to write entry:', e.message);
  }
}

module.exports = { logNotification };
