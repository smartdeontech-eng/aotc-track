// Announcement PDF for a fundraising day — A4, church letterhead. Four giving
// areas per service (Seed Contributions · Gratitude & Thanksgiving Offering ·
// Day-born Offerings · Chairpersons), then payment methods: the cash
// denomination count, the per-basket breakdown, the cheque register and the
// bank-transfer register, then the grand total.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { toLocalDate } = require('./dates');

const A4 = { width: 595.28, height: 841.89 };
const M = { top: 60, bottom: 60, left: 50, right: 50 };
const USABLE = A4.width - M.left - M.right;
const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');
const money = v => 'GHS ' + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
// "Sunday, 30 August 2026" — the same form the announcement heads a day with.
const dayLabel = iso => {
  const d = toLocalDate(iso);
  return isNaN(d) ? String(iso || '')
    : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
// Basket key -> printable name (mirrors the server's catLabel).
function catLabel(key) {
  if (key.startsWith('seed.')) return 'Seed — ' + key.slice(5);
  if (key.startsWith('activity.')) return 'Harvest Week — ' + key.slice(9);
  if (key.startsWith('dayborn.')) return key.slice(8) + '-borns';
  if (key === 'gratitude') return 'Gratitude & Thanksgiving';
  if (key === 'chairpersons') return 'Chairpersons & Co-chairpersons';
  return key;
}

function buildAnnouncementPdf({ event, date, entries, dayborn, seedCategories, activityCategories, denoms }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, info: { Title: `${event.name} announcement`, Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Letterhead
    doc.y = M.top - 10;
    doc.font('Times-Bold').fontSize(14).text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
    const crestW = 58;
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - crestW) / 2, crestY, { fit: [crestW, 66] }); } catch (e) {}
    doc.y = crestY + 70;
    doc.font('Times-Bold').fontSize(11.5).text('Adabraka Official Town Congregation', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 16;

    doc.font('Times-Bold').fontSize(13).text(`${event.name.toUpperCase()} — FUNDRAISING ANNOUNCEMENT`, M.left, doc.y, { width: USABLE, align: 'center' });
    doc.font('Times-Roman').fontSize(11).text(dayLabel(date), { width: USABLE, align: 'center' });
    doc.moveDown(0.8);

    const services = entries.slice().sort((a, b) => a.service.localeCompare(b.service));
    const cols = services.map(s => s.service === 'joint' ? 'Joint Service' : s.service + ' Service');
    // Day-borns, ordered by the COMBINED total across services — one table can
    // only be in one order. On a dual-service day the two services genuinely
    // rank differently (the 1st may lead with Monday while the 2nd leads with
    // Wednesday), so neither column reads in its own order here and the table
    // must not claim it does. Each service's own ranking is printed beneath the
    // table instead; see rankedLines() below.
    const bornOfSvc = (sv, d) => Number(((sv.categories || {}).dayborn || {})[d]) || 0;
    const rankedDayborn = dayborn.slice().sort((d1, d2) =>
      services.reduce((s, sv) => s + bornOfSvc(sv, d2), 0) -
      services.reduce((s, sv) => s + bornOfSvc(sv, d1), 0));
    // One service's own order, highest first, with the zeros left out — a
    // basket that received nothing was not "last", it simply did not feature.
    const rankedFor = sv => dayborn.slice()
      .map(d => [d, bornOfSvc(sv, d)])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    // Seed contributions — this year's sub-categories plus any legacy name that
    // still carries a figure on this day.
    const seedOf = (s, k) => Number(((s.categories || {}).seed || {})[k] || 0);
    const seedKeys = [...new Set([...(seedCategories || []), ...services.flatMap(s => Object.keys((s.categories || {}).seed || {}))])]
      .filter(k => (seedCategories || []).includes(k) || services.some(s => seedOf(s, k) > 0));
    // This year's activities, plus any name that still carries a figure — the
    // same rule the seed block follows, so a renamed activity never silently
    // drops the money it raised.
    const actOf = (e, k) => Number(((e.categories || {}).activities || {})[k]) || 0;
    const actKeys = [...new Set([...(activityCategories || []),
      ...services.flatMap(e => Object.keys((e.categories || {}).activities || {}))])]
      .filter(k => (activityCategories || []).includes(k) || services.some(e => actOf(e, k) > 0));
    const spOf = (e, k) => Number(((e.categories || {}).special || {})[k]) || 0;
    const spKeys = [...new Set(services.flatMap(e => Object.keys((e.categories || {}).special || {})))].filter(k => services.some(e => spOf(e, k) > 0));
    // Four areas, each with its own heading: seed money, the harvest-day
    // gratitude offering, the day-born offerings and the chairpersons.
    const blank = services.map(() => '');
    const area = label => ({ cells: [label, ...blank], bold: true, shade: true });
    const line = (label, vals, bold) => ({ cells: [label, ...vals], bold: !!bold });
    const rows = [
      ...(seedKeys.length ? [
        area('SEED CONTRIBUTIONS'),
        ...seedKeys.map(k => line(`   ${k}`, services.map(s => seedOf(s, k)))),
        line('   Seed subtotal', services.map(s => seedKeys.reduce((a, k) => a + seedOf(s, k), 0)), true),
      ] : []),
      { cells: ['GRATITUDE & THANKSGIVING OFFERING', ...services.map(s => s.categories.gratitude)], bold: true, shade: true },
      area(services.length > 1
        ? 'DAY-BORN OFFERINGS  (ordered by the two services together)'
        : 'DAY-BORN OFFERINGS  (ranked highest first)'),
      ...rankedDayborn.map(d => line(`   ${d}-borns`, services.map(s => (s.categories.dayborn || {})[d] || 0))),
      { cells: ['CHAIRPERSONS & CO-CHAIRPERSONS', ...services.map(s => s.categories.chairpersons)], bold: true, shade: true },
      // The week's own activities — shown only when there are any, so a year
      // that ran none prints no empty heading.
      ...(actKeys.length ? [
        area('HARVEST WEEK ACTIVITIES'),
        ...actKeys.map(k => line(`   ${k}`, services.map(s => actOf(s, k)))),
        line('   Activities subtotal', services.map(s => actKeys.reduce((a, k) => a + actOf(s, k), 0)), true),
      ] : []),
      // Sheets added on the day for something that came up (22 Nov 2026).
      ...(spKeys.length ? [
        area('SPECIAL SHEETS'),
        ...spKeys.map(k => line(`   ${k}`, services.map(s => spOf(s, k)))),
        ...(spKeys.length > 1 ? [line('   Special sheets subtotal', services.map(s => spKeys.reduce((a, k) => a + spOf(s, k), 0)), true)] : []),
      ] : []),
    ];
    // The label column is 240, not the 190 it was. Measured in Times-Bold 10pt,
    // the area headings need more than 190 gave them:
    //
    //   GRATITUDE & THANKSGIVING OFFERING          207.9pt
    //   DAY-BORN OFFERINGS  (ranked highest first)  207.7pt
    //   CHAIRPERSONS & CO-CHAIRPERSONS             190.6pt
    //
    // against 180pt of usable width. All three wrapped, and because the row
    // height was a fixed 22 the second line printed below the row's own rule —
    // the struck-through look on the 30 August announcement. 240 gives 230pt,
    // which clears the longest of them. The service columns keep ample room:
    // "202,186.00" is about 55pt in a 127pt column.
    const LABEL_W = 240;
    const colW = (USABLE - LABEL_W) / services.length;
    const pad = 5;
    let y = doc.y;
    const drawRow = (cells, bold, shade) => {
      const widths = [LABEL_W, ...services.map(() => colW)];
      const font = bold ? 'Times-Bold' : 'Times-Roman';
      // The row is as tall as its tallest cell. A fixed height is what clipped
      // the headings, and widening the column alone would only postpone it —
      // a longer seed sub-category name would clip again.
      doc.font(font).fontSize(10);
      const h = Math.max(22, 12 + Math.max(...cells.map((c, i) =>
        doc.heightOfString(String(c), { width: widths[i] - pad * 2 }))));
      // The seed block and the method rows can push a busy day onto a 2nd page.
      if (y + h > A4.height - M.bottom) { doc.addPage(); y = M.top; }
      let x = M.left;
      if (shade) { doc.rect(M.left, y, USABLE, h).fill('#EEF1F7'); doc.fillColor('#000'); }
      cells.forEach((c, i) => {
        doc.rect(x, y, widths[i], h).lineWidth(0.5).stroke('#444');
        doc.font(font).fontSize(10).fillColor('#000')
          .text(String(c), x + pad, y + 6, { width: widths[i] - pad * 2, align: i === 0 ? 'left' : 'right' });
        x += widths[i];
      });
      y += h;
    };
    drawRow(['Category', ...cols], true, true);
    rows.forEach(r => drawRow(
      r.cells.map((v, i) => i === 0 || v === '' ? v : (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })),
      r.bold, r.shade));
    drawRow(['Service Total', ...services.map(s => (s.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }))], true, true);
    doc.y = y + 12;

    // Each service's day-borns in ITS OWN order — what is actually read out.
    // The table above cannot show this: it has one row per day shared by both
    // columns, so it is ordered by the two services together.
    const rankLines = services
      .map(sv => [sv, rankedFor(sv)])
      .filter(([, r]) => r.length);
    if (rankLines.length) {
      const needed = 16 + rankLines.length * 30;
      if (doc.y + needed > A4.height - M.bottom) doc.addPage();
      doc.font('Times-Bold').fontSize(10).fillColor('#000')
        .text('Day-born offerings, ranked', M.left, doc.y);
      doc.moveDown(0.2);
      rankLines.forEach(([sv, r]) => {
        const label = sv.service === 'joint' ? 'Joint service' : `${sv.service} service`;
        doc.font('Times-Bold').fontSize(9.5).fillColor('#000')
          .text(label, M.left + 6, doc.y, { width: USABLE - 12 });
        doc.font('Times-Roman').fontSize(9.5)
          .text(r.map(([d, v], i) => `${i + 1}. ${d}-borns ${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`).join('   ·   '),
            M.left + 6, doc.y + 1, { width: USABLE - 12 });
        doc.moveDown(0.35);
      });
      doc.moveDown(0.3);
    } else {
      doc.y += 4;
    }

    // How it came in — payment methods (only when a breakdown was recorded).
    const hasMethods = services.some(s => s.methods && ((s.methods.cash || 0) + (s.methods.cheque || 0) + (s.methods.momo || 0) + (s.iouTotal || 0) + (s.forexGhs || 0)) > 0);
    if (hasMethods) {
      doc.font('Times-Bold').fontSize(11).text('How it came in (payment methods)', M.left, doc.y);
      doc.moveDown(0.2);
      y = doc.y;
      const mRows = [
        ['Cash', ...services.map(s => (s.methods || {}).cash || 0)],
        ['Cheques', ...services.map(s => (s.methods || {}).cheque || 0)],
        ['Mobile Money', ...services.map(s => (s.methods || {}).momo || 0)],
        ['Bank Transfers', ...services.map(s => (s.methods || {}).transfer || 0)],
        ['IOUs (pledged)', ...services.map(s => s.iouTotal || 0)],
      ];
      drawRow(['Method', ...cols], true, true);
      mRows.forEach(r => drawRow([r[0], ...r.slice(1).map(v => (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }))], false, false));
      drawRow(['GHS subtotal', ...services.map(s => (s.ghsSubtotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }))], true, true);
      doc.y = y + 10;

      // A plain bordered table for the registers below (independent of the
      // per-service column layout above).
      // `lineBreak: false` used to be passed here to stop long labels wrapping.
      // It does not work — measured, "Chairpersons & Co-chairpersons" takes two
      // lines either way — so the row is measured and grown instead, which is
      // the only thing that actually keeps text inside its own rules.
      const simple = (widths, tRows, numericCols) => {
        const sp = 4;
        let sy = doc.y;
        tRows.forEach(r => {
          const font = r.bold ? 'Times-Bold' : 'Times-Roman';
          doc.font(font).fontSize(9);
          const h = Math.max(17, 9 + Math.max(...r.cells.map((c, i) =>
            doc.heightOfString(String(c), { width: widths[i] - sp * 2 }))));
          if (sy + h > A4.height - M.bottom) { doc.addPage(); sy = M.top; }
          let x = M.left;
          if (r.shade) { doc.rect(M.left, sy, widths.reduce((a, b) => a + b, 0), h).fill('#EEF1F7'); doc.fillColor('#000'); }
          r.cells.forEach((c, i) => {
            doc.rect(x, sy, widths[i], h).lineWidth(0.5).stroke('#444');
            doc.font(font).fontSize(9).fillColor('#000')
              .text(String(c), x + sp, sy + 4.5, { width: widths[i] - sp * 2, align: i === 0 ? 'left' : (numericCols || i === r.cells.length - 1) ? 'right' : 'left' });
            x += widths[i];
          });
          sy += h;
        });
        doc.y = sy + 10;
      };

      // Cash counting sheet — quantities combined across the day's services.
      const counts = {};
      services.forEach(s => Object.entries(s.cashCount || {}).forEach(([k, q]) => { counts[k] = (counts[k] || 0) + Number(q || 0); }));
      const denomList = denoms || [];
      if (Object.keys(counts).length && denomList.length) {
        if (doc.y > A4.height - M.bottom - 120) doc.addPage();
        doc.font('Times-Bold').fontSize(11).text('Cash counted — denomination breakdown', M.left, doc.y);
        doc.moveDown(0.2);
        const used = denomList.filter(d => counts[d.key]);
        const cashTot = used.reduce((a, d) => a + counts[d.key] * d.value, 0);
        simple([200, 145, 150], [
          { cells: ['Denomination', 'Quantity', 'Amount (GHS)'], bold: true, shade: true },
          ...used.map(d => ({ cells: [d.label, String(counts[d.key]), (counts[d.key] * d.value).toLocaleString(undefined, { minimumFractionDigits: 2 })] })),
          { cells: ['Total cash counted', '', cashTot.toLocaleString(undefined, { minimumFractionDigits: 2 })], bold: true, shade: true },
        ]);
      }

      // Baskets counted on their own
      const money2 = v => (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
      const bdKeys = [...new Set(services.flatMap(s => Object.keys(s.catMethods || {})))];
      if (bdKeys.length) {
        if (doc.y > A4.height - M.bottom - 120) doc.addPage();
        doc.font('Times-Bold').fontSize(11).text('Breakdown by basket', M.left, doc.y);
        doc.moveDown(0.2);
        const bdGet = (k, f) => services.reduce((a, s) => a + Number((((s.catMethods || {})[k]) || {})[f] || 0), 0);
        // Basket 140: "Chairpersons & Co-chairpersons" is 127.3pt bold at 9pt,
        // and 125 gave it 117. The 15 comes off the numeric columns, which hold
        // "247,536.00" in about 43pt.
        simple([140, 60, 60, 60, 52, 56, 67], [
          { cells: ['Basket', 'Cash', 'Cheques', 'Transfers', 'MoMo', 'Foreign', 'Total'], bold: true, shade: true },
          ...bdKeys.map(k => ({ cells: [catLabel(k), money2(bdGet(k, 'cash')), money2(bdGet(k, 'chequeTotal')), money2(bdGet(k, 'transferTotal')), money2(bdGet(k, 'momo')), money2(bdGet(k, 'forexGhs')), money2(bdGet(k, 'total'))] })),
          { cells: ['Counted baskets total', '', '', '', '', '', money2(bdKeys.reduce((a, k) => a + bdGet(k, 'total'), 0))], bold: true, shade: true },
        ], true);
      }

      // Cheque register
      const allChq = services.flatMap(s => (s.cheques || []).map(c => ({ ...c, service: s.service })));
      if (allChq.length) {
        if (doc.y > A4.height - M.bottom - 100) doc.addPage();
        doc.font('Times-Bold').fontSize(11).text('Cheques received', M.left, doc.y);
        doc.moveDown(0.2);
        // Basket 140, the same as the breakdown table: at 135 the usable width
        // was 127 and the bold label is 127.3 — no margin at all.
        simple([95, 115, 140, 50, 95], [
          { cells: ['Cheque no.', 'Bank', 'Basket', 'Service', 'Amount (GHS)'], bold: true, shade: true },
          ...allChq.map(c => ({ cells: [c.number || '—', c.bank || '—', c.category || 'service level', c.service, money2(c.amount)] })),
          { cells: ['Total', '', '', '', money2(allChq.reduce((a, c) => a + (Number(c.amount) || 0), 0))], bold: true, shade: true },
        ]);
      }

      // Bank transfer register
      const allTrf = services.flatMap(s => (s.transfers || []).map(t => ({ ...t, service: s.service })));
      if (allTrf.length) {
        if (doc.y > A4.height - M.bottom - 100) doc.addPage();
        doc.font('Times-Bold').fontSize(11).text('Bank transfers received', M.left, doc.y);
        doc.moveDown(0.2);
        simple([105, 100, 140, 55, 95], [
          { cells: ['Bank', 'Reference', 'Basket', 'Service', 'Amount (GHS)'], bold: true, shade: true },
          ...allTrf.map(t => ({ cells: [t.bank || '—', t.reference || '—', t.category || 'service level', t.service, money2(t.amount)] })),
          { cells: ['Total', '', '', '', money2(allTrf.reduce((a, t) => a + (Number(t.amount) || 0), 0))], bold: true, shade: true },
        ]);
      }
      y = doc.y;

      // Foreign currency listed separately, then the all-in-GHS figure.
      const allForex = services.flatMap(s => (s.forex || []).map(f => ({ ...f, service: s.service })));
      if (allForex.length) {
        doc.moveDown(0.4);
        doc.font('Times-Bold').fontSize(11).text('Foreign currency (converted at the day’s rates)', M.left, doc.y);
        doc.moveDown(0.2);
        const byCur = {};
        allForex.forEach(f => {
          byCur[f.currency] = byCur[f.currency] || { amount: 0, ghs: 0, rate: f.rate };
          byCur[f.currency].amount += f.amount; byCur[f.currency].ghs += f.ghs; byCur[f.currency].rate = f.rate;
        });
        Object.entries(byCur).forEach(([cur, v]) => {
          doc.font('Times-Roman').fontSize(10.5).text(
            `${cur} ${v.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}  @ ${v.rate}  =  ${money(v.ghs)}`,
            M.left + 10, doc.y);
        });
        const ghsSub = services.reduce((s2, s) => s2 + (s.ghsSubtotal || 0), 0);
        const fxGhs = services.reduce((s2, s) => s2 + (s.forexGhs || 0), 0);
        doc.moveDown(0.4);
        doc.font('Times-Bold').fontSize(10.5).text(`GHS subtotal: ${money(ghsSub)}   +   Forex (GHS equivalent): ${money(fxGhs)}`, M.left, doc.y);
      }
      doc.moveDown(0.8);
    }

    // ---- What the day itself brought, then the seed -----------------------
    // The congregation asks about the Sunday: the Gratitude offering, the
    // day-born baskets and the Chairpersons. Seed contributions are pledged at
    // the launch and merely booked against the day, so a single grand total
    // buries the thing everybody wants to know. The three are added on their
    // own first, and the seed joins only at the last line.
    //
    // Broken out BY SERVICE, like every other table in this document — on a
    // dual-service day the 1st and the 2nd are what the Session compares, and a
    // combined-only summary hides it.
    const gratOf = e => Number((e.categories || {}).gratitude) || 0;
    const bornOf = e => Object.values(((e.categories || {}).dayborn) || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    const chairOf = e => Number((e.categories || {}).chairpersons) || 0;
    const seedOf2 = e => Object.values(((e.categories || {}).seed) || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    const dayOf = e => gratOf(e) + bornOf(e) + chairOf(e);
    const sumAcross = f => services.reduce((a, e) => a + f(e), 0);
    const grand = services.reduce((s2, e) => s2 + (e.total || 0), 0);

    const closing = [
      { label: 'Gratitude & Thanksgiving Offering', of: gratOf },
      { label: 'Day-born Offerings', of: bornOf },
      { label: 'Chairpersons & Co-chairpersons', of: chairOf },
      { label: 'THE DAY’S OFFERINGS', of: dayOf, bold: true, rule: true },
      { label: 'Seed Contributions', of: seedOf2 },
    ];
    // The week's activities are neither the Sunday offering nor the seed, so
    // they get a line of their own — after the day, before the seed.
    const actTotalOf = e => Object.values(((e.categories || {}).activities) || {})
      .reduce((a, v) => a + (Number(v) || 0), 0);
    if (services.some(e => actTotalOf(e) > 0)) {
      closing.splice(4, 0, { label: 'Harvest Week Activities', of: actTotalOf });
    }
    const spTotalOf = e => Object.values(((e.categories || {}).special) || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    if (services.some(e => spTotalOf(e) > 0)) {
      closing.splice(closing.findIndex(c => c.label === 'Seed Contributions'), 0, { label: 'Special sheets', of: spTotalOf });
    }

    // One column per service, plus a Total column when there is more than one —
    // on a joint day a "Total" beside a single figure says nothing.
    const multi = services.length > 1;
    // Measured: the longest label is 167.9pt in Times-Bold 11 and the widest
    // realistic figure 57.8pt, so 200 for the label and 98 a column fits 495.
    const LBL_W = multi ? 200 : 260;
    const NUM_W = multi ? Math.min(98, (USABLE - LBL_W) / (services.length + 1)) : 120;
    const sumCols = multi ? [...services.map(e => e.service === 'joint' ? 'Joint' : e.service + ' Service'), 'Total'] : ['Amount'];
    const tblW = LBL_W + sumCols.length * NUM_W;
    const tx = i => M.left + (USABLE - tblW) / 2 + LBL_W + i * NUM_W;
    const lblX = M.left + (USABLE - tblW) / 2;

    // Keep the summary, the grand total, the target and the verse together —
    // they were falling apart across a page break, leaving a nearly empty last
    // page with the target line and the verse stranded on it.
    const closingH = 22 + closing.length * 18 + 34 + (event.target ? 20 : 0) + 60;
    if (doc.y + closingH > A4.height - M.bottom) doc.addPage();

    doc.moveDown(0.3);
    // Column headings.
    let cy = doc.y;
    doc.font('Times-Bold').fontSize(9.5).fillColor('#000');
    sumCols.forEach((c, i) => doc.text(c, tx(i), cy, { width: NUM_W - 6, align: 'right' }));
    cy += 13;
    doc.moveTo(lblX, cy - 2).lineTo(lblX + tblW, cy - 2).lineWidth(0.6).stroke('#444');
    cy += 2;

    closing.forEach(r => {
      const vals = multi ? [...services.map(e => r.of(e)), sumAcross(r.of)] : [sumAcross(r.of)];
      doc.font(r.bold ? 'Times-Bold' : 'Times-Roman').fontSize(11).fillColor('#000');
      doc.text(r.label, lblX, cy, { width: LBL_W - 8 });
      vals.forEach((v, i) => doc.font(r.bold ? 'Times-Bold' : 'Times-Roman').fontSize(11)
        .text((Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }),
          tx(i), cy, { width: NUM_W - 6, align: 'right' }));
      cy += 16;
      if (r.rule) {
        doc.moveTo(lblX, cy - 3).lineTo(lblX + tblW, cy - 3).lineWidth(0.6).stroke('#444');
        cy += 3;
      }
    });
    // The service totals — what each service brought in altogether.
    doc.moveTo(lblX, cy).lineTo(lblX + tblW, cy).lineWidth(1).stroke('#000');
    cy += 4;
    doc.font('Times-Bold').fontSize(11).fillColor('#000');
    doc.text(multi ? 'SERVICE TOTAL' : 'TOTAL', lblX, cy, { width: LBL_W - 8 });
    (multi ? [...services.map(e => e.total || 0), grand] : [grand]).forEach((v, i) =>
      doc.font('Times-Bold').fontSize(11)
        .text((Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 }),
          tx(i), cy, { width: NUM_W - 6, align: 'right' }));
    cy += 20;
    doc.y = cy;

    doc.font('Times-Bold').fontSize(13).text(`GRAND TOTAL (all in GHS): ${money(grand)}`, M.left, doc.y, { width: USABLE, align: 'center' });
    if (event.target) {
      doc.moveDown(0.4);
      doc.font('Times-Roman').fontSize(10.5)
        .text(`Event target: ${money(event.target)} · Achieved so far counts toward the target.`, M.left, doc.y, { width: USABLE, align: 'center' });
    }
    doc.moveDown(1.2);
    doc.font('Times-Roman').fontSize(10.5).text('“Each of you should give what you have decided in your heart to give, not reluctantly or under compulsion, for God loves a cheerful giver.” — 2 Corinthians 9:7', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.end();
  });
}

// ---- The counting sheet ----------------------------------------------------
// A paper pro-forma for the counting team, filled in on the day BEFORE anything
// is typed. It mirrors the entry form basket for basket and method for method,
// so transcription is mechanical: every box on paper has exactly one box on
// screen. Where the two drift, the transcription starts needing judgement,
// which is where errors come from — so this is generated from the same
// `seedCategories` and `DENOMS` the form is built from, never hand-maintained.
//
// Three pages, because a counting team works in three passes:
//   1. the basket grid — what each basket holds, by method
//   2. the denomination count — one sheet per basket counted note by note
//   3. the registers — cheques, transfers, pledges, foreign notes
function buildCountingSheetPdf({ event, date, dayborn, seedCategories, activityCategories, denoms, services }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true,
      info: { Title: `${event ? event.name : 'Fundraising'} counting sheet`, Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const svc = (services && services.length ? services : ['1st', '2nd']);
    // Hand-filled boxes need room. 26pt is what a written figure and a set of
    // initials actually take; the printed reports use 17–22.
    const RH = 26;
    const rule = (x1, y1, x2, y2, w) => doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w || 0.6).stroke('#444');

    const letterhead = (sub) => {
      doc.y = M.top - 20;
      doc.font('Times-Bold').fontSize(13).fillColor('#000')
        .text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
      doc.font('Times-Bold').fontSize(10.5)
        .text('Adabraka Official Town Congregation', M.left, doc.y + 1, { width: USABLE, align: 'center' });
      doc.moveDown(0.3);
      doc.font('Times-Bold').fontSize(12.5)
        .text('COUNTING SHEET', M.left, doc.y, { width: USABLE, align: 'center' });
      doc.font('Times-Roman').fontSize(9.5)
        .text('To be completed by hand on the day, then entered into AOTC Track. Do not enter anything not written here.',
          M.left, doc.y + 2, { width: USABLE, align: 'center' });
      if (sub) {
        doc.font('Times-Bold').fontSize(10.5).text(sub, M.left, doc.y + 4, { width: USABLE, align: 'center' });
      }
      doc.moveDown(0.6);
    };
    // Pages get separated on a counting table, so each one has to say what it
    // is and who wrote it.
    const footer = (what) => {
      // The footer sits INSIDE the bottom margin, and pdfkit adds a page the
      // moment text would cross that line — which turned a three-page sheet
      // into ten. Drop the margin for the two writes, then put it back.
      const keep = doc.page.margins.bottom;
      const savedY = doc.y;
      doc.page.margins.bottom = 0;
      const fy = A4.height - keep + 16;
      doc.font('Times-Roman').fontSize(8).fillColor('#555');
      doc.text(`${what}${date ? ' · ' + date : ''}`, M.left, fy, { width: 300, lineBreak: false });
      doc.text('Counter’s initials', M.left + 330, fy, { width: 80, lineBreak: false });
      doc.moveTo(M.left + 400, fy + 9).lineTo(M.left + 495, fy + 9).lineWidth(0.5).stroke('#888');
      doc.fillColor('#000');
      doc.page.margins.bottom = keep;
      doc.y = savedY;
    };

    // A labelled blank the team writes into.
    const blanks = (items, y) => {
      let x = M.left;
      items.forEach(([label, w]) => {
        doc.font('Times-Roman').fontSize(9.5).fillColor('#000').text(label, x, y, { width: w, lineBreak: false });
        const lx = x + doc.widthOfString(label) + 3;
        rule(lx, y + 11, x + w - 6, y + 11);
        x += w;
      });
      return y + 22;
    };

    // ---- Page 1: the basket grid ----
    letterhead(`${event ? event.name : ''}${event && date ? ' — ' : ''}${date ? dayLabel(date) : ''}`);
    let y = doc.y;
    y = blanks([['Event:', 150], ['Date:', 130], ['Service (1st / 2nd / Joint):', 215]], y);
    y = blanks([['Counted by:', 165], ['and:', 165], ['Witnessed by:', 165]], y) + 2;

    // Columns: the basket, then one column per method, then the total. These are
    // exactly the boxes the entry form has for a basket breakdown.
    // 495 exactly, which is the usable width — the first cut came to 516 and ran
    // past the right margin. Basket is 150 because the longest label,
    // "   Chairpersons & Co-chairpersons", measures 131.7pt in Times-Roman 9.5
    // and 132 gave it 124. Same fault, same lesson as the announcement.
    const COLS = [
      ['Basket', 150, 'left'],
      ['Cash', 52, 'right'],
      ['MoMo', 46, 'right'],
      ['Cheques', 52, 'right'],
      ['Transfer', 50, 'right'],
      ['Foreign', 46, 'right'],
      ['Pledges', 46, 'right'],
      ['TOTAL', 53, 'right'],
    ];
    const gridW = COLS.reduce((a, c) => a + c[1], 0);
    const cx = i => M.left + COLS.slice(0, i).reduce((a, c) => a + c[1], 0);

    const gridRow = (label, opts = {}) => {
      // The row grows to hold its label. A fixed height is what clipped
      // "CHAIRPERSONS & CO-CHAIRPERSONS" in the announcement, and this sheet
      // repeated it until it was rendered and looked at.
      doc.font(opts.bold ? 'Times-Bold' : 'Times-Roman').fontSize(9.5);
      const need = doc.heightOfString(String(label), { width: COLS[0][1] - 8 }) + 14;
      const h = opts.head ? 20 : Math.max(RH, need);
      if (y + h > A4.height - M.bottom) { doc.addPage(); letterhead(''); y = doc.y; }
      if (opts.shade) { doc.rect(M.left, y, gridW, h).fill('#EEF1F7'); doc.fillColor('#000'); }
      COLS.forEach((c, i) => {
        doc.rect(cx(i), y, c[1], h).lineWidth(0.6).stroke('#444');
        const txt = i === 0 ? label : (opts.head ? c[0] : '');
        if (txt) {
          doc.font(opts.head || opts.bold ? 'Times-Bold' : 'Times-Roman').fontSize(opts.head ? 9 : 9.5).fillColor('#000')
            .text(String(txt), cx(i) + 4, y + (opts.head ? 6 : 8),
              { width: c[1] - 8, align: i === 0 ? 'left' : c[2] });
        }
        if (opts.head && i > 0) {
          doc.font('Times-Bold').fontSize(9).text(c[0], cx(i) + 4, y + 6, { width: c[1] - 8, align: 'right' });
        }
      });
      y += h;
    };
    // The heading row, drawn once.
    if (y + 20 > A4.height - M.bottom) { doc.addPage(); letterhead(''); y = doc.y; }
    doc.rect(M.left, y, gridW, 20).fill('#EEF1F7'); doc.fillColor('#000');
    COLS.forEach((c, i) => {
      doc.rect(cx(i), y, c[1], 20).lineWidth(0.6).stroke('#444');
      doc.font('Times-Bold').fontSize(9).fillColor('#000')
        .text(c[0], cx(i) + 4, y + 6, { width: c[1] - 8, align: i === 0 ? 'left' : 'right' });
    });
    y += 20;

    const area = t => {
      if (y + 18 > A4.height - M.bottom) { doc.addPage(); letterhead(''); y = doc.y; }
      doc.rect(M.left, y, gridW, 18).fill('#DDE3F0'); doc.fillColor('#000');
      doc.rect(M.left, y, gridW, 18).lineWidth(0.6).stroke('#444');
      doc.font('Times-Bold').fontSize(9).text(t, M.left + 4, y + 5, { width: gridW - 8 });
      y += 18;
    };

    area('SEED CONTRIBUTIONS');
    (seedCategories || []).forEach(k => gridRow('   ' + k));
    area('GRATITUDE & THANKSGIVING OFFERING');
    gridRow('   Gratitude & Thanksgiving');
    area('DAY-BORN OFFERINGS');
    (dayborn || []).forEach(d => gridRow('   ' + d + '-borns'));
    area('CHAIRPERSONS & CO-CHAIRPERSONS');
    gridRow('   Chairpersons & Co-chairpersons');
    if ((activityCategories || []).length) {
      area('HARVEST WEEK ACTIVITIES');
      (activityCategories || []).forEach(a => gridRow('   ' + a));
    }
    area('NOT ATTRIBUTED TO A BASKET  (entered on the service panel)');
    gridRow('   Service level');
    gridRow('GRAND TOTAL', { bold: true, shade: true });

    // The reconciliation the app will enforce at submit, done here first on
    // paper — which is the whole point of a counting sheet.
    y += 10;
    // 84, not 56: line B wraps to two lines and was printing over the sentence
    // beneath it. Measured rather than guessed at.
    const BOXH = 84;
    if (y + BOXH + 20 > A4.height - M.bottom) { doc.addPage(); letterhead(''); y = doc.y; }
    doc.font('Times-Bold').fontSize(10).fillColor('#000').text('Check before entering', M.left, y);
    y += 14;
    doc.rect(M.left, y, gridW, BOXH).lineWidth(0.6).stroke('#444');
    doc.font('Times-Roman').fontSize(9.5);
    doc.text('A.  Baskets added down the TOTAL column', M.left + 8, y + 9, { width: 290 });
    rule(M.left + 305, y + 20, M.left + gridW - 12, y + 20);
    doc.text('B.  Methods added across', M.left + 8, y + 30, { width: 290 });
    doc.font('Times-Roman').fontSize(8.5)
      .text('(cash + MoMo + cheques + transfers + foreign + pledges)', M.left + 20, y + 41, { width: 270 });
    rule(M.left + 305, y + 41, M.left + gridW - 12, y + 41);
    doc.font('Times-Bold').fontSize(9.5).text('A and B must be the same figure. If they are not, count again before typing.',
      M.left + 8, y + 60, { width: gridW - 16 });
    y += BOXH + 12;

    footer('Counting sheet — baskets');

    // ---- Page 2: the denomination count ----
    doc.addPage();
    letterhead('CASH COUNTED — one sheet per basket counted note by note');
    y = doc.y;
    y = blanks([['Basket:', 260], ['Service:', 120], ['Counted by:', 115]], y) + 4;
    const DC = [['Denomination', 150], ['Quantity', 78], ['Amount (GHS)', 100]];
    const dcW = DC.reduce((a, c) => a + c[1], 0);
    const dcx = i => M.left + DC.slice(0, i).reduce((a, c) => a + c[1], 0);
    const dRow = (cells, opts = {}) => {
      const h = opts.head ? 19 : 22;
      if (y + h > A4.height - M.bottom) { doc.addPage(); letterhead('CASH COUNTED (continued)'); y = doc.y; }
      if (opts.shade) { doc.rect(M.left, y, dcW, h).fill('#EEF1F7'); doc.fillColor('#000'); }
      DC.forEach((c, i) => {
        doc.rect(dcx(i), y, c[1], h).lineWidth(0.6).stroke('#444');
        if (cells[i]) {
          doc.font(opts.head || opts.bold ? 'Times-Bold' : 'Times-Roman').fontSize(9.5).fillColor('#000')
            .text(String(cells[i]), dcx(i) + 4, y + (opts.head ? 5 : 7), { width: c[1] - 8, align: i === 0 ? 'left' : 'right' });
        }
      });
      y += h;
    };
    dRow(DC.map(c => c[0]), { head: true, shade: true });
    const notes = (denoms || []).filter(d => d.kind !== 'coin');
    const coins = (denoms || []).filter(d => d.kind === 'coin');
    notes.forEach(d => dRow([d.label, '', '']));
    if (coins.length) {
      dRow(['COINS', '', ''], { bold: true, shade: true });
      coins.forEach(d => dRow([d.label, '', '']));
    }
    dRow(['TOTAL CASH COUNTED', '', ''], { bold: true, shade: true });
    doc.font('Times-Roman').fontSize(9).text(
      'Quantity × face value = amount. The total here must equal the Cash box for this basket on page 1.',
      M.left, y + 6, { width: dcW });

    footer('Counting sheet — cash counted');

    // ---- Page 3: the registers ----
    doc.addPage();
    letterhead('REGISTERS — every cheque, transfer, pledge and foreign note');
    y = doc.y;
    const reg = (title, cols, rows, note) => {
      if (y + 40 + rows * 22 > A4.height - M.bottom) { doc.addPage(); letterhead('REGISTERS (continued)'); y = doc.y; }
      doc.font('Times-Bold').fontSize(10.5).fillColor('#000').text(title, M.left, y);
      y += 14;
      const w = cols.reduce((a, c) => a + c[1], 0);
      const rx = i => M.left + cols.slice(0, i).reduce((a, c) => a + c[1], 0);
      doc.rect(M.left, y, w, 19).fill('#EEF1F7'); doc.fillColor('#000');
      cols.forEach((c, i) => {
        doc.rect(rx(i), y, c[1], 19).lineWidth(0.6).stroke('#444');
        doc.font('Times-Bold').fontSize(9).text(c[0], rx(i) + 4, y + 5, { width: c[1] - 8 });
      });
      y += 19;
      for (let r = 0; r < rows; r += 1) {
        cols.forEach((c, i) => { doc.rect(rx(i), y, c[1], 22).lineWidth(0.6).stroke('#444'); });
        y += 22;
      }
      if (note) {
        doc.font('Times-Roman').fontSize(8.5).fillColor('#000').text(note, M.left, y + 3, { width: w });
        y += 14;
      }
      y += 8;
    };
    reg('Cheques received', [['Cheque no.', 90], ['Bank', 105], ['Which basket', 135], ['Svc', 40], ['Amount (GHS)', 95]], 7,
      'The cheque number is required in the app. A cheque with no number cannot be entered.');
    reg('Bank transfers', [['Bank', 105], ['Reference', 120], ['Which basket', 135], ['Svc', 40], ['Amount (GHS)', 65]], 5,
      'The bank is required in the app.');
    reg('Pledges (IOUs)', [['Name', 130], ['Contact', 100], ['Which basket', 110], ['Amount', 70], ['Promised by (date)', 85]], 6,
      'A promised date is required — it drives the reminders. A pledge counts toward the basket it was made in.');
    reg('Foreign currency', [['Currency', 70], ['Amount', 80], ['Rate for the day', 100], ['Which basket', 145], ['GHS', 100]], 4,
      'One rate per currency for the WHOLE day — agree it once and write it here. The app refuses a foreign note whose currency has no rate.');

    footer('Counting sheet — registers and sign-off');
    signOff();
    doc.end();

    // ---- Sign-off --------------------------------------------------------
    // The same chain the app enforces — counted, checked by the Harvest
    // Committee, entered, verified by the Accounts Clerk, approved by the
    // Treasurer — so the paper and the system tell one story. A sheet signed by
    // nobody is a note; this is the record the entry is made from, and it is
    // what the Treasurer holds against the figures if they are ever queried.
    function signOff() {
      const ROWS = [
        ['Counted by', 'Name and signature of the first counter'],
        ['Counted by', 'Name and signature of the second counter'],
        ['Checked by', 'Harvest Committee — the sheet adds up and A = B'],
        ['Entered by', 'Typed into AOTC Track from this sheet'],
        ['Verified by', 'Accounts Clerk — after entry (verifies in the app)'],
        ['Approved by', 'Treasurer — approves and locks the figures'],
      ];
      const H = 34;
      const W = [96, 190, 118, 91];        // 495
      if (doc.y + 30 + ROWS.length * H > A4.height - M.bottom) doc.addPage();
      let yy = Math.max(y, doc.y) + 6;
      doc.font('Times-Bold').fontSize(11).fillColor('#000').text('SIGN-OFF', M.left, yy);
      doc.font('Times-Roman').fontSize(8.5)
        .text('No figure is entered into AOTC Track from an unsigned sheet. Keep this sheet with the day’s records.',
          M.left, yy + 13, { width: 495 });
      yy += 28;
      const xs = i => M.left + W.slice(0, i).reduce((a, b) => a + b, 0);
      const head = ['Role', 'Name', 'Signature', 'Date'];
      doc.rect(M.left, yy, 495, 18).fill('#EEF1F7'); doc.fillColor('#000');
      head.forEach((h, i) => {
        doc.rect(xs(i), yy, W[i], 18).lineWidth(0.6).stroke('#444');
        doc.font('Times-Bold').fontSize(9).text(h, xs(i) + 4, yy + 5, { width: W[i] - 8 });
      });
      yy += 18;
      ROWS.forEach(([role, hint]) => {
        W.forEach((w, i) => { doc.rect(xs(i), yy, w, H).lineWidth(0.6).stroke('#444'); });
        doc.font('Times-Bold').fontSize(9).fillColor('#000').text(role, xs(0) + 4, yy + 5, { width: W[0] - 8 });
        doc.font('Times-Roman').fontSize(7.5).fillColor('#555')
          .text(hint, xs(0) + 4, yy + 17, { width: W[0] - 8 });
        doc.fillColor('#000');
        yy += H;
      });
      y = yy;
    }
  });
}

// Year statement: the Harvest Committee's account to Session — per-event
// inflows (by day), outflows, and net proceeds, with targets.
function buildStatementPdf({ year, events, entries, expenses, ious, annualTarget, seedCategories, activityCategories }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: `Fundraising statement ${year}`, Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.y = M.top - 10;
    doc.font('Times-Bold').fontSize(14).text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
    const crestW = 58;
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - crestW) / 2, crestY, { fit: [crestW, 66] }); } catch (e) {}
    doc.y = crestY + 70;
    doc.font('Times-Bold').fontSize(11.5).text('Adabraka Official Town Congregation', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 16;
    doc.font('Times-Bold').fontSize(13).text(`HARVEST & FUNDRAISING STATEMENT — ${year}`, M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.8);

    const pad = 5, rowH = 20;
    function tableRows(widths, rows, opts = {}) {
      rows.forEach(r => {
        if (doc.y + rowH > A4.height - M.bottom) doc.addPage();
        // .text() advances doc.y, so pin every cell of the row to rowY and
        // only move down once per row — otherwise the cells staircase.
        const rowY = doc.y;
        let x = M.left;
        if (r.shade) { doc.rect(M.left, rowY, widths.reduce((a, b) => a + b, 0), rowH).fill('#EEF1F7'); doc.fillColor('#000'); }
        r.cells.forEach((c, i) => {
          doc.rect(x, rowY, widths[i], rowH).lineWidth(0.5).stroke('#444');
          doc.font(r.bold ? 'Times-Bold' : 'Times-Roman').fontSize(9.5).fillColor('#000')
            .text(String(c), x + pad, rowY + 5, { width: widths[i] - pad * 2, align: i === 0 ? 'left' : 'right', lineBreak: false });
          x += widths[i];
        });
        doc.y = rowY + rowH;
      });
      doc.y += 10;
    }

    // Summary table
    doc.font('Times-Bold').fontSize(11).text('Summary by Event', M.left);
    doc.moveDown(0.2);
    const w1 = [150, 90, 90, 85, 80];
    tableRows(w1, [
      { cells: ['Event', 'Target', 'Raised', 'Expenses', 'Net'], bold: true, shade: true },
      ...events.map(ev => ({ cells: [ev.name, ev.target ? money(ev.target) : '—', money(ev.raised), money(ev.spent), money(ev.net)] })),
      { cells: ['TOTAL', annualTarget ? money(annualTarget) : '—',
        money(events.reduce((s2, e) => s2 + e.raised, 0)), money(events.reduce((s2, e) => s2 + e.spent, 0)),
        money(events.reduce((s2, e) => s2 + e.net, 0))], bold: true, shade: true },
    ]);

    // Seed contributions for the year, by the body that gave them
    const seedOf = (e, k) => Number(((e.categories || {}).seed || {})[k] || 0);
    const seedKeys = [...new Set([...(seedCategories || []), ...entries.flatMap(e => Object.keys((e.categories || {}).seed || {}))])];
    const seedTotals = seedKeys
      .map(k => [k, entries.reduce((s2, e) => s2 + seedOf(e, k), 0)])
      .filter(([k, v]) => v > 0 || (seedCategories || []).includes(k));
    if (seedTotals.length) {
      doc.font('Times-Bold').fontSize(11).text('Seed contributions', M.left);
      doc.moveDown(0.2);
      tableRows([250, 245], [
        { cells: ['Given by', 'Amount'], bold: true, shade: true },
        ...seedTotals.map(([k, v]) => ({ cells: [k, money(v)] })),
        { cells: ['TOTAL SEED', money(seedTotals.reduce((s2, x) => s2 + x[1], 0))], bold: true, shade: true },
      ]);
    }

    // The week's activities across the year, by activity — so the committee can
    // see which of them actually raised money and plan the next programme.
    const actOf2 = (e, k) => Number(((e.categories || {}).activities || {})[k] || 0);
    const actKeys2 = [...new Set([...(activityCategories || []),
      ...entries.flatMap(e => Object.keys((e.categories || {}).activities || {}))])];
    const actTotals = actKeys2
      .map(k => [k, entries.reduce((s2, e) => s2 + actOf2(e, k), 0)])
      .filter(([k, v]) => v > 0 || (activityCategories || []).includes(k));
    if (actTotals.length) {
      doc.font('Times-Bold').fontSize(11).text('Harvest week activities', M.left);
      doc.moveDown(0.2);
      tableRows([250, 245], [
        { cells: ['Activity', 'Amount'], bold: true, shade: true },
        ...actTotals.map(([k, v]) => ({ cells: [k, money(v)] })),
        { cells: ['TOTAL ACTIVITIES', money(actTotals.reduce((s2, x) => s2 + x[1], 0))], bold: true, shade: true },
      ]);
    }

    // Special sheets added on harvest days, by name (22 Nov 2026).
    const spOf2 = (e, k) => Number(((e.categories || {}).special || {})[k] || 0);
    const spTotals = [...new Set(entries.flatMap(e => Object.keys((e.categories || {}).special || {})))]
      .map(k => [k, entries.reduce((s2, e) => s2 + spOf2(e, k), 0)]).filter(([, v]) => v > 0);
    if (spTotals.length) {
      doc.font('Times-Bold').fontSize(11).text('Special sheets', M.left);
      doc.moveDown(0.2);
      tableRows([250, 245], [
        { cells: ['Sheet', 'Amount'], bold: true, shade: true },
        ...spTotals.map(([k, v]) => ({ cells: [k, money(v)] })),
        { cells: ['TOTAL SPECIAL SHEETS', money(spTotals.reduce((s2, x) => s2 + x[1], 0))], bold: true, shade: true },
      ]);
    }

    // How it came in — payment methods across the whole year
    const mt = { cash: 0, cheque: 0, momo: 0, transfer: 0, iou: 0, forex: 0 };
    entries.forEach(e => {
      const m = e.methods || {};
      mt.cash += Number(m.cash) || 0;
      mt.cheque += Number(m.cheque) || 0;
      mt.momo += Number(m.momo) || 0;
      mt.transfer += Number(m.transfer) || 0;
      mt.iou += Number(e.iouTotal) || 0;
      mt.forex += Number(e.forexGhs) || 0;
    });
    const mSum = Object.values(mt).reduce((a, b) => a + b, 0);
    if (mSum > 0) {
      doc.font('Times-Bold').fontSize(11).text('How it came in (year)', M.left);
      doc.moveDown(0.2);
      tableRows([250, 245], [
        { cells: ['Method', 'Amount'], bold: true, shade: true },
        { cells: ['Cash', money(mt.cash)] },
        { cells: ['Cheques', money(mt.cheque)] },
        { cells: ['Mobile Money', money(mt.momo)] },
        { cells: ['Bank Transfers', money(mt.transfer)] },
        { cells: ['IOUs (pledged)', money(mt.iou)] },
        { cells: ['Foreign currency (GHS equivalent)', money(mt.forex)] },
        { cells: ['TOTAL', money(mSum)], bold: true, shade: true },
      ]);
    }

    // Inflow detail
    if (entries.length) {
      doc.font('Times-Bold').fontSize(11).text('Inflows (by fundraising day)', M.left);
      doc.moveDown(0.2);
      const w2 = [140, 100, 80, 175];
      tableRows(w2, [
        { cells: ['Event', 'Date', 'Service', 'Amount'], bold: true, shade: true },
        ...entries.slice().sort((a, b) => a.date.localeCompare(b.date)).map(e => ({
          cells: [e.eventName, toLocalDate(e.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), e.service, money(e.total)],
        })),
      ]);
    }

    // IOU register — outstanding pledges first, then redeemed
    if ((ious || []).length) {
      doc.font('Times-Bold').fontSize(11).text('IOU register (pledges)', M.left);
      doc.moveDown(0.2);
      const w4 = [105, 95, 80, 65, 70, 80];
      const sorted = ious.slice().sort((a, b) => (a.status === b.status ? (a.dueDate || '').localeCompare(b.dueDate || '') : a.status === 'paid' ? 1 : -1));
      tableRows(w4, [
        { cells: ['Name', 'Basket', 'Amount', 'Due date', 'Status', 'Event / day'], bold: true, shade: true },
        ...sorted.map(i => ({ cells: [
          i.name, i.category || 'service level', money(i.amount),
          i.dueDate ? toLocalDate(i.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—',
          i.status === 'paid' ? 'PAID' : (i.dueDate && i.dueDate < new Date().toISOString().slice(0, 10) ? 'OVERDUE' : 'Outstanding'),
          `${i.eventName} ${toLocalDate(i.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        ] })),
        { cells: ['Outstanding total', '', money(ious.filter(i => i.status !== 'paid').reduce((s, i) => s + (i.amount || 0), 0)), '', '', ''], bold: true, shade: true },
      ]);
    }

    // Outflow detail
    if (expenses.length) {
      doc.font('Times-Bold').fontSize(11).text('Outflows (expenses)', M.left);
      doc.moveDown(0.2);
      const w3 = [140, 100, 175, 80];
      tableRows(w3, [
        { cells: ['Event', 'Date', 'Description', 'Amount'], bold: true, shade: true },
        ...expenses.map(x => ({ cells: [x.eventName, toLocalDate(x.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), x.description, money(x.amount)] })),
      ]);
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, M.left, A4.height - 40, { width: USABLE, align: 'center', lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}


// ---- Harvest basket sheets (17 Nov 2026) --------------------------------------
// One A4 per basket per service, printed with the event, date, service, basket
// and sheet number, so the counting team writes figures and nothing else.
// Then a "sheets returned" page per service. The crest sits faint behind every
// page; the disclaimer is the one the other AOTC forms carry.
const SH = { W: A4.width, H: A4.height, L: 34, NAVY: '#1f2a44', GRID: '#5a5a5a', TINT: '#eef1f7' };
SH.R = SH.W - SH.L; SH.FULL = SH.R - SH.L;
const DISCLAIMER = 'This form is an exclusive property of PCG – AOTC. Any disclosure, unauthorised reproduction or use is strictly prohibited except with permission from the Session of PCG – AOTC.';
const shortDay = iso => { const d = toLocalDate(iso); return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };
const pad2 = v => String(v).padStart(2, '0');
const svcName = s => (s === 'joint' ? 'Joint' : s);

function sheetKit(doc) {
  const box = (x, y, w, h, fill) => { if (fill) doc.rect(x, y, w, h).fill(fill); doc.rect(x, y, w, h).lineWidth(0.6).stroke(SH.GRID); };
  const t = (s, x, y, o = {}) => doc.font(o.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.s || 8).fillColor(o.c || '#000')
    .text(String(s), x, y, { width: o.w, align: o.a || 'left', lineBreak: !!o.wrap });
  const crest = fs.existsSync(CREST);
  const frame = (title) => {
    if (crest) doc.save().opacity(0.06).image(CREST, SH.W / 2 - 160, SH.H / 2 - 186, { width: 320 }).restore();
    if (crest) doc.image(CREST, SH.L, 22, { width: 40 });
    t('THE PRESBYTERIAN CHURCH OF GHANA', SH.L + 50, 26, { b: true, s: 10.5, c: SH.NAVY });
    t('Adabraka Official Town Congregation · Harvest Committee', SH.L + 50, 40, { s: 8.5, c: '#333' });
    t(title, SH.L + 50, 52, { b: true, s: 14 });
  };
  const footer = (right) => {
    doc.moveTo(SH.L, SH.H - 46).lineTo(SH.R, SH.H - 46).lineWidth(0.5).stroke('#999');
    t(DISCLAIMER, SH.L, SH.H - 41, { s: 6.5, c: '#555', w: SH.FULL - 150, wrap: true });
    t(right, SH.R - 135, SH.H - 41, { s: 6.5, c: '#555', w: 135, a: 'right' });
  };
  return { box, t, frame, footer };
}

function basketSheetPage(doc, { event, date, p, of, denoms }) {
  const { box, t, frame, footer } = sheetKit(doc);
  const { L, R, FULL, NAVY, TINT } = SH;
  frame('HARVEST BASKET SHEET');
  box(R - 92, 22, 92, 44, TINT);
  t('SHEET NO.', R - 92, 27, { s: 7, c: '#444', w: 92, a: 'center' });
  t(pad2(p.no), R - 92, 38, { b: true, s: 17, w: 92, a: 'center' });
  t(`of ${of} for the day`, R - 92, 56, { s: 6.5, c: '#555', w: 92, a: 'center' });

  let y = 76;
  box(L, y, FULL, 34, NAVY);
  t('BASKET', L + 8, y + 5, { s: 7, c: '#c9d1e6' });
  t(p.label.toUpperCase(), L + 8, y + 15, { b: true, s: p.label.length > 24 ? 11 : 14, c: '#fff', w: 215 });
  t('EVENT', L + 230, y + 5, { s: 7, c: '#c9d1e6' }); t(event ? event.name : '', L + 230, y + 16, { b: true, s: 10, c: '#fff', w: 110 });
  t('DATE', L + 345, y + 5, { s: 7, c: '#c9d1e6' }); t(shortDay(date), L + 345, y + 16, { b: true, s: 10, c: '#fff', w: 100 });
  t('SERVICE', L + 450, y + 5, { s: 7, c: '#c9d1e6' }); t(svcName(p.service), L + 450, y + 16, { b: true, s: 10, c: '#fff' });
  y += 40;
  if (p.key === 'seed') { t('Seed from (circle one):   Harvest Committee     Session     Congregation     Other: ______________________', L, y, { b: true, s: 8 }); y += 13; }
  t('Write the number of pieces of each note and coin, then the CASH TOTAL (a calculator is fine) — AOTC Track works out each line. List every cheque, MoMo, transfer, foreign note and pledge below. A second person recounts; both sign. A mistake is crossed through once and initialled.', L, y, { s: 7, c: '#444', w: FULL, wrap: true });
  y += 20;

  const rh = 15.5, cw = [92, 62, 82], cwT = cw.reduce((a, b) => a + b, 0);
  box(L, y, cwT, rh, TINT);
  t('CASH', L + 4, y + 4.5, { b: true, s: 7.5 });
  t('Pieces', L + cw[0], y + 4.5, { b: true, s: 7.5, w: cw[1] - 5, a: 'right' });
  t('Amount (optional)', L + cw[0] + cw[1], y + 4.5, { b: true, s: 7, w: cw[2] - 5, a: 'right' });
  denoms.forEach((d, i) => {
    const yy = y + rh * (i + 1); let x = L;
    cw.forEach(w => { box(x, yy, w, rh); x += w; });
    t(d.label, L + 4, yy + 4.5, { s: 7.5 }); t('×', L + cw[0] - 9, yy + 4.5, { s: 7, c: '#999' });
  });
  const cashTotY = y + rh * (denoms.length + 1);
  box(L, cashTotY, cw[0] + cw[1], rh + 2, TINT); box(L + cw[0] + cw[1], cashTotY, cw[2], rh + 2);
  t('A   CASH TOTAL', L + 4, cashTotY + 5, { b: true, s: 8 });

  const rx = L + cwT + 14, rw = R - rx, aw = 86;
  let ry = y;
  box(rx, ry, rw, rh, TINT); t('THIS BASKET', rx + 4, ry + 4.5, { b: true, s: 7.5 }); t('Amount (GHS)', rx + rw - aw, ry + 4.5, { b: true, s: 7.5, w: aw - 5, a: 'right' }); ry += rh;
  const line = (l, sub) => { box(rx, ry, rw - aw, rh + 2); box(rx + rw - aw, ry, aw, rh + 2); t(l, rx + 4, ry + 5, { s: 8 }); if (sub) t(sub, rx + 112, ry + 5.5, { s: 6.5, c: '#666' }); ry += rh + 2; };
  line('A   Cash', 'from the count');
  line('B   Cheques', 'list below');
  line('C   MoMo', 'list below');
  line('D   Bank transfers', 'list below');
  line('E   Foreign notes (in GHS)', 'list below');
  line('F   Pledges (IOU)', 'list below');
  ry += 4;
  box(rx, ry, rw - aw, rh + 6, NAVY); box(rx + rw - aw, ry, aw, rh + 6);
  t('BASKET TOTAL  (A to F)', rx + 4, ry + 7, { b: true, s: 9, c: '#fff' }); ry += rh + 12;
  box(rx, ry, rw - aw, rh + 2); box(rx + rw - aw, ry, aw, rh + 2);
  t('Second count — must be the same', rx + 4, ry + 5, { s: 8 }); ry += rh + 10;
  const sw = (rw - 8) / 2;
  [rx, rx + sw + 8].forEach(x => {
    box(x, ry, sw, 40); t('Counted by', x + 4, ry + 3, { s: 7, c: '#444' }); t('Name and signature', x + 4, ry + 31, { s: 6, c: '#999' });
  });

  y = cashTotY + rh + 14;
  const table = (title, cols, rows, x0, yy, w0) => {
    t(title, x0, yy, { b: true, s: 7.5, c: NAVY }); yy += 10;
    const total = cols.reduce((a, c) => a + c[1], 0), k = w0 / total;
    let x = x0; cols.forEach(([h, w]) => { box(x, yy, w * k, 13, TINT); t(h, x + 3, yy + 3.5, { b: true, s: 6.8 }); x += w * k; }); yy += 13;
    for (let r = 0; r < rows; r++) { x = x0; cols.forEach(([, w]) => { box(x, yy, w * k, 15); x += w * k; }); yy += 15; }
    return yy;
  };
  const half = (FULL - 12) / 2;
  const chequeRows = p.key === 'seed' ? 9 : 6;
  y = table('B   CHEQUES', [['Cheque no.', 90], ['Bank', 130], ['Drawer / name (if known)', 170], ['Amount (GHS)', 80]], chequeRows, L, y, FULL) + 8;
  const yb = y;
  const y1 = table('C   MOMO', [['Name or number', 100], ['Transaction ID', 80], ['Amount', 55]], 4, L, yb, half);
  const y2 = table('D   BANK TRANSFERS', [['Bank', 80], ['Reference', 90], ['Amount', 55]], 4, L + half + 12, yb, half);
  y = Math.max(y1, y2) + 8;
  const yc = y;
  const y3 = table('E   FOREIGN NOTES', [['Currency', 55], ['Amount', 55], ['Rate', 45], ['GHS', 60]], 3, L, yc, half);
  const y4 = table('F   PLEDGES (IOU) — promised date drives the reminders', [['Name', 80], ['Phone', 65], ['By (date)', 50], ['Amount', 50]], 3, L + half + 12, yc, half);
  y = Math.max(y3, y4) + 8;
  box(L, y, FULL, 20, '#f6f6f6');
  t('ENTRY DESK', L + 5, y + 6, { b: true, s: 7.5 });
  t('Entered in AOTC Track by ______________________   time ________        Photo sent:  yes  /  no', L + 70, y + 6.5, { s: 7.5 });
  footer(`Generated by AOTC Track · sheet ${pad2(p.no)}`);
}

function sheetsReturnedPage(doc, { event, date, service, rows }) {
  const { box, t, frame, footer } = sheetKit(doc);
  const { L, FULL, NAVY, TINT } = SH;
  frame('SHEETS RETURNED — TICK LIST');
  let y = 76;
  box(L, y, FULL, 24, NAVY);
  t(`${event ? event.name : ''}   ·   ${shortDay(date)}   ·   ${svcName(service)} service`, L + 8, y + 8, { b: true, s: 10, c: '#fff' });
  y += 32;
  t('Tick each sheet as it comes back from its counting table, and again once it is entered. Nothing is copied here — AOTC Track adds the sheets up and prints the day summary and the cash handover when the last one is in.', L, y, { s: 7.5, c: '#333', w: FULL, wrap: true });
  y += 24;
  const cols = [['No.', 34], ['Basket', 200], ['Back from the table', 90], ['Counted by', 101], ['Entered', 52]];
  let x = L; cols.forEach(([h, w]) => { box(x, y, w, 15, TINT); t(h, x + 4, y + 4, { b: true, s: 7 }); x += w; }); y += 15;
  rows.forEach(r => {
    x = L; cols.forEach(([, w]) => { box(x, y, w, 24); x += w; });
    t(pad2(r.no), L + 5, y + 8, { b: true, s: 9 }); t(r.label, L + 38, y + 8, { s: 9 });
    doc.rect(L + 234 + 40, y + 7, 10, 10).lineWidth(0.7).stroke(SH.GRID);
    doc.rect(L + 234 + 90 + 101 + 21, y + 7, 10, 10).lineWidth(0.7).stroke(SH.GRID);
    y += 24;
  });
  y += 16;
  const sw = (FULL - 16) / 3;
  [['Desk lead', L], ['Harvest Committee', L + sw + 8], ['Accounts Clerk', L + 2 * (sw + 8)]].forEach(([l, xx]) => {
    box(xx, y, sw, 40); t(l, xx + 4, y + 3, { s: 7, c: '#444' }); t('Name, signature and time', xx + 4, y + 30, { s: 6, c: '#999' });
  });
  footer('Generated by AOTC Track');
}

function buildBasketSheetsPdf({ event, date, services, plan, denoms, only }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false,
      info: { Title: `${event ? event.name : 'Harvest'} basket sheets ${date || ''}`.trim(), Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    (services || []).forEach(service => {
      const rows = plan.filter(p => p.service === service);
      // `only`: one sheet (a special sheet just added) — just its page.
      if (only) { rows.filter(p => p.no === only).forEach(p => { doc.addPage(); basketSheetPage(doc, { event, date, p, of: plan.length, denoms }); }); return; }
      rows.forEach(p => { doc.addPage(); basketSheetPage(doc, { event, date, p, of: plan.length, denoms }); });
      doc.addPage(); sheetsReturnedPage(doc, { event, date, service, rows });
    });
    doc.end();
  });
}

// The day once the sheets are in: one line per sheet, the cash handover (cash
// by denomination across every sheet) and the cheque list, with signatures.
function buildDaySummaryPdf({ event, date, rows, entries, denoms, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false,
      info: { Title: `${event ? event.name : 'Harvest'} day summary ${date || ''}`.trim(), Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const { box, t, frame, footer } = sheetKit(doc);
    const { L, FULL, NAVY, TINT } = SH;
    const gh = v => (Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Page 1: every sheet.
    doc.addPage(); frame('HARVEST DAY SUMMARY');
    let y = 76;
    box(L, y, FULL, 24, NAVY);
    t(`${event ? event.name : ''}   ·   ${dayLabel(date)}`, L + 8, y + 8, { b: true, s: 10, c: '#fff' });
    y += 32;
    const cols = [['No.', 26], ['Basket', 118], ['Svc', 30], ['Cash', 50], ['Cheques', 48], ['MoMo', 44], ['Transfers', 48], ['Foreign', 44], ['Pledges', 44], ['TOTAL', 75]];
    const head = () => { let x = L; cols.forEach(([h, w], i) => { box(x, y, w, 15, TINT); t(h, x + 3, y + 4, { b: true, s: 6.8, w: w - 6, a: i >= 3 ? 'right' : 'left' }); x += w; }); y += 15; };
    head();
    const sum = { cash: 0, momo: 0, cheque: 0, transfer: 0, forex: 0, ious: 0, total: 0 };
    let missing = 0;
    // Grouped by service (22 Nov 2026): a heading per service and its subtotal,
    // so 1st and 2nd service are told apart at a glance.
    // Only sheets that were entered appear (22 Nov 2026, per Gideon) — no
    // "NOT ENTERED" lines on the summary.
    rows = rows.filter(r => r.bd);
    const svcList = [...new Set(rows.map(r => r.service))];
    const many = svcList.length > 1;
    let sub = null;
    const subRow = () => {
      if (!many || !sub) return;
      let xx = L;
      cols.forEach(([, w], i) => {
        box(xx, y, w, 16, '#e3e8f3');
        const vals = [null, `${svcName(sub.service)} service subtotal`, '', sub.cash, sub.cheque, sub.momo, sub.transfer, sub.forex, sub.ious, sub.total];
        if (i >= 1 && vals[i] !== '' && vals[i] !== null) t(i >= 3 ? gh(vals[i]) : vals[i], xx + 3, y + 5, { b: true, s: 7.2, w: i === 1 ? w + 26 : w - 6, a: i >= 3 ? 'right' : 'left' });
        xx += w;
      });
      y += 16;
    };
    rows.forEach(r => {
      if (y > SH.H - 90) { footer('Generated by AOTC Track'); doc.addPage(); frame('HARVEST DAY SUMMARY (continued)'); y = 80; head(); }
      if (many && (!sub || sub.service !== r.service)) {
        subRow();
        sub = { service: r.service, cash: 0, cheque: 0, momo: 0, transfer: 0, forex: 0, ious: 0, total: 0 };
        box(L, y, FULL, 15, NAVY); t(`${svcName(r.service).toUpperCase()} SERVICE`, L + 6, y + 4.5, { b: true, s: 7.5, c: '#fff' }); y += 15;
      }
      const bd = r.bd;
      const v = bd ? [bd.cash, bd.chequeTotal, bd.momo, bd.transferTotal, bd.forexGhs, bd.iouTotal, bd.total] : null;
      if (bd) ['cash', 'cheque', 'momo', 'transfer', 'forex', 'ious', 'total'].forEach((k, i) => { sum[k] += Number(v[i]) || 0; if (sub) sub[k] += Number(v[i]) || 0; }); else missing++;
      let x = L;
      cols.forEach(([, w], i) => {
        box(x, y, w, 17, !bd ? '#fdecea' : null);
        const txt = i === 0 ? pad2(r.no) : i === 1 ? r.label : i === 2 ? svcName(r.service)
          : (bd ? (bd.formOnly && i < 9 ? '—' : gh(v[i - 3])) : (i === 9 ? 'NOT ENTERED' : ''));
        t(txt, x + 3, y + 5, { s: 7.3, b: i === 9 || i === 0, w: w - 6, a: i >= 3 ? 'right' : 'left', c: !bd && i === 9 ? '#b3261e' : '#000' });
        x += w;
      });
      y += 17;
    });
    subRow();
    // Money entered outside any sheet (service-level figures, older baskets).
    const inSheets = sum.total;
    const dayTotal = (entries || []).reduce((s, e) => s + (Number(e.total) || 0), 0);
    let x = L;
    cols.forEach(([, w], i) => {
      box(x, y, w, 19, NAVY);
      const vals = [null, 'DAY TOTAL (sheets)', '', sum.cash, sum.cheque, sum.momo, sum.transfer, sum.forex, sum.ious, sum.total];
      if (i >= 1 && vals[i] !== '' && vals[i] !== null) t(i >= 3 ? gh(vals[i]) : vals[i], x + 3, y + 6, { b: true, s: 7.5, c: '#fff', w: w - 6, a: i >= 3 ? 'right' : 'left' });
      x += w;
    });
    y += 26;
    if (Math.abs(dayTotal - inSheets) > 0.01) {
      t(`Recorded for the day in AOTC Track: GHS ${gh(dayTotal)} — GHS ${gh(dayTotal - inSheets)} of it was entered outside the sheets (service-level figures).`, L, y, { s: 8, b: true, c: '#b3261e', w: FULL, wrap: true }); y += 22;
    }

    // Page 2: cash handover and cheques.
    footer('Generated by AOTC Track');
    doc.addPage(); frame('CASH HANDOVER AND CHEQUES');
    y = 76;
    box(L, y, FULL, 24, NAVY);
    t(`${event ? event.name : ''}   ·   ${dayLabel(date)}`, L + 8, y + 8, { b: true, s: 10, c: '#fff' });
    y += 32;
    t('Count the bagged cash by note and coin and write it in the last column. Every line must agree before the cash leaves the church.', L, y, { s: 7.5, c: '#333', w: FULL, wrap: true });
    y += 16;
    const cc = {};
    (entries || []).forEach(e => Object.entries(e.cashCount || {}).forEach(([k, q]) => { cc[k] = (cc[k] || 0) + Number(q || 0); }));
    const ccols = [['Note / coin', 130], ['Pieces (sheets)', 90], ['Amount (sheets)', 110], ['Pieces bagged', 80], ['Agrees', 60]];
    x = L; ccols.forEach(([h, w], i) => { box(x, y, w, 15, TINT); t(h, x + 4, y + 4, { b: true, s: 7, w: w - 8, a: i === 0 ? 'left' : 'right' }); x += w; }); y += 15;
    let cashSum = 0;
    denoms.forEach(d => {
      const q = cc[d.key] || 0; const amt = q * d.value; cashSum += amt;
      x = L; ccols.forEach(([, w]) => { box(x, y, w, 16); x += w; });
      t(d.label, L + 4, y + 5, { s: 7.5 });
      t(q ? String(q) : '–', L + 130, y + 5, { s: 7.5, w: 86, a: 'right' });
      t(q ? gh(amt) : '–', L + 220, y + 5, { s: 7.5, w: 106, a: 'right' });
      y += 16;
    });
    x = L; ccols.forEach(([, w], i) => { box(x, y, w, 18, NAVY); x += w; });
    t('CASH COUNTED ON THE SHEETS', L + 4, y + 6, { b: true, s: 7.5, c: '#fff' });
    t(gh(cashSum), L + 220, y + 6, { b: true, s: 7.5, c: '#fff', w: 106, a: 'right' });
    y += 28;
    // Cheques and the other items are listed, each with its basket and service,
    // on the breakdown page that follows.
    const its = items || [];
    const sumT = ty => its.filter(i => i.type === ty).reduce((s2, i) => s2 + (Number(i.amount) || 0), 0);
    const cnt = ty => its.filter(i => i.type === ty).length;
    t(`CHEQUES — ${cnt('cheque')} cheque(s), GHS ${gh(sumT('cheque'))} (must agree with the bank deposit slip). Each cheque, with its basket and service, is on the breakdown page.`, L, y, { b: true, s: 8, c: NAVY, w: FULL, wrap: true });
    y += 24;
    y = Math.max(y + 16, SH.H - 110);
    const sw = (FULL - 16) / 3;
    [['Counted and bagged by', L], ['Treasurer', L + sw + 8], ['Harvest Committee', L + 2 * (sw + 8)]].forEach(([l, xx]) => {
      box(xx, y, sw, 42); t(l, xx + 4, y + 3, { s: 7, c: '#444' }); t('Name, signature and time', xx + 4, y + 32, { s: 6, c: '#999' });
    });
    footer('Generated by AOTC Track');

    // Page 3+: the breakdown — one table, a heading per kind, every item with
    // its sheet, basket and service (22 Nov 2026).
    doc.addPage(); frame('BREAKDOWN BY BASKET');
    y = 76;
    box(L, y, FULL, 24, NAVY);
    t(`${event ? event.name : ''}   ·   ${dayLabel(date)}`, L + 8, y + 8, { b: true, s: 10, c: '#fff' });
    y += 32;
    const KINDS = [['cheque', 'B   CHEQUES', 'Cheque no.', 'Drawer / name'], ['momo', 'C   MOMO', 'Transaction ID', 'Name or number'],
      ['transfer', 'D   BANK TRANSFERS', 'Reference', ''], ['forex', 'E   FOREIGN NOTES', 'Currency, amount @ rate', ''], ['iou', 'F   PLEDGES (IOU)', 'Due', 'Name · phone']];
    const bcols = [['Sheet', 32], ['Basket', 118], ['Svc', 34], ['', 96], ['', 112], ['Bank', 88], ['Amount (GHS)', 57]];
    const bhead = (k) => {
      let xx = L;
      bcols.forEach(([h, w], i) => {
        const lab = i === 3 ? k[2] : i === 4 ? k[3] : (i === 5 && k[0] !== 'cheque' && k[0] !== 'transfer') ? '' : h;
        box(xx, y, w, 14, TINT); t(lab, xx + 3, y + 4, { b: true, s: 6.8, w: w - 6, a: i === 6 ? 'right' : 'left' }); xx += w;
      });
      y += 14;
    };
    const newPage = (k) => { footer('Generated by AOTC Track'); doc.addPage(); frame('BREAKDOWN BY BASKET (continued)'); y = 80; if (k) bhead(k); };
    let any = false;
    KINDS.forEach(k => {
      const list = its.filter(i => i.type === k[0]);
      if (!list.length) return;
      any = true;
      if (y > SH.H - 120) newPage();
      box(L, y, FULL, 16, NAVY);
      t(`${k[1]}  —  ${list.length} item${list.length === 1 ? '' : 's'}`, L + 6, y + 5, { b: true, s: 7.8, c: '#fff' });
      t(`GHS ${gh(list.reduce((s2, i) => s2 + (Number(i.amount) || 0), 0))}`, L + FULL - 156, y + 5, { b: true, s: 7.8, c: '#fff', w: 150, a: 'right' });
      y += 16;
      bhead(k);
      let lastSvc = null;
      list.forEach(i => {
        if (y > SH.H - 70) newPage(k);
        const shade = many && lastSvc !== null && lastSvc !== i.service;
        lastSvc = i.service;
        let xx = L;
        const cells = [i.no ? pad2(i.no) : '—', i.basket, svcName(i.service), i.ref || '', i.party || '', i.bank || '', gh(i.amount)];
        bcols.forEach(([, w], ci) => {
          box(xx, y, w, 15, shade && ci === 0 ? null : null);
          t(cells[ci], xx + 3, y + 4.5, { s: 7.2, b: ci === 0 || ci === 6, w: w - 6, a: ci === 6 ? 'right' : 'left' });
          xx += w;
        });
        if (shade) { doc.save(); doc.moveTo(L, y).lineTo(L + FULL, y).lineWidth(1.2).strokeColor(NAVY).stroke(); doc.restore(); }
        y += 15;
      });
      y += 8;
    });
    if (!any) t('No cheques, MoMo, transfers, foreign notes or pledges on this day — cash only.', L + 4, y + 3, { s: 8, c: '#666' });
    footer('Generated by AOTC Track');
    doc.end();
  });
}

module.exports = { buildAnnouncementPdf, buildStatementPdf, buildCountingSheetPdf, buildBasketSheetsPdf, buildDaySummaryPdf };
