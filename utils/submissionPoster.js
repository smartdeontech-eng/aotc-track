// The quarterly submission board, as a shareable image.
//
// WHY THIS EXISTS. The Session Clerk posts a submission update to the WhatsApp
// group each quarter. It was being retyped into a spreadsheet and screenshotted
// — which meant it was out of date the moment a report came in, and it encoded
// status in colour alone, so the red-green colourblind half of the group could
// not read it at all. This builds the same picture from live data.
//
// SELF-CONTAINED SVG, rasterised in the browser. No image library on the server
// (none is installed, and adding a native one to the VPS for one poster is a bad
// trade), no CDN, and it still works offline: the page draws this SVG into a
// canvas and saves a PNG. That means no external fonts, no embedded images, and
// no foreignObject — plain <text>, which is the one thing that rasterises
// identically everywhere.
//
// Because SVG <text> does not wrap, every name is wrapped here, measured with a
// per-character estimate. The estimate is deliberately slightly generous: a name
// that wraps one word early looks fine, a name that overflows its chip does not.
const { reportDueDate } = require('./dates');

const W = 1080;              // a good width for WhatsApp without being huge
const PAD = 52;
const GAP = 36;
const COL_G = 430;           // groups column
const COL_C = W - PAD * 2 - GAP - COL_G;   // committees get the rest; longer names

const C = {
  navy: '#16305F', ink: '#101A2B', ink2: '#48566B', muted: '#8A95A6',
  ok: '#00C853', okInk: '#04301A', okTint: '#E6FAEE',
  warn: '#FFB300', warnInk: '#3D2800', warnTint: '#FFF5DE',
  no: '#F5222D', noInk: '#FFFFFF', noTint: '#FEEAE9',
  rule: '#E4E8EE', dueTint: '#FDF4E0', dueRule: '#F0DFBD', dueInk: '#6B4E0A', dueInk2: '#8A6B1C',
  headSub: '#A9BEE4',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const STATUS = {
  submitted: { label: 'Submitted', fill: C.ok, ink: C.okInk, tint: C.okTint },
  reopened: { label: 'Reopened', fill: C.warn, ink: C.warnInk, tint: C.warnTint },
  outstanding: { label: 'Pending', fill: C.no, ink: C.noInk, tint: C.noTint },
};

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Rough advance width. 0.515em per character at semibold is close enough for
// the system sans stack across macOS, iOS, Windows and Android.
const textW = (s, size, weight) => String(s).length * size * (weight >= 700 ? 0.545 : 0.515);

function wrap(name, size, maxW, maxLines = 2) {
  const words = String(name).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word;
    if (cur && textW(next, size, 600) > maxW) { lines.push(cur); cur = word; } else { cur = next; }
    if (lines.length === maxLines - 1 && textW(cur, size, 600) > maxW) break;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s+\S*$/, '') + '…';
    return kept;
  }
  return lines.length ? lines : [''];
}

const fmtDay = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// One row: tinted rounded rect, status disc with a distinct glyph per state
// (tick / bar / dash — never colour alone), the name, and a chip carrying the
// word. Three agreeing signals, so the row survives colourblindness and print.
function rowSvg(r, x, y, colW) {
  const st = STATUS[r.status] || STATUS.outstanding;
  const tagW = Math.round(textW(st.label.toUpperCase(), 14, 800) + 24);
  const nameMax = colW - 22 - 26 - 12 - tagW - 12;
  const lines = wrap(r.name, 21, nameMax);
  const h = lines.length > 1 ? 62 : 48;
  const cy = y + h / 2;
  const glyph = r.status === 'submitted'
    ? `<path d="M${x + 18} ${cy} l4 4 l7.5 -8.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : r.status === 'reopened'
      ? `<rect x="${x + 22.5}" y="${cy - 5.5}" width="3" height="11" rx="1.5" fill="#fff"/>`
      : `<rect x="${x + 18}" y="${cy - 1.5}" width="12" height="3" rx="1.5" fill="#fff"/>`;
  const firstBaseline = lines.length > 1 ? cy - 6 : cy + 7.5;
  return `<g>
    <rect x="${x}" y="${y}" width="${colW}" height="${h}" rx="9" fill="${st.tint}"/>
    <circle cx="${x + 24}" cy="${cy}" r="13" fill="${st.fill}"/>${glyph}
    ${lines.map((l, i) => `<text x="${x + 49}" y="${firstBaseline + i * 25}" font-family="${FONT}" font-size="21" font-weight="600" fill="${C.ink}">${esc(l)}</text>`).join('')}
    <rect x="${x + colW - 11 - tagW}" y="${cy - 13}" width="${tagW}" height="26" rx="6" fill="${st.fill}"/>
    <text x="${x + colW - 11 - tagW / 2}" y="${cy + 5.5}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="800" letter-spacing="1" fill="${st.ink}">${esc(st.label.toUpperCase())}</text>
  </g>`;
}

function columnSvg(title, rows, x, y, colW) {
  const done = rows.filter(r => r.status === 'submitted').length;
  let out = `<text x="${x + 4}" y="${y + 20}" font-family="${FONT}" font-size="25" font-weight="800" letter-spacing="1.2" fill="${C.ink}">${esc(title.toUpperCase())}</text>
    <text x="${x + colW - 4}" y="${y + 20}" text-anchor="end" font-family="${FONT}" font-size="20" font-weight="700" fill="${C.muted}">${done} / ${rows.length}</text>
    <rect x="${x}" y="${y + 32}" width="${colW}" height="2.5" fill="${C.ink}"/>`;
  let cy = y + 42;
  for (const r of rows) {
    const st = STATUS[r.status] || STATUS.outstanding;
    const tagW = Math.round(textW(st.label.toUpperCase(), 14, 800) + 24);
    const h = wrap(r.name, 21, colW - 22 - 26 - 12 - tagW - 12).length > 1 ? 62 : 48;
    out += rowSvg(r, x, cy, colW);
    cy += h + 4;
  }
  return { svg: out, bottom: cy };
}

// board: the object GET /entry/submission-board returns.
function posterSvg(board, { generatedAt = new Date() } = {}) {
  // Alphabetical on the poster, by deliberate choice: on a shared image people
  // look for their OWN name, and alphabetical is how you find it. The in-app
  // board sorts by status instead, because there you are working the list.
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const groups = board.rows.filter(r => r.entityType === 'group').slice().sort(byName);
  const committees = board.rows.filter(r => r.entityType === 'committee').slice().sort(byName);

  const inn = board.submitted;
  const pct = board.total ? Math.round((inn / board.total) * 100) : 0;
  const due = board.dueAt ? new Date(board.dueAt) : reportDueDate(board.year, board.quarter);
  const late = board.daysLeft < 0;
  const dueRight = late
    ? `${Math.abs(board.daysLeft)} day${Math.abs(board.daysLeft) === 1 ? '' : 's'} overdue · ${board.total - inn} outstanding`
    : `${board.daysLeft} day${board.daysLeft === 1 ? '' : 's'} left · ${board.total - inn} outstanding`;

  const headH = 236, dueH = 68, legY = headH + dueH + 38, colsY = legY + 34;
  const gc = columnSvg('Groups', groups, PAD, colsY, COL_G);
  const cc = columnSvg('Committees', committees, PAD + COL_G + GAP, colsY, COL_C);
  const bodyBottom = Math.max(gc.bottom, cc.bottom);
  const H = Math.round(bodyBottom + 72);

  const legend = ['submitted', 'reopened', 'outstanding'].map((k, i) => {
    const st = STATUS[k];
    const x = PAD + i * 190;
    return `<rect x="${x}" y="${legY - 19}" width="26" height="26" rx="7" fill="${st.fill}"/>
      <text x="${x + 36}" y="${legY}" font-family="${FONT}" font-size="19" font-weight="600" fill="${C.ink2}">${esc(st.label)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <rect width="${W}" height="${headH}" fill="${C.navy}"/>
  <circle cx="${W + 10}" cy="-10" r="150" fill="#FFFFFF" fill-opacity="0.04"/>
  <text x="${PAD}" y="${64}" font-family="${FONT}" font-size="19" font-weight="600" letter-spacing="3.2" fill="${C.headSub}">PCG ADABRAKA OFFICIAL TOWN</text>
  <text x="${PAD}" y="${124}" font-family="${FONT}" font-size="56" font-weight="800" fill="#FFFFFF">Q${board.quarter} ${board.year}</text>
  <text x="${PAD}" y="${182}" font-family="${FONT}" font-size="56" font-weight="800" fill="#FFFFFF">Report Submissions</text>
  <text x="${W - PAD}" y="${132}" text-anchor="end" font-family="${FONT}" font-size="80" font-weight="800" fill="${C.ok}">${inn}<tspan font-size="38" font-weight="600" fill="${C.headSub}">/${board.total}</tspan></text>
  <text x="${W - PAD}" y="${166}" text-anchor="end" font-family="${FONT}" font-size="21" font-weight="600" fill="${C.headSub}">received</text>
  <rect x="${PAD}" y="${headH - 36}" width="${W - PAD * 2}" height="14" rx="7" fill="#FFFFFF" fill-opacity="0.18"/>
  <rect x="${PAD}" y="${headH - 36}" width="${Math.max(14, Math.round((W - PAD * 2) * pct / 100))}" height="14" rx="7" fill="${C.ok}"/>
  <rect y="${headH}" width="${W}" height="${dueH}" fill="${late ? C.noTint : C.dueTint}"/>
  <rect y="${headH + dueH - 1}" width="${W}" height="1" fill="${late ? '#F3C9C6' : C.dueRule}"/>
  <text x="${PAD}" y="${headH + 43}" font-family="${FONT}" font-size="25" font-weight="700" fill="${late ? '#8C1A14' : C.dueInk}">Deadline — ${esc(fmtDay(due))}</text>
  <text x="${W - PAD}" y="${headH + 43}" text-anchor="end" font-family="${FONT}" font-size="21" font-weight="600" fill="${late ? '#A8302A' : C.dueInk2}">${esc(dueRight)}</text>
  ${legend}
  ${gc.svg}
  ${cc.svg}
  <rect x="0" y="${H - 52}" width="${W}" height="1" fill="${C.rule}"/>
  <text x="${PAD}" y="${H - 20}" font-family="${FONT}" font-size="18" font-weight="500" fill="${C.muted}">Generated from AOTC Track</text>
  <text x="${W - PAD}" y="${H - 20}" text-anchor="end" font-family="${FONT}" font-size="18" font-weight="500" fill="${C.muted}">${esc(generatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}, ${esc(generatedAt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }))}</text>
</svg>`;
}

module.exports = { posterSvg, STATUS, W };
