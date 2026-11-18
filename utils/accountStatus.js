// Enabled / disabled accounts (Oct 2026).
//
// An administrator can switch an account off without deleting it: the person
// cannot sign in, any session they already have stops working on its next
// request, and they drop out of every notification and reminder list. Nothing
// they recorded is touched, and switching them back on restores everything.
//
// Disabling a person's LOGIN (the primary account) disables all of their
// linked workspaces with it. Disabling a single workspace leaves the rest.
const db = require('./db');

function isDisabled(user) {
  if (!user) return false;
  if (user.disabled) return true;
  if (user.linkedTo) {
    const primary = db.findById('users', Number(user.linkedTo));
    if (primary && primary.disabled) return true;
  }
  return false;
}

// Users who should still hear from the app. Drop-in for db.findAll('users', fn).
function activeUsers(fn) {
  return db.findAll('users', u => !isDisabled(u) && (!fn || fn(u)));
}

const DISABLED_MESSAGE = 'This account has been switched off. Please contact the Session Clerk or an administrator.';

module.exports = { isDisabled, activeUsers, DISABLED_MESSAGE };
