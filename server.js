// AOTC Track — PCG Adabraka Official Town Congregation
// Quarterly Planning & Reporting System.
// Built on the Smart DeonTech mainframe (Blueprint v2, Modules A–K, M).
// server.js does wiring only — no business logic.
require('dotenv').config({ quiet: true });
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ---- Blue-green (Oct 2026) -------------------------------------------------
// On the server the app can run as two lines, blue and green (deploy/bluegreen).
// Only the line named in /opt/aotc-lines/live takes traffic, and only that line
// may run the timed jobs (reminders, automatic backups): a second copy would
// send every reminder twice. A line started outside blue-green has no
// AOTC_LINE and behaves exactly as before.
const LINE = process.env.AOTC_LINE || '';
const LIVE_FILE = process.env.AOTC_LIVE_FILE || '/opt/aotc-lines/live';
function isLiveLine() {
  if (!LINE) return true;
  try { return require('fs').readFileSync(LIVE_FILE, 'utf8').trim() === LINE; } catch (e) { return false; }
}

// ---- Timezone ----
// The congregation keeps Ghana time, which is UTC+0 all year. A lot of this app
// formats calendar days, and a process on a negative UTC offset used to print
// them a day early. utils/dates now parses days correctly regardless, but the
// process clock still decides what "today" is — for reminder windows, quarter
// boundaries and default dates — so pin it and say so loudly if it is wrong.
// TZ is set in deploy/aotc-track.service; .env can override for local work.
require('./utils/dates').assertTimezone();

// ---- Fail fast on missing/weak secrets ----
const WEAK_SECRETS = new Set(['change-this-secret-in-.env', 'replace-this-with-a-long-random-string', 'secret', 'changeme']);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || WEAK_SECRETS.has(process.env.JWT_SECRET)) {
  console.error(
    '\nFATAL: JWT_SECRET is missing, too short, or a known placeholder.\n' +
    'Set a long random value in .env before starting the server, e.g.:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

const authRoutes = require('./routes/auth');
const backupRoutes = require('./routes/backups');
const settingsRoutes = require('./routes/settings');
const setupRoutes = require('./routes/setup');
const planningRoutes = require('./routes/planning');
const entryRoutes = require('./routes/entry');
const reportRoutes = require('./routes/reports');
const meetingRoutes = require('./routes/meetings');
const attendanceRoutes = require('./routes/attendance');
const { scheduleAutomaticBackups } = require('./utils/backup');
const reminderRoutes = require('./routes/reminders');
const visitorRoutes = require('./routes/visitors');
const counsellingRoutes = require('./routes/counselling');
const fundraisingRoutes = require('./routes/fundraising');
const inboxRoutes = require('./routes/inbox');
const marriageRoutes = require('./routes/marriage');
const { scheduleReminderJobs } = require('./utils/reminders');
const analyticsRoutes = require('./routes/analytics');
const checkinRoutes = require('./routes/checkin');
const pushRoutes = require('./routes/push');

const app = express();
const PORT = process.env.PORT || 3000;

if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- Security headers ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // blob: = pictures the page made itself (the letter-page tray's thumbnails,
      // the document viewer's image view). Always same-origin.
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: IS_PRODUCTION ? { maxAge: 15552000, includeSubDomains: true } : false,
}));

// ---- Rate limiting ----
// Strict limiter on the sensitive auth endpoints (brute-force protection).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this network. Please wait a few minutes and try again.' },
});
app.use(
  ['/api/auth/login', '/api/auth/login/verify-2fa', '/api/auth/forgot-password', '/api/auth/forgot-email', '/api/auth/reset-password'],
  authLimiter
);

// General limiter — applied to /api ONLY, so it never counts static assets
// (JS/CSS/images/fonts) or the SPA shell. The ceiling is generous enough for
// legitimate bulk admin work: adding many user accounts/workspaces in one
// sitting fires a burst of API calls per page-load and per save, and the old
// 600-that-also-counted-every-asset budget tripped on normal use.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down and try again in a few minutes.' },
}));

// A photo of a filled harvest sheet is the one larger body (resized in the
// browser first, so normally well under 1 MB).
app.use('/api/fundraising/sheets', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', require('./utils/pulse-reporter').activity({ jwt: require('jsonwebtoken'), secret: require('./middleware/auth').JWT_SECRET }));
app.use(express.static(path.join(__dirname, 'public')));

const APP_VERSION = require('./package.json').version;
const APP_RELEASED = require('./package.json').released || null;
const APP_STARTED = Date.now();
let APP_CHANGES = [];
try { APP_CHANGES = require('./changes.json'); } catch (e) { /* About shows the version alone */ }
// Never cached: the update bar compares this with the version a page opened with.
app.get('/api/version', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ version: APP_VERSION, released: APP_RELEASED, started: APP_STARTED, node: process.versions.node, changes: APP_CHANGES }); });

// Health check for uptime monitoring — verifies the data directory is writable
// (the whole app depends on it). Returns 503 if not, so a monitor can alert.
app.get('/api/healthz', (req, res) => {
  const fs = require('fs');
  // One probe per process: on a blue-green switch two lines check the same
  // data folder at once, and a shared name made one of them report unwritable.
  const probe = path.join(__dirname, 'data', `.healthz-${process.pid}`);
  let dataWritable = false;
  try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); fs.writeFileSync(probe, '1'); fs.unlinkSync(probe); dataWritable = true; } catch (e) {}
  let database = false;
  try { database = require('./utils/db').ping(); } catch (e) {}
  res.status(dataWritable && database ? 200 : 503).json({ ok: dataWritable && database, database, version: APP_VERSION, dataWritable, line: LINE || null, live: isLiveLine(), time: new Date().toISOString() });
});

// ---- Routes (one router per module under /api/<module>) ----
app.use('/api/auth', authRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/entry', entryRoutes);
app.use('/api/finance-weekly', require('./routes/financeWeekly'));
app.use('/api/reports', reportRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/visitors', visitorRoutes);
app.use('/api/counselling', counsellingRoutes);
app.use('/api/fundraising', fundraisingRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/marriage', marriageRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/messages', require('./routes/messages'));
app.use('/api/push', pushRoutes);
app.use('/api/minutes', require('./routes/minutes'));
// Home page: what is waiting on you, and the next fortnight (Oct 2026).
app.use('/api/home', require('./routes/home'));
// ShareHub. routes/documents.js has existed since the document library was
// written but was never mounted, so every call the page made returned the
// 404 handler and ShareHub has never actually worked.
app.use('/api/documents', require('./routes/documents'));
app.use('/api/unlocks', require('./routes/unlocks'));
app.use('/api/diary', require('./routes/diary'));
// Elections (Oct 2026): officers' side, and the public voting side (no login).
app.use('/api/elections', require('./routes/elections'));
app.use('/api/vote', require('./routes/vote'));

// Elections: the short links that go out by SMS and on screens.
//   /v/<election>   the voting page      /booth/<token>  a booth laptop
//   /live/<token>   a live results display
app.get('/v/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vote.html')));
app.get('/booth/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booth.html')));
app.get('/live/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));

// Fallback: send index.html for any non-API route
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Central error handler ----
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  // One-time backfill: give every existing member a unique number + QR token
  // (idempotent — only touches records missing them).
  try {
    const fixed = require('./utils/memberIdentity').backfillIdentities();
    if (fixed) console.log(`Assigned member numbers/tokens to ${fixed} existing member(s).`);
  } catch (e) { console.error('member identity backfill failed (non-fatal):', e.message); }

  // One-time: split 'setup.manage' and tidy the accounts found in the Oct 2026
  // permissions review. Idempotent — records itself and never runs twice.
  try {
    const changed = require('./utils/migrations/permSplit2026').run();
    if (changed) console.log(`Permissions update: ${changed.length} account(s) changed.`);
  } catch (e) { console.error('permissions migration failed (non-fatal):', e.message); }

  app.listen(PORT, () => {
    const { zone } = require('./utils/dates').assertTimezone(() => {});
    console.log(`AOTC Track running on http://localhost:${PORT} (timezone ${zone})`);
  });
  // The timed jobs start once this line is the live one — at once outside
  // blue-green, otherwise as soon as the switch names it (checked every 15 s).
  let jobsStarted = false;
  const startJobs = () => {
    if (jobsStarted || !isLiveLine()) return false;
    jobsStarted = true;
    scheduleAutomaticBackups();
    scheduleReminderJobs();
    // Polls open and close on time, and codes go out, from the live line only.
    require('./utils/elections').startScheduler();
    if (LINE) console.log(`[${LINE}] is the live line: reminders, automatic backups and election timers started.`);
    return true;
  };
  if (!startJobs()) {
    console.log(`[${LINE}] not the live line yet: reminders and backups wait for the switch.`);
    const t = setInterval(() => { if (startJobs()) clearInterval(t); }, 15000);
    t.unref();
  }
}

module.exports = app;
