// AOTC Track — Election report, PDF and Word.
// One outline (reportData -> blocks) drawn twice, so the two files always say
// the same thing in the same order (house rule: Word and PDF must match). A4,
// letterhead: Presbyterian Church of Ghana -> crest -> Adabraka Official Town
// Congregation -> crest-blue rule; "Page x of y" from page 1.
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const E = require('./elections');

const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');
const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '—';
const n = v => Number(v || 0).toLocaleString('en-GB');
const pct = (a, b) => b ? `${(Math.round((a / b) * 1000) / 10).toFixed(1)}%` : '—';
const initials = s => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

// A candidate's picture for the report. Only JPEG and PNG can go into both
// the PDF and the Word file; anything else falls back to the initials.
function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return { type: 'jpg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
function face(c) {
  const out = { face: true, initials: initials(c.name) };
  const p = c.photoFile ? E.photoPath(c.photoFile) : null;
  if (!p) return out;
  try {
    const buf = fs.readFileSync(p);
    const size = imageSize(buf);
    if (size && size.w && size.h) Object.assign(out, { buf, ...size });
  } catch (err) {}
  return out;
}

const REASONS = {
  'not-on-list': 'Number not on the voters’ list',
  'wrong-code': 'Wrong code entered',
  'locked': 'Tried while locked',
  'already-voted': 'Tried to vote a second time',
  'no-code': 'Tried before a code was sent',
  'bad-phone': 'Invalid phone number entered',
  'wrong-second-check': 'Date of birth / member no. did not match',
  'wrong-booth-pin': 'Wrong booth PIN',
  'desk-wrong-dob': 'Polling desk: date of birth did not match',
};

function reportData(e) {
  const voters = db.findAll(E.C.voters, v => v.electionId === e.id).sort((a, b) => a.name.localeCompare(b.name));
  const vById = new Map(voters.map(v => [v.id, v]));
  const turnout = E.turnoutRows(e.id);
  const booths = db.findAll(E.C.booths, b => b.electionId === e.id).sort((a, b) => a.id - b.id);
  const bName = new Map(booths.map(b => [b.id, b.name]));
  const attempts = db.findAll(E.C.attempts, a => a.electionId === e.id);
  const events = db.findAll(E.C.events, x => x.electionId === e.id);
  const results = E.results(e);
  const cands = new Map(E.candidatesOf(e.id).map(c => [c.id, c]));
  const faceOf = id => face(cands.get(id) || {});
  const signoff = E.signoffFor(e);
  const group = e.entityName || 'the group';
  const voted = new Set(turnout.map(t => t.voterId));
  const online = turnout.filter(t => t.channel === 'online');
  const atBooths = turnout.filter(t => t.channel === 'booth');
  const assists = db.findAll(E.C.assists, a => a.electionId === e.id);
  const assisted = assists.filter(a => a.castAt);
  const assistedBy = new Map(assisted.map(a => [a.voterId, a]));
  const blocks = [];
  const H = text => blocks.push({ t: 'h', text });
  const P = text => blocks.push({ t: 'p', text });
  const T = (head, widths, rows, opts = {}) => blocks.push({ t: 'table', head, widths, rows, ...opts });

  blocks.push({ t: 'title', text: 'ELECTION REPORT' });
  blocks.push({ t: 'subtitle', text: `${e.title}${e.entityName ? ` — ${e.entityName}` : ''}` });

  H('1. Conduct of the election');
  T(['Item', 'Details'], [34, 66], [
    ['Election', e.title],
    ['Group', e.entityName || '—'],
    ['Report prepared by', `CLAN, on behalf of ${group}`],
    ['Set up by', `${e.createdBy || '—'} (CLAN), ${fmtDT(e.createdAt)}`],
    ['Submitted to the Session Clerk', e.submittedAt ? `${e.submittedBy || '—'}, ${fmtDT(e.submittedAt)}` : '—'],
    ['Confirmed by the Session Clerk', e.confirmedAt ? `${e.confirmedBy || '—'}, ${fmtDT(e.confirmedAt)}` : '—'],
    ['Polls scheduled', `${fmtDT(e.openAt)} to ${fmtDT(e.closeAt)}`],
    ['Polls opened', e.openedAt ? `${fmtDT(e.openedAt)} (${e.openedBy || '—'})` : '—'],
    ['Polls closed', e.closedAt ? `${fmtDT(e.closedAt)} (${e.closedBy || '—'})` : '—'],
    ['Identity check', ['phone number + 6-digit code sent by SMS', e.verifyDob ? 'date of birth' : null, e.verifyMemberNo ? 'member number' : null].filter(Boolean).join(', then ')],
    ['Results certified', e.certifiedAt ? `${e.certifiedBy || '—'}, ${fmtDT(e.certifiedAt)}` : 'Not yet certified'],
  ], { keyCol: true });

  H('2. Turnout');
  T(['', 'Number', 'Share'], [50, 25, 25], [
    ['Eligible voters (on the confirmed list)', n(voters.length), ''],
    ['Votes cast', n(turnout.length), pct(turnout.length, voters.length)],
    ['   — at polling booths', n(atBooths.length), pct(atBooths.length, turnout.length)],
    ['        of these, checked by a polling officer (no phone)', n(assisted.length), pct(assisted.length, turnout.length)],
    ['   — online (own phone or computer)', n(online.length), pct(online.length, turnout.length)],
    ['Did not vote', n(voters.length - turnout.length), pct(voters.length - turnout.length, voters.length)],
  ]);

  if (booths.length) {
    H('3. Polling booths');
    T(['Booth', 'Votes', 'First vote', 'Last vote', 'Unlocked on device'], [26, 12, 20, 20, 22], booths.map(b => {
      const mine = atBooths.filter(t => t.boothId === b.id);
      return [b.name, n(mine.length), mine.length ? fmtT(mine[0].at) : '—', mine.length ? fmtT(mine[mine.length - 1].at) : '—', b.unlockedAt ? fmtDT(b.unlockedAt) : 'never'];
    }));
  }

  H(`${booths.length ? 4 : 3}. Results`);
  P(`Percentages are of the ${n(turnout.length)} ballot(s) cast. A voter may leave a position blank.`);
  results.forEach(r => {
    blocks.push({ t: 'h2', text: `${r.title}${r.seats > 1 ? ` (${r.seats} seats)` : ''}`, keep: 130 });
    if (r.mode === 'pick') {
      T(['', 'Candidate', 'Votes', '% of ballots', ''], [12, 42, 14, 16, 16],
        [...r.options.map(o => [faceOf(o.candidateId), o.name, n(o.votes), `${o.pct.toFixed(1)}%`, o.leading ? (e.status === 'certified' ? 'Elected' : 'Leading') : '']),
          ['', 'Left blank', n(r.skipped), pct(r.skipped, r.ballots), '']]);
      if (r.tieAtCut) P('NOTE: there is a tie at the last elected place. The Session Clerk should direct how it is resolved.');
    } else {
      T(['', 'Candidate (unopposed)', 'Yes', 'No', 'Abstained', 'Outcome'], [12, 30, 12, 12, 14, 20],
        r.options.map(o => [faceOf(o.candidateId), o.name, n(o.yes), n(o.no), n(o.skip), o.carried ? 'Endorsed' : 'Not endorsed']));
    }
  });

  let sec = booths.length ? 5 : 4;
  const hours = {};
  turnout.forEach(t => { const k = t.at.slice(0, 13); hours[k] = (hours[k] || 0) + 1; });
  if (Object.keys(hours).length) {
    H(`${sec++}. Votes by hour`);
    T(['Hour', 'Votes cast'], [50, 50], Object.entries(hours).sort().map(([k, v]) => {
      const d = new Date(k + ':00:00Z');
      return [`${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: 'numeric', hour12: true })}`, n(v)];
    }));
  }

  H(`${sec++}. Who voted`);
  P('This list shows THAT each person voted, when and how. It does not and cannot show how anyone voted: choices are added to the totals with no link to the voter (see section on secrecy).');
  T(['No.', 'Name', 'Phone', 'Time', 'Where', 'Network (IP)'], [6, 30, 15, 15, 16, 18],
    turnout.map((t, i) => {
      const v = vById.get(t.voterId) || {};
      return [String(i + 1), v.name || '(removed)', E.maskPhone(v.phone), fmtT(t.at), t.channel === 'booth' ? `${bName.get(t.boothId) || 'Booth'}${assistedBy.has(t.voterId) ? ' (officer)' : ''}` : 'Online', t.channel === 'online' ? (t.ip || '—') : ''];
    }), { small: true });

  const nonVoters = voters.filter(v => !voted.has(v.id));
  if (nonVoters.length) {
    H(`${sec++}. Did not vote`);
    T(['No.', 'Name', 'Phone', 'Code SMS'], [8, 47, 20, 25], nonVoters.map((v, i) => [
      String(i + 1), v.name, E.maskPhone(v.phone), v.sms ? ({ sent: 'sent', failed: 'FAILED', skipped: 'not sent', sending: 'sending' }[v.sms.status] || v.sms.status) : 'no code',
    ]), { small: true });
  }

  H(`${sec++}. Security and integrity`);
  const byReason = {};
  attempts.forEach(a => { byReason[a.reason] = (byReason[a.reason] || 0) + 1; });
  T(['Event', 'Count'], [75, 25], [
    ...Object.entries(byReason).map(([k, v]) => [REASONS[k] || k, n(v)]),
    ['Codes resent by an officer', n(events.filter(x => x.type === 'code-resent').length)],
    ['Phone numbers corrected during polling', n(events.filter(x => x.type === 'phone-corrected').length)],
    ['Voters locked after wrong codes', n(events.filter(x => x.type === 'locked').length)],
  ]);
  if (assists.length) {
    blocks.push({ t: 'h2', text: 'Voters checked by a polling officer (came without their phone)', keep: 90 });
    P('Each of these voters gave their phone number at the polling desk; the officer then checked the date of birth they stated against the list, or confirmed knowing them personally, and released the ballot to a booth. No code was read out and the officer did not see the ballot. After each such vote an SMS went to the voter’s phone saying a vote had been cast in their name.');
    const CHECK = { dob: 'Phone no. + date of birth', known: 'Phone no. + known personally' };
    const SMSS = { sent: 'sent', failed: 'FAILED', skipped: 'not sent' };
    T(['Released', 'Voter', 'Phone', 'Booth', 'Officer', 'Check', 'Outcome'], [11, 18, 13, 13, 15, 18, 12], assists.map(a => [
      fmtT(a.releasedAt), a.voterName, E.maskPhone(a.phone), a.boothName, a.officerName,
      `${CHECK[a.method] || a.method}${a.note ? ` (${a.note})` : ''}`,
      a.castAt ? `voted ${fmtT(a.castAt)}; SMS ${SMSS[a.noticeSms] || a.noticeSms || '—'}` : a.cancelledAt ? 'cancelled' : voted.has(a.voterId) ? 'voted another way' : 'not used',
    ]), { small: true });
  }
  const ipCount = {};
  online.forEach(t => { if (t.ip) ipCount[t.ip] = (ipCount[t.ip] || 0) + 1; });
  const shared = Object.entries(ipCount).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  if (shared.length) {
    P(`Online votes sharing a network address: ${shared.slice(0, 10).map(([ip, c]) => `${ip} (${c})`).join(', ')}${shared.length > 10 ? ', …' : ''}. This is expected: Ghana’s mobile networks put many phones behind one public address, and a home or office Wi-Fi does the same. On its own it is not a sign of wrongdoing; each vote still needed that voter’s own phone number and code.`);
  }

  H(`${sec++}. Officers’ actions`);
  T(['Time', 'By', 'Action'], [22, 20, 58], events.map(x => [fmtDT(x.at), x.actor || '—', x.detail || x.type]), { small: true });

  H(`${sec++}. Secrecy of the ballot`);
  P('Two separate records are kept. The turnout record says who voted, when, at which booth or from which network. The tally keeps only running totals for each candidate, with no voter, booth or time attached, and individual ballots are never stored. The two cannot be joined, so no one — officers and administrators included — can tell how any person voted. Each voter could vote once: the turnout record accepts one entry per person, enforced by the database itself. Voting codes were stored only in scrambled (hashed) form and stopped working when polls closed.');

  blocks.push({ t: 'h', text: `${sec++}. Declaration and sign-off`, keep: 300 });
  blocks.push({ t: 'p', keepNext: true, text: `This report was prepared by CLAN on behalf of ${group}. We, the undersigned, declare that it is a true account of how the election was conducted and of its result.` });
  blocks.push({ t: 'signoff', tiers: [
    { title: group, items: [
      { verb: 'Signed by', role: `President, ${group}`, name: signoff.president },
      { verb: 'Witnessed by', role: `${signoff.groupWitnessRole || 'Executive member'}, ${group}`, name: signoff.groupWitness },
    ] },
    { title: 'CLAN', items: [
      { verb: 'Approved by', role: 'CLAN Coordinator', name: signoff.clanCoordinator },
      { verb: 'Witnessed by', role: 'Member, CLAN Committee', name: signoff.clanWitness },
    ] },
    { title: 'The Session', items: [
      { verb: 'Validated by', role: 'Session Clerk', name: signoff.sessionClerk },
    ] },
  ] });
  if (e.certifiedAt) P(`Results certified in AOTC Track by ${e.certifiedBy || 'the Session Clerk'} on ${fmtDT(e.certifiedAt)}.`);
  return { e, blocks, generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- PDF
function buildPdf(data) {
  const PDFDocument = require('pdfkit');
  const A4 = { width: 595.28, height: 841.89 };
  const M = { top: 56, bottom: 64, left: 50, right: 50 };
  const W = A4.width - M.left - M.right;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: `Election report — ${data.e.title}`, Author: 'AOTC Track' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const bottom = () => A4.height - M.bottom;
    const room = hgt => { if (doc.y + hgt > bottom()) doc.addPage(); };

    // Letterhead
    doc.font('Times-Bold').fontSize(14).fillColor('#000').text('Presbyterian Church of Ghana', M.left, M.top - 8, { width: W, align: 'center' });
    const cy = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - 58) / 2, cy, { fit: [58, 66] }); } catch (err) {}
    doc.y = cy + 70;
    doc.font('Times-Bold').fontSize(11.5).text('Adabraka Official Town Congregation', M.left, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 14;

    const table = b => {
      const fs1 = b.small ? 8.5 : 9.5;
      const widths = b.widths.map(w => (w / 100) * W);
      const pad = 4;
      const FACE = 46;
      const rowH = (cells, bold) => Math.max(...cells.map((c, i) => c && c.face ? FACE : doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(fs1).heightOfString(String(c ?? ''), { width: widths[i] - pad * 2 }))) + pad * 2;
      const drawFace = (c, x, y, w) => {
        const fx = x + (w - FACE) / 2, fy = y + pad;
        if (c.buf) {
          try { doc.image(c.buf, fx, fy, { fit: [FACE, FACE], align: 'center', valign: 'center' }); return; } catch (err) {}
        }
        doc.save().rect(fx, fy, FACE, FACE).fill('#E8ECF5').restore();
        doc.fillColor('#1D3F94').font('Times-Bold').fontSize(14).text(c.initials || '', fx, fy + FACE / 2 - 8, { width: FACE, align: 'center', lineBreak: false });
        doc.fillColor('#000');
      };
      const drawRow = (cells, bold, shade) => {
        const hgt = rowH(cells, bold);
        if (doc.y + hgt > bottom()) { doc.addPage(); if (!bold && b.head) drawRow(b.head, true, true); }
        const y = doc.y;
        let x = M.left;
        if (shade) doc.rect(M.left, y, W, hgt).fill('#E8ECF5');
        const hasFace = cells.some(c => c && c.face);
        cells.forEach((c, i) => {
          if (c && c.face) { drawFace(c, x, y, widths[i]); x += widths[i]; return; }
          doc.fillColor('#000').font(bold || (b.keyCol && i === 0) ? 'Times-Bold' : 'Times-Roman').fontSize(fs1);
          const th = doc.heightOfString(String(c ?? ''), { width: widths[i] - pad * 2 });
          doc.text(String(c ?? ''), x + pad, hasFace ? y + (hgt - th) / 2 : y + pad, { width: widths[i] - pad * 2 });
          x += widths[i];
        });
        doc.lineWidth(0.5).strokeColor('#999');
        x = M.left;
        widths.forEach(w => { doc.rect(x, y, w, hgt).stroke(); x += w; });
        doc.y = y + hgt;
      };
      if (b.head) drawRow(b.head, true, true);
      if (!b.rows.length) drawRow(b.widths.map((_, i) => i === 0 ? '— none —' : ''), false, false);
      b.rows.forEach(r => drawRow(r, false, false));
      doc.y += 8;
    };

    for (const b of data.blocks) {
      doc.x = M.left;
      if (b.t === 'title') { doc.font('Times-Bold').fontSize(14).fillColor('#000').text(b.text, M.left, doc.y, { width: W, align: 'center' }); }
      else if (b.t === 'subtitle') { doc.font('Times-Roman').fontSize(12).text(b.text, M.left, doc.y, { width: W, align: 'center' }); doc.moveDown(0.8); }
      else if (b.t === 'h') { room(b.keep || 60); doc.moveDown(0.3); doc.font('Times-Bold').fontSize(12).fillColor('#1D3F94').text(b.text, M.left, doc.y, { width: W }); doc.fillColor('#000'); doc.moveDown(0.25); }
      else if (b.t === 'h2') { room(b.keep || 50); doc.font('Times-Bold').fontSize(11).text(b.text, M.left, doc.y, { width: W }); doc.moveDown(0.15); }
      else if (b.t === 'p') { room(30); doc.font('Times-Roman').fontSize(10).text(b.text, M.left, doc.y, { width: W, align: 'justify' }); doc.moveDown(0.4); }
      else if (b.t === 'table') table(b);
      else if (b.t === 'signoff') {
        const half = W / 2 - 12;
        b.tiers.forEach(tier => {
          room(118);
          doc.moveDown(0.6);
          doc.font('Times-Bold').fontSize(10.5).fillColor('#1D3F94').text(tier.title.toUpperCase(), M.left, doc.y, { width: W });
          doc.fillColor('#000');
          const y0 = doc.y + 4;
          let yEnd = y0;
          tier.items.forEach((it, i) => {
            const x = M.left + i * (half + 24);
            doc.font('Times-Italic').fontSize(9.5).text(it.verb, x, y0, { width: half });
            doc.moveTo(x, y0 + 44).lineTo(x + half, y0 + 44).lineWidth(0.6).stroke('#000');
            doc.font('Times-Bold').fontSize(10).text(it.name || ' ', x, y0 + 48, { width: half });
            doc.font('Times-Roman').fontSize(9.5).text(it.role, x, doc.y, { width: half });
            doc.text('Signature and date', x, doc.y, { width: half });
            yEnd = Math.max(yEnd, doc.y);
          });
          doc.x = M.left; doc.y = yEnd + 6;
        });
        doc.moveDown(0.4);
      }
    }

    // Footer on every page. The footer sits inside the bottom margin, so the
    // margin is zeroed while it is written or pdfkit adds a blank page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, M.left, A4.height - 40, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

// ---------------------------------------------------------------- Word
function buildDocx(data) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
    BorderStyle, ImageRun, Footer, PageNumber, ShadingType, TableBorders, VerticalAlign, HeightRule,
  } = require('docx');
  const FONT = 'Times New Roman';
  const t = (text, o = {}) => new TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 22, bold: !!o.bold, color: o.color });
  const para = (text, o = {}) => new Paragraph({
    alignment: o.center ? AlignmentType.CENTER : o.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
    spacing: { after: o.after ?? 120, before: o.before ?? 0 },
    keepNext: !!o.keepNext,
    children: Array.isArray(text) ? text : [t(text, o)],
  });
  const children = [];
  children.push(para([t('Presbyterian Church of Ghana', { bold: true, size: 28 })], { center: true, after: 60 }));
  try {
    if (fs.existsSync(CREST)) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new ImageRun({ data: fs.readFileSync(CREST), transformation: { width: 77, height: 87 }, type: 'png' })] }));
  } catch (err) {}
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '1D3F94', space: 6 } },
    children: [t('Adabraka Official Town Congregation', { bold: true, size: 23 })],
  }));

  const table = b => {
    const sz = b.small ? 17 : 19;
    // Pictures at 46 pt (61 px), the same size as in the PDF.
    const faceRun = c => {
      if (c.buf) {
        const k = 61 / Math.max(c.w, c.h);
        return new ImageRun({ data: c.buf, type: c.type, transformation: { width: Math.round(c.w * k), height: Math.round(c.h * k) } });
      }
      return t(c.initials || '', { size: 26, bold: true, color: '1D3F94' });
    };
    const cell = (text, w, o = {}) => new TableCell({
      width: { size: w, type: WidthType.PERCENTAGE },
      verticalAlign: o.middle ? VerticalAlign.CENTER : undefined,
      shading: o.shade || (text && text.face && !text.buf) ? { type: ShadingType.CLEAR, fill: 'E8ECF5', color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [text && text.face
        ? new Paragraph({ alignment: AlignmentType.CENTER, children: [faceRun(text)] })
        : new Paragraph({ children: [t(text, { size: sz, bold: o.bold })] })],
    });
    const rows = [];
    if (b.head) rows.push(new TableRow({ tableHeader: true, children: b.head.map((c, i) => cell(c, b.widths[i], { bold: true, shade: true })) }));
    const body = b.rows.length ? b.rows : [b.widths.map((_, i) => i === 0 ? '— none —' : '')];
    body.forEach(r => {
      const hasFace = r.some(c => c && c.face);
      rows.push(new TableRow({
        cantSplit: true,
        height: hasFace ? { value: 1080, rule: HeightRule.ATLEAST } : undefined,
        children: r.map((c, i) => cell(c, b.widths[i], { bold: b.keyCol && i === 0, middle: hasFace })),
      }));
    });
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
    children.push(para('', { after: 120 }));
  };

  for (const b of data.blocks) {
    if (b.t === 'title') children.push(para([t(b.text, { bold: true, size: 28 })], { center: true, after: 40 }));
    else if (b.t === 'subtitle') children.push(para([t(b.text, { size: 24 })], { center: true, after: 240 }));
    else if (b.t === 'h') children.push(para([t(b.text, { bold: true, size: 24, color: '1D3F94' })], { before: 160, after: 80, keepNext: true }));
    else if (b.t === 'h2') children.push(para([t(b.text, { bold: true, size: 22 })], { before: 80, after: 60, keepNext: true }));
    else if (b.t === 'p') children.push(para([t(b.text, { size: 20 })], { justify: true, after: 120, keepNext: !!b.keepNext }));
    else if (b.t === 'table') table(b);
    else if (b.t === 'signoff') {
      b.tiers.forEach(tier => {
        children.push(para([t(tier.title.toUpperCase(), { bold: true, size: 21, color: '1D3F94' })], { before: 200, after: 60, keepNext: true }));
        const slot = it => new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 240 },
          children: [
            new Paragraph({ spacing: { after: 480 }, keepNext: true, children: [new TextRun({ text: it.verb, font: FONT, size: 19, italics: true })] }),
            para([t('____________________________________', { size: 20 })], { after: 20, keepNext: true }),
            para([t(it.name || '', { bold: true, size: 20 })], { after: 0, keepNext: true }),
            para([t(it.role, { size: 19 })], { after: 0, keepNext: true }),
            para([t('Signature and date', { size: 19 })], { after: 0 }),
          ],
        });
        const cells = tier.items.map(slot);
        if (cells.length < 2) cells.push(new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, children: [new Paragraph('')] }));
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TableBorders.NONE, rows: [new TableRow({ cantSplit: true, children: cells })] }));
      });
      children.push(para('', { after: 160 }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1000, right: 1000 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 17 }),
              new TextRun({ text: ' of ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 17 }),
            ],
          })],
        }),
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { reportData, buildPdf, buildDocx };
