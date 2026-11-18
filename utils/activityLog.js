// Business-action audit trail — "who did what" across invoices, customers,
// products, and job cards, so an admin can answer "who created this invoice"
// or "who deleted that customer" from the app instead of guessing. Append-only
// ledger, same pattern as login_logs / stock_movements / payments.
// Logging never blocks or fails the caller — an audit-trail gap is far
// better than a broken business action (same policy as email/SMS sends).
const db = require('./db');

// action: short verb phrase, e.g. "Created invoice", "Voided invoice"
// entityType: 'invoice' | 'customer' | 'product' | 'job_card'
// entityLabel: human-readable reference shown in the log, e.g. an invoice/job number or customer name
// snapshot: optional — the full record as it existed right before a hard
// delete. Hard-deleting a record removes it from its own data file entirely,
// so this is the only place its contents survive afterward. Not shown in the
// plain activity table (it's the full object, not a one-line detail) but
// it's there in activity_logs.json if the deletion is ever questioned later.
function logActivity({ userId, userName, action, entityType, entityId, entityLabel, detail, snapshot }) {
  try {
    db.insert('activity_logs', {
      userId: userId != null ? userId : null,
      userName: userName || 'System',
      action,
      entityType: entityType || '',
      entityId: entityId != null ? entityId : null,
      entityLabel: entityLabel || '',
      detail: detail || '',
      ...(snapshot !== undefined ? { snapshot } : {}),
    });
  } catch (e) {
    console.error('[activity-log] failed to write entry:', e.message);
  }
}

module.exports = { logActivity };
