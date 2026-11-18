// Fills the official PCG District Excel template ("2026 Quarterly Data Input")
// with the system's data for a chosen quarter, preserving the template's
// structure and formulas — the auto-generated sheets (Quarterly Report,
// Annual Report, For District Template) recalculate from these inputs.
const ExcelJS = require('exceljs');
const path = require('path');
const db = require('./db');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'tyrp-template.xlsx');
const QCOL = { 1: 4, 2: 5, 3: 6, 4: 7 }; // D,E,F,G

async function fillDistrictExcel({ year, quarter }) {
  year = Number(year); quarter = Number(quarter);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet('2026 Quarterly Data Input');
  if (!ws) throw new Error('Template is missing the "2026 Quarterly Data Input" sheet.');

  // exceljs re-serialises some of the template's conditional-formatting rules
  // with invalid operators, producing a file strict readers reject. The rules
  // are purely cosmetic (cell highlighting), so strip them on output.
  wb.worksheets.forEach(sheet => {
    if (sheet.conditionalFormattings) sheet.conditionalFormattings = [];
    try { sheet.removeConditionalFormatting && sheet.removeConditionalFormatting(); } catch (e) {}
  });
  const col = QCOL[quarter];

  const { reportedValue, isParentOwner } = require('./goalRollup');
  const goals = db.findAll('goals', g => g.year === year && (g.source === 'tyrp' || g.source === 'merged'));
  // A shared goal is stored once per owner, all under the same code. This map
  // used to take whichever copy sorted last, so ME-02 was being returned to the
  // District as the Bible Study and Prayer Group's figure and CLN-02 as the
  // Women's Fellowship's. The District wants the RESPONSIBLE COMMITTEE's row.
  const gmap = {};
  goals.forEach(g => {
    const key = g.code.replace(/\s/g, '');
    const prev = gmap[key];
    if (!prev || (!isParentOwner(prev) && isParentOwner(g))) gmap[key] = g;
  });
  const entries = db.findAll('kpi_entries', e => e.year === year && e.quarter === quarter);
  // Read once and hand down — the roll-up would otherwise re-read the store for
  // every one of the ~90 KPI rows below.
  const allGoals = db.findAll('goals', g => g.year === year);
  const allEntries = db.findAll('kpi_entries', e => e.year === year);

  function setVal(row, value, unit) {
    if (value === null || value === undefined || value === '') return;
    const cell = ws.getRow(row).getCell(col);
    if ((unit || '').toLowerCase() === 'date') {
      const d = new Date(value);
      if (!isNaN(d)) cell.value = d; else cell.value = value;
    } else if (typeof value === 'number') cell.value = value;
    else if (!isNaN(Number(value))) cell.value = Number(value);
    else cell.value = value;
  }

  // ---- CQDI-1: per-goal KPI rows (14–106): track code col A, KPI rows have unit in col C
  let cur = null, kidx = -1;
  for (let r = 14; r <= 106; r++) {
    const a = ws.getRow(r).getCell(1).value;
    const unitCell = ws.getRow(r).getCell(3).value;
    if (a && String(a).trim()) {
      const code = String(a).trim().replace(/\s/g, '');
      if (gmap[code]) { cur = gmap[code]; kidx = -1; }
      else cur = null;
    }
    if (!cur) continue;
    if (unitCell !== null && unitCell !== undefined && String(unitCell).trim() !== '') {
      kidx += 1;
      const kpi = (cur.kpis || [])[kidx];
      if (!kpi || kpi.origin === 'so') continue;
      const entry = entries.find(e => e.goalId === cur.id);
      const own = entry && entry.values ? entry.values[kidx] : null;
      // For a goal the groups also work on, the District figure is the whole
      // congregation's effort — the committee's own plus every group's.
      const v = reportedValue(cur, kidx, { year, quarter, ownValue: own, allGoals, allEntries });
      setVal(r, v, kpi.unit);
    }
  }

  // ---- CQDI-2: membership rows 111–115
  const mem = db.findOne('membership_quarterly', m => m.year === year && m.quarter === quarter);
  if (mem && mem.categories) {
    const order = ['children', 'juniorYouth', 'youth', 'youngAdults', 'adults'];
    order.forEach((k, i) => setVal(111 + i, mem.categories[k]));
  }

  // ---- CQDI-4/5: lands (187+) & properties (221+)
  const pd = db.findOne('pdbp_quarterly', p => p.year === year && p.quarter === quarter);
  if (pd) {
    (pd.lands || []).forEach((l, i) => { if (l.status) setVal(187 + i, l.status); });
    (pd.properties || []).forEach((x, i) => { if (x.insured) setVal(221 + i, x.insured); });
  }

  // ---- CQDI-3: weekly attendance rows (121–178) — date in col B;
  // C=Children's, D=JY, E=Adult in-person · F=Children's, G=JY online
  const services = db.findAll('service_attendance', s => s.year === year && s.quarter === quarter);
  if (services.length) {
    const byDate = {};
    services.forEach(s => {
      const k = s.date;
      byDate[k] = byDate[k] || { cs: 0, jy: 0, adult: 0, csOn: 0, jyOn: 0 };
      byDate[k].cs += (s.counts.cs.male + s.counts.cs.female);
      byDate[k].jy += (s.counts.jy.male + s.counts.jy.female);
      // Adults include CS teachers and JY leaders (they are adults serving
      // away from the main hall).
      byDate[k].adult += (s.counts.adult.male + s.counts.adult.female)
        + (s.counts.cs.teachersMale || 0) + (s.counts.cs.teachersFemale || 0)
        + (s.counts.jy.leadersMale || 0) + (s.counts.jy.leadersFemale || 0);
      byDate[k].csOn += s.counts.cs.online;
      byDate[k].jyOn += s.counts.jy.online;
    });
    for (let r = 121; r <= 178; r++) {
      const cellB = ws.getRow(r).getCell(2).value;
      if (!cellB) continue;
      const d2 = cellB instanceof Date ? cellB : new Date(cellB);
      if (isNaN(d2)) continue;
      const key = d2.toISOString().slice(0, 10);
      const v = byDate[key];
      if (!v) continue;
      ws.getRow(r).getCell(3).value = v.cs;
      ws.getRow(r).getCell(4).value = v.jy;
      ws.getRow(r).getCell(5).value = v.adult;
      ws.getRow(r).getCell(6).value = v.csOn;
      ws.getRow(r).getCell(7).value = v.jyOn;
    }
  }

  // ---- CQDI-6: earmarked (246–250) · CQDI-7: almanac (255–268)
  const fin = db.findOne('finance_quarterly', f => f.year === year && f.quarter === quarter);
  if (fin) {
    const e = fin.earmarked || {};
    setVal(246, e.missionsEvangelism); setVal(247, e.welfare); setVal(248, e.education);
    setVal(249, e.scholarship); setVal(250, e.totalAllExpenditure);
    (fin.almanac || []).forEach((a, i) => {
      const dateRow = 255 + i * 2;
      if (a.date) setVal(dateRow, a.date, 'date');
      if (a.amount !== null && a.amount !== undefined) setVal(dateRow + 1, a.amount);
    });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { fillDistrictExcel };
