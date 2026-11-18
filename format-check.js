// The generated Word must carry the same formatting as the minutes it
// continues. Measured from the congregation's 2026 documents: 179 of 180
// Subject-column paragraphs are justified.
const { buildSessionMinutesDocx } = require('./utils/sessionDocx');
const { buildSessionMinutesPdf } = require('./utils/sessionMinutesPdf');
const fs = require('fs'), zlib = require('zlib');
const data = {
  heading: 'AOTC Session Meeting', date: '2026-07-09', venue: 'Rev Adu-Mante Session Hall',
  present: [{ name: 'REV JOSEPH RICHMOND TETTEY', position: 'DISTRICT MINISTER' }],
  inAttendance: [], apologies: [], absent: [],
  rows: [
    { no: '5.1', subject: 'Update on Building Project', level: 1,
      body: 'Ing Sampson Agudze informed the Session that the contractor had submitted a claim for payment of GHS 318,798.52. He reported that the Building Committee had reviewed the claim and arrived at a figure of GHS 235,379.26 against the contractor, indicating that the contractor was owing the Congregation that amount and that the consultants had been informed.',
      action: 'Noted' },
    { no: '4.1', subject: 'Review of Minutes of Session Meeting for 9th April 2026', level: 1, underline: true,
      body: 'In the absence of the Session Clerk, Dr Michael Tenkorang led the Session to review the minutes of the meeting held on 9th April 2026.',
      action: '' },
    { no: '9.1', subject: 'Prayers', level: 1,
      body: 'The Senior Presbyter led the Session in prayer on the following:\n'
        + 'God\u2019s presence with the Congregation at all times\n'
        + 'Protection of the Chapel from further flooding\n'
        + 'Protection of congregants and their families from ailments and premature death\n\n'
        + 'Following the prayers led by the Senior Presbyter, the District Minister led the members of the Session to pray for one another.',
      action: 'Noted' },
  ],
  appendices: [], signatories: { recordedBy: { name: 'G. A. Adjei', title: 'Session Clerk' },
    confirmedBy: { name: 'Rev J. R. Tettey', title: 'Minister-in-Charge' } }, footerName: 'Session',
};
(async () => {
  const buf = await buildSessionMinutesDocx(data);
  fs.writeFileSync('/tmp/out.docx', buf);
  const AdmZip = require('adm-zip');
  const xml = new AdmZip('/tmp/out.docx').readAsText('word/document.xml');
  const rows = xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
  let both = 0, other = 0;
  rows.forEach(tr => {
    const tcs = tr.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) || [];
    if (tcs.length < 2) return;
    const no = tcs[0].replace(/<[^>]+>/g, '').trim();
    if (!/^\d+\.\d+$/.test(no)) return;
    (tcs[1].match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).forEach(p => {
      if (!p.replace(/<[^>]+>/g, '').trim()) return;
      // Bulleted points are the one exception: they are short, and the
      // congregation's own minutes leave list items ragged-right.
      if (/w:hanging="360"/.test(p)) return;
      /<w:jc w:val="both"/.test(p) ? both++ : other++;
    });
  });
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { c ? (pass++, console.log('  \u2713', n)) : (fail++, console.log('  \u2717 FAIL:', n, JSON.stringify(x))); };
  console.log('The Word minutes match the congregation\'s own formatting:');
  ok('every Subject paragraph of prose is justified', both > 0 && other === 0, { justified: both, ragged: other });

  // the Action column is left as it is — their own documents are mixed there,
  // and the text is too short for justification to show
  const actionJust = (xml.match(/<w:jc w:val="both"/g) || []).length;
  ok('and the document does set alignment at all', actionJust > 0, actionJust);

  // ---- prayer points are set as bullets, as the congregation's own minutes do
  const SM = require('./utils/sessionMinutes');
  const prayersRow = data.rows.find(r => r.subject === 'Prayers');
  const lines = SM.bulletise(prayersRow.body);
  ok('the prayers lead-in stays prose', lines[0].bullet === false, lines[0]);
  ok('every prayer point is a bullet', lines.slice(1, 4).every(l => l.bullet), lines.slice(1, 4));
  ok('a blank line returns to prose for the closing sentence', lines[4] && lines[4].bullet === false, lines[4]);
  ok('a point the clerk typed with a dash is a bullet, marker stripped',
    SM.bulletise('- The Chapel Building Project')[0].text === 'The Chapel Building Project');
  ok('ordinary prose is never bulleted',
    SM.bulletise(data.rows[0].body).every(l => !l.bullet));

  // in the Word file the bullet is a real hanging-indent paragraph at 720 twips
  const bulletParas = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
    .filter(p => /w:left="720"/.test(p) && /\u2022/.test(p));
  ok('the Word file sets the points as bullets at a 720-twip indent', bulletParas.length === 3, bulletParas.length);
  ok('and the bullets hang, so a wrapped point lines up under its first word',
    bulletParas.every(p => /w:hanging="360"/.test(p)));

  // ---- the closure reads back four ways
  const base = { closureMovedBy: 'Mr Kwaku Koranteng', closedAt: '9.05 p.m.', closureSecondedBy: 'Ing Sampson Agudze' };
  const say = q => SM.autoBody('closure', { ...base, ...q });
  ok('closure: neither rite — just the mover and the seconder', /seconded by Ing Sampson Agudze\.$/.test(say({})), say({}));
  ok('closure: the Grace alone', /after which the Grace was said\.$/.test(say({ graceSaid: true })), say({ graceSaid: true }));
  ok('closure: the benediction alone', /the benediction was given by Rev K\.$/.test(say({ benedictionBy: 'Rev K' })));
  ok('closure: the Grace and the benediction together',
    /the Grace was said and the benediction pronounced by Rev K\.$/.test(say({ graceSaid: true, benedictionBy: 'Rev K' })),
    say({ graceSaid: true, benedictionBy: 'Rev K' }));

  // ---- fonts, measured from the congregation's own 2026 minutes
  // Headings, the No. column and the Subject lines are Times New Roman 12pt;
  // the body of an item, the Action column and the signatures are Verdana 10pt.
  const cellsOf = tr => tr.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) || [];
  const bodyRows = (xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [])
    .filter(tr => /^\d+\.\d+$/.test(cellsOf(tr)[0] ? cellsOf(tr)[0].replace(/<[^>]+>/g, '').trim() : ''));
  ok('there are body rows to measure', bodyRows.length >= 3, bodyRows.length);

  const noCells = bodyRows.map(tr => cellsOf(tr)[0]);
  ok('the item number is bold', noCells.every(c => /<w:b\/>|<w:b /.test(c)), noCells[0] && noCells[0].slice(0, 200));
  ok('and the item number stays Times New Roman',
    noCells.every(c => /Times New Roman/.test(c)));

  const subjCells = bodyRows.map(tr => cellsOf(tr)[1]);
  ok('the body of an item is Verdana', subjCells.every(c => /w:ascii="Verdana"/.test(c)));
  ok('at 10pt', subjCells.every(c => /<w:sz w:val="20"\/>/.test(c)));
  ok('while the Subject heading stays Times New Roman 12pt',
    subjCells.every(c => /Times New Roman[\s\S]{0,200}?<w:sz w:val="24"/.test(c)));

  // ---- the underline belongs to the TITLE and nowhere else
  // Measured across the 2026 minutes: the title is underlined in all ten, and
  // there is not one underlined run anywhere inside the table.
  const titlePara = (xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [])
    .find(par => /MINUTES OF THE/.test(par.replace(/<[^>]+>/g, '')));
  ok('the document title is there', !!titlePara);
  ok('and the title is underlined', /<w:u [^>]*w:val="single"/.test(titlePara || ''),
    (titlePara || '').slice(0, 200));
  const tableXml = xml.slice(xml.indexOf('<w:tbl>'), xml.lastIndexOf('</w:tbl>'));
  const tableUnderlines = (tableXml.match(/<w:u [^>]*w:val="single"/g) || []).length;
  ok('and nothing inside the table is underlined', tableUnderlines === 0, tableUnderlines);

  // ---- body text is set at 1.5, as 273 of 281 body paragraphs in 2026 are
  ok('the body is set at 1.5 line spacing',
    subjCells.every(c => /w:line="360"/.test(c)), subjCells[0] && subjCells[0].slice(0, 200));
  // The Subject HEADINGS take 1.5 as well — every non-empty paragraph in the
  // Subject column, heading and body alike.
  const subjParas = subjCells.flatMap(c => (c.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []))
    .filter(par => par.replace(/<[^>]+>/g, '').trim());
  ok('and so are the headings above it', subjParas.every(par => /w:line="360"/.test(par)),
    subjParas.filter(par => !/w:line="360"/.test(par)).length);

  // ---- the attendance page stands alone; the table opens page two
  const beforeTable = xml.slice(0, xml.indexOf('<w:tbl>'));
  ok('a page break sends the minutes table to the second page',
    /<w:br w:type="page"\/>/.test(beforeTable), beforeTable.slice(-200));

  // ---- the panel heading is a heading: Times New Roman 12pt on #D9E2F3
  const panel = xml.slice(xml.lastIndexOf('<w:tbl>', xml.indexOf('Recorded by')));
  ok('the signature heading is Times New Roman 12pt like every other heading',
    /Times New Roman[\s\S]{0,300}?<w:sz w:val="24"[\s\S]{0,400}?Recorded by/.test(panel), panel.slice(0, 400));
  ok('and the heading row is filled #D9E2F3', /w:fill="D9E2F3"/.test(panel));
  ok('while the name under it stays Verdana',
    /Recorded by[\s\S]*?w:ascii="Verdana"[\s\S]{0,400}?Adjei/.test(panel), panel.length);

  // ---- the signatures have room to sign in
  const sigTail = xml.slice(xml.indexOf('Recorded by'));
  ok('the signature block is Verdana', /w:ascii="Verdana"/.test(sigTail.slice(0, 3000)));
  const nameAt = sigTail.indexOf('Gideon');
  const blanks = (sigTail.slice(0, nameAt).match(/<w:p\b[\s\S]*?<\/w:p>/g) || [])
    .filter(par => !par.replace(/<[^>]+>/g, '').trim()).length;
  ok('with room left to actually sign above the name', blanks >= 3, blanks);

  ok('the signatures sit in a ruled panel with a heading row',
    /Recorded by[\s\S]{0,900}Confirmed by/.test(sigTail.slice(0, 4000)));
  ok('there is no signing date — the minutes are dated by the meeting they record',
    !/Date:/.test(sigTail.slice(0, 4000)));
  // The panel follows the minutes table directly — same width, same indent —
  // rather than being pushed onto a page of its own.
  const bodyW = (xml.match(/<w:tblW w:type="dxa" w:w="(\d+)"\/>/g) || []);
  ok('the signature panel is the same width as the minutes table',
    bodyW.length >= 2 && bodyW[bodyW.length - 1] === bodyW[bodyW.length - 2], bodyW.slice(-2));
  const between = xml.slice(xml.lastIndexOf('</w:tbl>', xml.indexOf('Recorded by')), xml.indexOf('Recorded by'));
  ok('and sits one line under it, not three',
    (between.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).filter(par => !par.replace(/<[^>]+>/g, '').trim()).length <= 1,
    (between.match(/<w:p\b/g) || []).length);

  const pdf = await buildSessionMinutesPdf(data);
  ok('the PDF builds', pdf.length > 5000, pdf.length);
  // pdfkit keeps its font table per document, so EVERY document this module
  // makes has to register the embedded fonts — the agenda is a separate one and
  // was missed the first time, dying on ENOENT 'Head-Bold'.
  const { buildSessionAgendaPdf } = require('./utils/sessionMinutesPdf');
  let agendaOk = false;
  try {
    const ag = await buildSessionAgendaPdf({ heading: 'AOTC Session Meeting', date: '2026-07-09',
      venue: 'Rev Adu-Mante Session Hall', startTime: '18:30',
      agenda: [{ mins: 10, item: 'Opening Prayer and Devotion', responsible: 'Mr Alex Abankwa' }] });
    agendaOk = ag && ag.length > 2000;
  } catch (e) { agendaOk = e.message; }
  ok('and so does the agenda PDF, with the same fonts registered', agendaOk === true, agendaOk);
  console.log('');
  console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
  process.exit(fail ? 1 : 0);
})();
