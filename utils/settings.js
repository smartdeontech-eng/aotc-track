// Congregation details shown on report letterheads. Stored as a
// single JSON file (not the array-based db.js store, since there's only ever
// one settings record) so it survives restarts and is editable from the app
// instead of being hardcoded in utils/pdf.js.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  companyName: 'PCG Adabraka Official Town Congregation',
  presbytery: 'Ga West',
  district: 'Adabraka Official Town',
  congregation: 'Adabraka Official Town',
  addressLines: ['Presbyterian Church of Ghana', 'Adabraka, Accra'],
  phones: [],
  email: 'admin@pcg-aotc.com',
  sessionClerk: 'Gideon Adjiereh Adjei',
  minister: 'Rev. Joseph Richmond Tettey',
  logoPath: '/img/logo-icon.png',
  currencySymbol: 'GHS ',
  // Consecutive no-apology meeting absences that flag a member for the
  // Session's attention (and alert the committee/group head). Session-tunable.
  absenceFlagThreshold: 4,
  // What a meeting notice tells people about the agenda. Kept as a setting
  // because it follows how the agenda is really circulated — the WhatsApp
  // group today, perhaps the app later. Blank leaves the sentence out.
  sessionAgendaNote: 'The agenda will be shared on the WhatsApp group.',
  // Extra house-style instructions for the correspondence drafting, in the
  // Clerk's own words. Appended to the prompt, so the wording can be corrected
  // without changing any code.
  correspondenceStyle: '',
};

function getSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (e) {
    console.error('[settings] corrupt settings.json, using defaults:', e.message);
    return { ...DEFAULTS };
  }
}

function updateSettings(patch) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const merged = { ...getSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { getSettings, updateSettings, DEFAULTS };
