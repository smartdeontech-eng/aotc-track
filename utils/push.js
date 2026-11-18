// AOTC Track — Web Push notifications.
// Sends real device push notifications (phone/desktop, even with the app
// closed) to any user who has enabled notifications on a device. Follows the
// same graceful-degradation pattern as sms.js / mailer.js: if VAPID keys are
// not configured, everything becomes a silent no-op and the rest of the app
// works exactly as before.
//
// Setup (one-time): `npx web-push generate-vapid-keys` then put the pair in
// .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (VAPID_SUBJECT optional,
// defaults to a mailto for the notify address).
//
// Subscriptions live in the `push_subscriptions` collection:
//   { id, userId, endpoint, keys: {p256dh, auth}, userAgent, createdAt }
// A user may have several (phone + laptop). Dead subscriptions (410/404 from
// the push service) are pruned automatically on send.
const db = require('./db');
const { logNotification } = require('./notifications');

let webpush = null;
let configured = false;

function init() {
  if (webpush !== null) return configured;
  try {
    webpush = require('web-push');
  } catch (e) {
    webpush = false; // package not installed
    return (configured = false);
  }
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return (configured = false);
  const subject = process.env.VAPID_SUBJECT || `mailto:${process.env.NOTIFY_EMAIL || 'gadjei@pcg-aotc.com'}`;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } catch (e) {
    console.error('[push] invalid VAPID configuration:', e.message);
    configured = false;
  }
  return configured;
}

function isConfigured() { return init(); }
function publicKey() { return init() ? process.env.VAPID_PUBLIC_KEY : null; }

function saveSubscription(userId, sub, userAgent) {
  if (!sub || !sub.endpoint) return null;
  const existing = db.findOne('push_subscriptions', s => s.endpoint === sub.endpoint);
  const payload = {
    userId: Number(userId),
    endpoint: sub.endpoint,
    keys: sub.keys || {},
    userAgent: (userAgent || '').slice(0, 200),
  };
  return existing ? db.update('push_subscriptions', existing.id, payload) : db.insert('push_subscriptions', payload);
}

function removeSubscription(endpoint) {
  const existing = db.findOne('push_subscriptions', s => s.endpoint === endpoint);
  if (existing) db.remove('push_subscriptions', existing.id);
  return !!existing;
}

function subscriptionsForUser(userId) {
  return db.findAll('push_subscriptions', s => Number(s.userId) === Number(userId));
}

// Every user-directed notification also lands in the `user_notifications`
// inbox, so people who were logged out / offline / not push-subscribed still
// see it on their next login (bell icon). Push delivery itself stays
// fire-and-forget on top of this.
function saveToInbox(ids, payload) {
  try {
    ids.forEach(userId => db.insert('user_notifications', {
      userId: Number(userId),
      title: String(payload.title || 'AOTC Track').slice(0, 120),
      body: String(payload.body || '').slice(0, 600),
      url: String(payload.url || '/').slice(0, 200),
      readAt: null,
    }));
  } catch (e) { console.error('[push] inbox write failed:', e.message); }
}

// Send one payload to every device of every user in userIds.
// payload: { title, body, url, tag }
async function sendPushToUsers(userIds, payload) {
  const { isDisabled } = require('./accountStatus');
  const ids = [...new Set((userIds || []).map(Number))].filter(n => n > 0 && !isDisabled(db.findById('users', n)));
  if (!ids.length) return { sent: 0 };
  // Inbox first — works even when VAPID push isn't configured at all.
  saveToInbox(ids, payload);
  if (!init()) return { sent: 0, skipped: true };
  const subs = db.findAll('push_subscriptions', s => ids.includes(Number(s.userId)));
  const body = JSON.stringify({
    title: payload.title || 'AOTC Track',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || undefined,
  });
  let sent = 0;
  for (const s of subs.slice(0, 200)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 24 * 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.remove('push_subscriptions', s.id); // device unsubscribed / expired
      } else {
        console.error('[push] send failed:', e.statusCode || e.message);
      }
    }
  }
  return { sent };
}

// Convenience: all users holding a permission (admins count for every permission).
function userIdsWithPermission(...perms) {
  return db.findAll('users', u =>
    u.role === 'admin' || perms.some(p => (u.permissions || []).includes(p))
  ).map(u => u.id);
}

// Convenience: users attached to an entity (committee/group logins).
function userIdsForEntity(entityType, entityId) {
  return db.findAll('users', u =>
    u.entity && u.entity.type === entityType && Number(u.entity.id) === Number(entityId)
  ).map(u => u.id);
}

// ---- Back-compat wrappers ----
// Older call sites (meetings, approval flows) used these names; they map
// straight onto sendPushToUsers so both API generations keep working.
function sendPushToUser(userId, payload) {
  return sendPushToUsers([userId], payload);
}
function sendPushToEntityUsers(entityType, entityId, payload) {
  return sendPushToUsers(userIdsForEntity(entityType, entityId), payload);
}
// Contacts = { phones: [], emails: [] } → any app user matching one of them.
function sendPushByContacts(contacts, payload) {
  const phones = new Set((contacts && contacts.phones) || []);
  const emails = new Set(((contacts && contacts.emails) || []).map(e => String(e).toLowerCase()));
  const ids = db.findAll('users', u =>
    (u.phone && phones.has(u.phone)) || (u.email && emails.has(String(u.email).toLowerCase()))
  ).map(u => u.id);
  return sendPushToUsers(ids, payload);
}

module.exports = {
  isConfigured, publicKey,
  saveSubscription, removeSubscription, subscriptionsForUser,
  sendPushToUsers, userIdsWithPermission, userIdsForEntity,
  sendPushToUser, sendPushToEntityUsers, sendPushByContacts,
};
