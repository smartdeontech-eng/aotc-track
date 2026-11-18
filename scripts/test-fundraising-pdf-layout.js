// AOTC Track — the fundraising announcement, measured.
//
// The 30 August 2026 announcement came back with three headings on page 1 and
// seven basket labels on page 2 struck through by their own row rules. Two
// faults: the label columns were narrower than the labels, and the row heights
// were fixed constants that never followed wrapped text. `lineBreak: false` had
// been used to try to stop the wrap and does not work — measured below.
//
// This checks the widths against the real strings, and reads the finished PDF
// back to confirm the closing block adds up.
//
//   node scripts/test-fundraising-pdf-layout.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const PDFDocument = require('pdfkit');
const { buildAnnouncementPdf } = require('../utils/fundraisingPdf');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('ok  :', n))
  : (fail++, console.log('FAIL:', n, x === undefined ? '' : JSON.stringify(x))); };

const probe = new PDFDocument({ size: 'A4' });
const wide = (str, font, size) => { probe.font(font).fontSize(size); return probe.widthOfString(String(str)); };

// ---- the label columns, against the labels that actually go in them --------
console.log('Page 1 — the Category column is 240 wide, 230 usable (pad 5), Times-Bold 10pt:');
[
  'SEED CONTRIBUTIONS',
  'GRATITUDE & THANKSGIVING OFFERING',
  'DAY-BORN OFFERINGS  (ranked highest first)',
  'CHAIRPERSONS & CO-CHAIRPERSONS',
  'Service Total',
  '   Seed subtotal',
].forEach(l => ok(`"${l}" fits`, wide(l, 'Times-Bold', 10) <= 230,
  { width: +wide(l, 'Times-Bold', 10).toFixed(1), usable: 230 }));

console.log('The registers — Basket columns, Times-Bold 9pt (the widest case):');
const BASKETS = ['Chairpersons & Co-chairpersons', 'Gratitude & Thanksgiving',
  'Seed — Harvest Committee', 'Wednesday-borns', 'Counted baskets total'];
[['Breakdown by basket', 140], ['Cheques received', 140], ['Bank transfers', 140]]
  .forEach(([where, w]) => BASKETS.forEach(l => ok(`${where}: "${l}" fits ${w}`,
    wide(l, 'Times-Bold', 9) <= w - 8, { width: +wide(l, 'Times-Bold', 9).toFixed(1), usable: w - 8 })));

console.log('And the guard that was being relied on does not work:');
{
  const d = new PDFDocument({ size: 'A4' });
  d.font('Times-Roman').fontSize(9);
  const before = d.y;
  d.text('Chairpersons & Co-chairpersons', 50, 400, { width: 112, lineBreak: false });
  ok('lineBreak:false still takes two lines — so the row must be measured, not pinned',
    (d.y - 400) > 15, { moved: +(d.y - 400).toFixed(1) });
}

// ---- the closing block, read back off the finished PDF ---------------------
const S1 = {
  service: '1st', total: 202186,
  categories: {
    seed: { 'Harvest Committee': 22400, Session: 10000, Congregation: 12950 },
    gratitude: 31246, chairpersons: 75850,
    dayborn: { Sunday: 2755, Monday: 25510, Tuesday: 2810, Wednesday: 2495, Thursday: 5970, Friday: 2750, Saturday: 7450 },
  },
  methods: { cash: 112686, cheque: 72000, momo: 6000, transfer: 0 },
  iouTotal: 11500, forexGhs: 0, ghsSubtotal: 202186,
  cashCount: { n200: 95, n100: 343 },
  catMethods: { chairpersons: { cash: 45850, chequeTotal: 30000, transferTotal: 0, momo: 0, forexGhs: 0, total: 75850 } },
  cheques: [{ number: '000706', bank: 'GCB', category: 'Chairpersons & Co-chairpersons', amount: 30000 }],
  transfers: [], forex: [],
};
const S2 = {
  service: '2nd', total: 45350,
  categories: { seed: { 'Harvest Committee': 22400, Session: 10000, Congregation: 12950 }, gratitude: 0, chairpersons: 0, dayborn: {} },
  methods: { cash: 45350, cheque: 0, momo: 0, transfer: 0 },
  iouTotal: 0, forexGhs: 0, ghsSubtotal: 45350, cashCount: {}, catMethods: {}, cheques: [], transfers: [], forex: [],
};

(async () => {
  const buf = await buildAnnouncementPdf({
    event: { name: '2nd Fundraising', target: 400000 },
    date: '2026-08-30', entries: [S1, S2],
    dayborn: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    seedCategories: ['Harvest Committee', 'Session', 'Congregation'],
    denoms: [{ key: 'n200', label: 'GHS 200 note', value: 200 }, { key: 'n100', label: 'GHS 100 note', value: 100 }],
  });
  ok('the announcement builds', Buffer.isBuffer(buf) && buf.length > 20000, buf && buf.length);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpdf-'));
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, buf);
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }); }
  catch (e) { console.log('(pdftotext not on this box — skipping the read-back checks)'); }

  if (text) {
    console.log('The closing block — by service, then the day, then the seed:');
    // The summary is now a table with one column per service and a Total, so a
    // line carries several figures. Read them ALL and check the row adds up —
    // the old assertion took the first number, which is now the 1st service.
    // The LAST occurrence: "Chairpersons & Co-chairpersons" also appears in the
    // Breakdown-by-basket table and against every cheque row above, and the
    // first match was picking the breakdown row's six figures.
    const nums = label => {
      const re = new RegExp('^[ \\t]*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]+(.+)$', 'gm');
      const all = [...text.matchAll(re)];
      if (!all.length) return null;
      const last = all[all.length - 1][1];
      return (last.match(/[\d,]+\.\d\d/g) || []).map(x => Number(x.replace(/,/g, '')));
    };
    const grat = nums('Gratitude & Thanksgiving Offering');
    const born = nums('Day-born Offerings');
    const chair = nums('Chairpersons & Co-chairpersons');
    const day = nums('THE DAY’S OFFERINGS');
    const seed = nums('Seed Contributions');
    const svct = nums('SERVICE TOTAL');

    ok('the summary has a column per service and a Total', grat && grat.length === 3, grat);
    ok('the service headings are printed', /1st Service\s+2nd Service\s+Total/.test(text),
      (text.match(/.*1st Service.*/) || [''])[0]);

    ok('Gratitude by service, then combined', grat && grat[0] === 31246 && grat[1] === 0 && grat[2] === 31246, grat);
    ok('the day-borns likewise', born && born[0] === 49740 && born[2] === 49740, born);
    ok('the Chairpersons likewise', chair && chair[0] === 75850 && chair[2] === 75850, chair);

    console.log('And every figure reconciles, down the columns and across the rows:');
    ok('each row totals across', [grat, born, chair, seed, day, svct]
      .every(r => r && Math.abs(r[0] + r[1] - r[2]) < 0.01),
      [grat, born, chair, seed, day, svct]);
    ok('the day’s offerings are the three added, per service',
      day && Math.abs(day[0] - (grat[0] + born[0] + chair[0])) < 0.01
        && Math.abs(day[1] - (grat[1] + born[1] + chair[1])) < 0.01, day);
    ok('the seed is stated after them, not mixed in', seed && seed[0] === 45350 && seed[1] === 45350 && seed[2] === 90700, seed);
    ok('each service total is its day plus its seed',
      svct && Math.abs(svct[0] - (day[0] + seed[0])) < 0.01 && Math.abs(svct[1] - (day[1] + seed[1])) < 0.01, svct);
    ok('the day’s offerings come BEFORE the seed line', text.indexOf('THE DAY') < text.indexOf('Seed Contributions'));

    const grand = (text.match(/GRAND TOTAL \(all in GHS\): GHS ([\d,]+\.\d\d)/) || [])[1];
    const grandN = grand ? Number(grand.replace(/,/g, '')) : null;
    ok('and the grand total matches the Total column', grandN === 247536 && grandN === svct[2],
      { grand: grandN, column: svct && svct[2] });

    console.log('Nothing is stranded on a page of its own:');
    ok('the target line sits with the grand total',
      Math.abs(text.indexOf('Event target') - text.indexOf('GRAND TOTAL')) < 400,
      { target: text.indexOf('Event target'), grand: text.indexOf('GRAND TOTAL') });
    ok('and so does the verse', text.indexOf('cheerful giver') > text.indexOf('GRAND TOTAL'));
  }

  console.log('The day-borns are ranked PER SERVICE, not by the two added together:');
  {
    // Figures chosen so the services disagree completely: the 1st leads with
    // Monday, the 2nd with Wednesday, and Monday is LAST in the 2nd.
    const born = (svc, total, db) => ({
      service: svc, total,
      categories: { seed: {}, gratitude: 0, chairpersons: 0, dayborn: db, activities: {} },
      methods: { cash: total, cheque: 0, momo: 0, transfer: 0 },
      iouTotal: 0, forexGhs: 0, ghsSubtotal: total,
      cashCount: {}, catMethods: {}, cheques: [], transfers: [], forex: [],
    });
    const b = await buildAnnouncementPdf({
      event: { name: '2nd Fundraising', target: 0 }, date: '2026-08-30',
      entries: [
        born('1st', 49740, { Sunday: 2755, Monday: 25510, Tuesday: 2810, Wednesday: 2495, Thursday: 5970, Friday: 2750, Saturday: 7450 }),
        born('2nd', 25100, { Sunday: 6000, Monday: 200, Tuesday: 1000, Wednesday: 9000, Thursday: 500, Friday: 8000, Saturday: 400 }),
      ],
      dayborn: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      seedCategories: [], activityCategories: [], denoms: [],
    });
    const rf = path.join(dir, 'r.pdf');
    fs.writeFileSync(rf, b);
    let rt = '';
    try { rt = execFileSync('pdftotext', ['-layout', rf, '-'], { encoding: 'utf8' }); } catch (e) {}
    if (rt) {
      ok('the table no longer claims to be ranked when there are two services',
        /ordered by the two/.test(rt) && !/DAY-BORN OFFERINGS \(ranked/.test(rt),
        (rt.match(/DAY-BORN OFFERINGS[^\n]*/) || [''])[0]);
      ok('a ranked list is printed', /Day-born offerings, ranked/.test(rt));

      const block = rt.slice(rt.indexOf('Day-born offerings, ranked'));
      const svcLine = label => {
        const i = block.indexOf(label);
        return i < 0 ? '' : block.slice(i, i + 400).replace(/\s+/g, ' ');
      };
      const first = svcLine('1st service');
      const second = svcLine('2nd service');
      ok('the 1st service leads with Monday', /1\. Monday-borns 25,510\.00/.test(first), first.slice(0, 90));
      ok('and its second is Saturday', /2\. Saturday-borns 7,450\.00/.test(first), first.slice(0, 120));
      ok('the 2nd service leads with Wednesday — a different day',
        /1\. Wednesday-borns 9,000\.00/.test(second), second.slice(0, 90));
      ok('and its second is Friday', /2\. Friday-borns 8,000\.00/.test(second), second.slice(0, 120));
      ok('Monday is LAST in the 2nd service, though it led the 1st',
        /7\. Monday-borns 200\.00/.test(second), second.slice(0, 220));
      ok('so the two orders genuinely differ', first.slice(0, 40) !== second.slice(0, 40));
    }
  }

  console.log('A joint day gets one column, not a Total beside a single figure:');
  {
    const joint = await buildAnnouncementPdf({
      event: { name: 'Main Harvest', target: 0 }, date: '2026-12-06',
      entries: [{ ...S1, service: 'joint' }],
      dayborn: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      seedCategories: ['Harvest Committee', 'Session', 'Congregation'],
      denoms: [{ key: 'n200', label: 'GHS 200 note', value: 200 }],
    });
    ok('it builds', Buffer.isBuffer(joint) && joint.length > 20000, joint && joint.length);
    const jf = path.join(dir, 'j.pdf');
    fs.writeFileSync(jf, joint);
    let jt = '';
    try { jt = execFileSync('pdftotext', ['-layout', jf, '-'], { encoding: 'utf8' }); } catch (e) {}
    if (jt) {
      ok('no service columns are printed', !/1st Service\s+2nd Service/.test(jt));
      ok('the column is headed simply', /Amount/.test(jt));
      ok('and it reads TOTAL, not SERVICE TOTAL', /\bTOTAL\b/.test(jt) && !/SERVICE TOTAL/.test(jt));
      const one = (jt.match(/Gratitude & Thanksgiving Offering\s+([\d,]+\.\d\d)/) || [])[1];
      ok('with one figure against each line', one === '31,246.00', one);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${fail} FAILED, ${pass} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
