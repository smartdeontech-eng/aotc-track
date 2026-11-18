// Best-effort email + SMS notifications for the approval flows
// (change-window requests and roster requests). Never blocks or fails the
// business action: sends fire-and-forget, and both mailer.js and sms.js
// already no-op gracefully when SMTP / mNotify aren't configured.
const db = require('./db');
const { activeUsers } = require('./accountStatus');
const { sendMail } = require('./mailer');
const { sendSms } = require('./sms');
const push = require('./push');

// Everyone who can decide an approval: the Session Clerk (approvals.manage)
// and all admins.
function approvers() {
  return activeUsers(u =>
    u.role === 'admin' || (u.permissions || []).includes('approvals.manage'));
}

// opts lets a caller pick channels. By default all three fire (used for
// outcome notices to the requester). Approval-pending nudges to approvers pass
// { sms: false } so PUSH is the primary channel and SMS is held back for the
// close-of-day escalation (see checkPendingApprovalReminders in reminders.js).
function notifyUser(user, subject, text, opts = {}) {
  if (!user || require('./accountStatus').isDisabled(user)) return;
  const { sms = true, email = true, push: doPush = true, url = '' } = opts;
  const appUrl = process.env.APP_URL || '';
  const link = appUrl ? appUrl.replace(/\/$/, '') + (url && url.startsWith('/') ? url : '/') : '';
  if (email && user.email) {
    sendMail({
      to: user.email,
      subject: `AOTC Track — ${subject}`,
      html: `<p>${text}</p>${link ? `<p><a href="${link}">Open in AOTC Track</a></p>` : ''}`,
    }).catch(() => {});
  }
  if (sms && user.phone) {
    sendSms({ to: user.phone, message: `AOTC Track: ${text}` }).catch(() => {});
  }
  // Push to any devices where they've enabled notifications (PWA/desktop).
  // The url deep-links the tap straight to the relevant page.
  // Tolerant of both push.js API generations (sendPushToUser / sendPushToUsers).
  if (doPush) {
    try {
      const payload = { title: subject, body: text, url: url || '/' };
      if (typeof push.sendPushToUsers === 'function') push.sendPushToUsers([user.id], payload).catch(() => {});
      else if (typeof push.sendPushToUser === 'function') push.sendPushToUser(user.id, payload).catch(() => {});
    } catch (e) {}
  }
}

// Notify every approver (except the person who triggered it, if they happen
// to be one themselves). PUSH-first: push + email go out immediately; SMS is
// NOT sent here — it's the second-level nudge sent at close of day only if the
// request is still pending. `url` deep-links the tap to where it's handled.
function notifyApprovers(subject, text, excludeUserId, url) {
  approvers()
    .filter(u => Number(u.id) !== Number(excludeUserId))
    .forEach(u => notifyUser(u, subject, text, { sms: false, url }));
}

module.exports = { notifyUser, notifyApprovers };
