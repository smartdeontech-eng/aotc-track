// AOTC Track — calendar days must not shift by a timezone.
//
// The bug this pins: a bare 'YYYY-MM-DD' is a calendar DAY, but
// `new Date('2026-08-30')` parses it as midnight UTC. Every local-time
// formatter on a negative UTC offset then prints the day before, so the Sunday
// attendance text a Clerk copies out for 30 August read "29 August 2026".
// Its mirror image: `input.valueAsDate = d` WRITES the UTC day, so a Sunday
// evening at UTC-4 pre-filled MONDAY and the section figures were filed there.
//
// Both are invisible in Accra (UTC+0), which is why they survived. So the
// runtime checks below are run three times over — west of Greenwich, in Ghana,
// and east of the dateline — by re-executing this file once per zone.
//
//   node scripts/test-dates.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ZONES = ['America/Aruba', 'Africa/Accra', 'Pacific/Apia'];

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log('ok  :', n))
    : (fail++, console.log('FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 220)));
};

// The client's date helpers live between two markers in app.js so they can be
// lifted out and exercised without booting the whole shell.
function clientDateHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const a = src.indexOf('// ---- Dates ---');
  const b = src.indexOf('// ---- end Dates ----');
  if (a < 0 || b < 0) throw new Error('date-helper markers missing from public/js/app.js');
  return src.slice(a, b);
}

// ---------------------------------------------------------------- source scan
// Runs once, zone-independent. This is the half that catches NEW code: the
// fixes below only prove the lines we already touched.
function scanSources() {
  console.log('\n--- source scan ---');

  const clientFiles = fs.readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.endsWith('.js'))
    .map(f => ['public/js/' + f, fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8')]);

  // 1. valueAsDate writes the UTC day. There is no correct use of it here.
  const offenders = clientFiles.filter(([f, s]) =>
    s.split('\n').some(l => l.includes('valueAsDate') && !l.trim().startsWith('//')));
  ok('no valueAsDate assignments in public/js', offenders.length === 0, offenders.map(o => o[0]));

  // 2. `new Date(x + 'T00:00:00')` was the hand-rolled workaround, applied in
  //    five places and missed in twenty. One helper now, or the next reader
  //    copies whichever version they happen to land on.
  const handrolled = [];
  for (const dir of ['public/js', 'routes', 'utils']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.js'))) {
      // utils/dates.js is where the one implementation is allowed to live.
      if (dir === 'utils' && f === 'dates.js') continue;
      const s = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      if (/new Date\([^)]*['"]T00:00:00/.test(s)) handrolled.push(dir + '/' + f);
    }
  }
  ok("no hand-rolled new Date(d + 'T00:00:00')", handrolled.length === 0, handrolled);

  // 3. Every date-only field must be parsed, not passed to `new Date`.
  //    Timestamps (createdAt, savedAt, …) are instants and are fine.
  const DAY_FIELDS = /new Date\(\s*[A-Za-z_$][\w$.]*\.(date|dueDate|targetDate|marriageDate|customaryDate|interviewDate|counsellingStartDate|signDate|meetingDate)\b/;
  const naive = [];
  for (const dir of ['public/js', 'routes', 'utils']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      s.split('\n').forEach((l, i) => {
        if (DAY_FIELDS.test(l) && !l.includes('T${') && !/T\$\{|['"]T\d/.test(l)) {
          naive.push(`${dir}/${f}:${i + 1}`);
        }
      });
    }
  }
  ok('no calendar-day field handed straight to new Date()', naive.length === 0, naive);

  // 4. The deployed service must pin Ghana time. Days parse correctly either
  //    way now, but the process clock still decides what "today" is.
  const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'aotc-track.service'), 'utf8');
  ok('systemd unit pins TZ=Africa/Accra', /^Environment=TZ=Africa\/Accra$/m.test(unit));
}

// ------------------------------------------------------------ runtime, per zone
function runtimeChecks(zone) {
  console.log(`\n--- ${zone} (UTC${-new Date().getTimezoneOffset() / 60}) ---`);

  const D = require(path.join(ROOT, 'utils', 'dates'));

  // The server helper.
  ok('server fmtDayLong 2026-08-30', D.fmtDayLong('2026-08-30') === '30 August 2026', D.fmtDayLong('2026-08-30'));
  ok('server fmtDay 2026-08-30 is a Sunday', D.fmtDay('2026-08-30') === 'Sun 30 Aug', D.fmtDay('2026-08-30'));
  ok('server toLocalDate keeps the day', D.toLocalDate('2026-08-30').getDate() === 30);
  ok('server toLocalDate keeps the weekday', D.toLocalDate('2026-08-30').getDay() === 0);
  ok('server leaves a real timestamp alone',
    D.toLocalDate('2026-08-30T12:00:00Z').getTime() === Date.parse('2026-08-30T12:00:00Z'));
  ok('server toDayKey reads the LOCAL day', D.toDayKey(new Date(2026, 7, 30, 21, 30)) === '2026-08-30',
    D.toDayKey(new Date(2026, 7, 30, 21, 30)));
  ok('server tolerates rubbish', D.fmtDayLong('') === '' && D.fmtDayLong(null) === '');

  // The client helpers, lifted out of app.js.
  const client = {};
  (new Function(clientDateHelpers() + '\nreturn { toLocalDate, dateInputValue, todayInputValue, lastSundayInputValue, fmtDate, fmtDateLong };')
    .call(client));
  const C = new Function(clientDateHelpers() + '\nreturn { toLocalDate, dateInputValue, todayInputValue, lastSundayInputValue, fmtDate, fmtDateLong };')();

  ok('client fmtDateLong 2026-08-30', C.fmtDateLong('2026-08-30') === '30 August 2026', C.fmtDateLong('2026-08-30'));
  ok('client fmtDate 2026-08-30', C.fmtDate('2026-08-30') === '30 Aug 2026', C.fmtDate('2026-08-30'));
  ok('client fmtDate still handles a timestamp',
    C.fmtDate('2026-08-30T09:00:00Z').length > 0 && !isNaN(C.toLocalDate('2026-08-30T09:00:00Z')));

  // The valueAsDate half. 21:00 on Sunday 30 August is already Monday in UTC,
  // which is exactly what the old code wrote into the date field.
  const sundayEvening = new Date(2026, 7, 30, 21, 0, 0);
  ok('client dateInputValue on a Sunday evening stays Sunday',
    C.dateInputValue(sundayEvening) === '2026-08-30', C.dateInputValue(sundayEvening));
  ok('...and that is genuinely the case valueAsDate got wrong',
    zone !== 'America/Aruba' || sundayEvening.toISOString().slice(0, 10) === '2026-08-31',
    sundayEvening.toISOString().slice(0, 10));

  const sunday = C.toLocalDate(C.lastSundayInputValue());
  ok('lastSundayInputValue really is a Sunday', sunday.getDay() === 0, C.lastSundayInputValue());
  ok('lastSundayInputValue is not in the future', sunday <= new Date());
  ok('todayInputValue matches the local calendar day',
    C.todayInputValue() === D.toDayKey(new Date()), [C.todayInputValue(), D.toDayKey(new Date())]);

  // The sentence the Clerk copies out, from the real page function.
  const { JSDOM } = require(path.join(ROOT, 'node_modules', 'jsdom'));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(clientDateHelpers());
  w.eval(fs.readFileSync(path.join(ROOT, 'public', 'js', 'page-attendance.js'), 'utf8')
    // svcSummary is pure; the rest of the page wants a session and a server.
    .match(/function svcSummary\(dateKey, entries\)[\s\S]*?\n}\n/)[0]);

  const counts = (m, f, extra) => Object.assign({ male: m, female: f, online: 0 }, extra || {});
  const entry = {
    date: '2026-08-30', service: 'joint',
    counts: {
      adult: counts(120, 180),
      jy: counts(20, 25, { leadersMale: 2, leadersFemale: 3 }),
      cs: counts(30, 35, { teachersMale: 1, teachersFemale: 4 }),
    },
  };
  const text = w.eval('svcSummary')('2026-08-30', [entry]);
  ok('the copied Sunday text names 30 August', text.includes('for 30 August 2026 was'), text.slice(0, 80));
  ok('the copied Sunday text never says 29 August', !text.includes('29 August'), text.slice(0, 80));
  ok('the totals still add up',
    text.includes('was 420 in total') && text.includes('310 adults'), text.slice(0, 120));
}

if (!process.env.AOTC_TEST_TZ) {
  scanSources();
  let bad = 0;
  for (const zone of ZONES) {
    try {
      process.stdout.write(execFileSync(process.execPath, [__filename], {
        env: Object.assign({}, process.env, { TZ: zone, AOTC_TEST_TZ: zone }),
        encoding: 'utf8',
      }));
    } catch (e) {
      bad++;
      process.stdout.write(String(e.stdout || '') + String(e.stderr || ''));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed in the source scan; ${ZONES.length - bad}/${ZONES.length} timezones clean.`);
  process.exit(fail || bad ? 1 : 0);
} else {
  runtimeChecks(process.env.AOTC_TEST_TZ);
  console.log(`${pass} passed, ${fail} failed in ${process.env.AOTC_TEST_TZ}.`);
  process.exit(fail ? 1 : 0);
}
