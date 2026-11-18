// Run once with `node utils/seed.js` to create the two admin accounts.
// AOTC Track policy: TWO separate named admin accounts, 2FA enforced on both,
// never shared credentials. (See SOFTWARE PLAN.md — admin decisions.)
const bcrypt = require('bcryptjs');
const db = require('./db');

const existing = db.findAll('users');
if (existing.length > 0) {
  console.log('Users already exist. Skipping seed. (Delete data/users.json to reseed.)');
  process.exit(0);
}

const TEMP_PASSWORD = 'FirstLogin#2026';
const passwordHash = bcrypt.hashSync(TEMP_PASSWORD, 10);

const admins = [
  { name: 'Gideon Adjiereh Adjei', email: 'gadjei@pcg-aotc.com' },
  // Second admin: replace with the designated person's real name + email
  // before running this seed in production.
  { name: 'Second Admin (edit me)', email: 'admin2@pcg-aotc.com' },
];

for (const a of admins) {
  db.insert('users', {
    name: a.name,
    email: a.email,
    phone: '',
    passwordHash,
    role: 'admin', // admin | clerk | secretary | viewer
    permissions: [], // admins bypass permission checks
    entity: { type: 'congregation', id: 0 },
    twoFactorEnabled: true, // ENFORCED for admins — do not disable
    twoFactorMethod: 'email', // floor default; upgrade to authenticator/passkey in My Account
    mustChangePassword: true, // forced to set a real password on first login
  });
}

console.log('Created 2 admin accounts (2FA enforced):');
admins.forEach(a => console.log(`  ${a.name} <${a.email}>`));
console.log(`  Temporary password (both): ${TEMP_PASSWORD}`);
console.log('IMPORTANT: log in and change these passwords immediately.');
