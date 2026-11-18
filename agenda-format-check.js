// AOTC Track — the agenda, measured against the congregation's own.
//
// Every figure asserted here was counted off their 30 July 2026 agenda
// (docProps say Word, three columns of 1881/4678/4249 twips, table pulled 180
// left, Calibri 11pt body, News Gothic MT masthead and title, Heading 2 blue
// 1F4E79). The generated agenda had drifted from all of it, which is what made
// it read heavier and cruder than theirs:
//
//   · the display face was set on the table as well as the masthead
//   · the columns were narrower, so "6:30 pm (10 mins)" wrapped
//   · the duration was bold, which is what pushed it over the edge
//   · the hanging indent left no room for "10." beside "Closure"
//
// If these fail, hold the output up against the real document before changing
// the numbers — and render it: `node agenda-preview.js`.
const fs = require('fs');
const AdmZip = require('adm-zip');
const { buildSessionAgendaDocx } = require('./utils/sessionDocx');
const { buildSessionAgendaPdf } = require('./utils/sessionMinutesPdf');
const { SAMPLE } = require('./agenda-preview');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓', n))
  : (fail++, console.log('  ✗ FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 240))); };

(async () => {
  const buf = await buildSessionAgendaDocx(SAMPLE);
  const zip = new AdmZip(buf);
  const xml = zip.getEntry('word/document.xml').getData().toString('utf8');
  const tbl = xml.slice(xml.indexOf('<w:tbl>'), xml.lastIndexOf('</w:tbl>'));

  console.log('The page and the table, as measured off their agenda:');
  ok('three columns', (tbl.match(/<w:gridCol /g) || []).length === 3,
    (tbl.match(/<w:gridCol [^/]*\/>/g) || []));
  // 2141, not the 1881 measured off their agenda: at 1881 the Time column gives
  // 88.3pt and "6:40 pm (10 mins)" is 88.6pt in the fallback face, so it wrapped
  // and printed through the rule. The 260 came off the Responsible column.
  ok('2141 / 4678 / 3989 twips — the Time column widened to hold the times',
    (tbl.match(/<w:gridCol w:w="(\d+)"/g) || []).join(',') === '<w:gridCol w:w="2141",<w:gridCol w:w="4678",<w:gridCol w:w="3989"',
    tbl.match(/<w:gridCol w:w="\d+"/g));
  ok('and the table is still the same overall width',
    [2141, 4678, 3989].reduce((a, b) => a + b, 0) === 10808);
  ok('a fixed layout, so Word cannot re-flow the columns', /<w:tblLayout w:type="fixed"\/>/.test(tbl));
  ok('pulled 180 twips left, as theirs is', /<w:tblInd [^>]*w:w="-180"/.test(tbl), tbl.match(/<w:tblInd[^/]*\/>/));
  ok('zero left cell margin', /<w:tblCellMar><w:left [^>]*w:w="0"/.test(tbl),
    (tbl.match(/<w:tblCellMar>[\s\S]*?<\/w:tblCellMar>/) || [])[0]);
  ok('and NO table-level borders — every rule on this table is drawn by a cell',
    !/<w:tblBorders>[\s\S]*?w:val="single"[\s\S]*?<\/w:tblBorders>/.test(tbl),
    (tbl.match(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/) || [])[0]);

  console.log('The faces — the display font belongs to the masthead, not the table:');
  ok('the title is News Gothic MT', /w:ascii="News Gothic MT"/.test(xml.slice(0, xml.indexOf('<w:tbl>'))));
  ok('and it is bold, underlined and centred',
    /<w:jc w:val="center"\/>/.test(xml.slice(0, xml.indexOf('<w:tbl>')))
    && /<w:u w:val="single"\/>/.test(xml.slice(0, xml.indexOf('<w:tbl>'))));
  ok('the ordinal suffix is raised', /<w:vertAlign w:val="superscript"\/>/.test(xml),
    xml.slice(0, 40));
  ok('NOTHING in the table is set in the display face — that was the main fault',
    !/w:ascii="News Gothic MT"/.test(tbl),
    (tbl.match(/w:ascii="[^"]+"/g) || []).slice(0, 6));
  ok('only the column headings name a face, and it is the template’s major one',
    [...new Set(tbl.match(/w:ascii="[^"]+"/g) || [])].join(',') === 'w:ascii="Calibri Light"',
    [...new Set(tbl.match(/w:ascii="[^"]+"/g) || [])]);
  ok('the headings are the congregation’s Heading 2 blue',
    (tbl.match(/<w:color w:val="1F4E79"\/>/g) || []).length === 3,
    (tbl.match(/<w:color w:val="[0-9A-F]{6}"\/>/g) || []));

  console.log('The Time column:');
  ok('the clock time and the duration are one run, not two',
    /<w:t[^>]*>6:30 pm \(10 mins\)<\/w:t>/.test(tbl), tbl.match(/6:30[^<]*/));
  ok('and none of it is bold — bold is what wrapped the column',
    !/<w:b\/>[\s\S]{0,200}?6:30 pm/.test(tbl));
  // Counted on the FIRST cell of each row, because the Responsible column is
  // merged too on an item that is one person's — see "Whose item is it" below.
  const firstCells = tbl.split(/(?=<w:tr[ >])/).slice(1)
    .map(tr => (tr.split(/(?=<w:tc>)/)[1] || ''));
  ok('written once per agenda item, merged down the block',
    firstCells.filter(tc => /<w:vMerge w:val="restart"\/>/.test(tc)).length === SAMPLE.rows.length,
    firstCells.filter(tc => /<w:vMerge w:val="restart"\/>/.test(tc)).length);
  ok('and continued, not repeated, on the rest of the block',
    firstCells.filter(tc => /<w:vMerge w:val="continue"\/>/.test(tc)).length
      === firstCells.length - 1 - SAMPLE.rows.length,
    firstCells.filter(tc => /<w:vMerge w:val="continue"\/>/.test(tc)).length);
  ok('and centred against it', /<w:vAlign w:val="center"\/>/.test(tbl));

  console.log('The Item column:');
  ok('a numbered item’s text starts at 451, its number at 91',
    /<w:ind w:left="451" w:hanging="360"\/>/.test(tbl), tbl.match(/<w:ind[^/]*\/>/g).slice(0, 4));
  ok('which is what leaves room for "10." beside "Closure"',
    /<w:ind w:left="451" w:hanging="360"\/>/.test(tbl));
  ok('a sub-item’s text starts at 811', /<w:ind w:left="811" w:hanging="360"\/>/.test(tbl));
  ok('the numbered items are bold', (tbl.match(/<w:b\/>/g) || []).length >= SAMPLE.rows.length);
  ok('the sub-items are not', /Update on Building Project/.test(tbl)
    && !/<w:b\/>[^<]*<\/w:rPr>[\s\S]{0,80}Update on Building Project/.test(tbl));

  console.log('One table row per line of the agenda, so the names stay level:');
  const rows = (tbl.match(/<w:tr[ >]/g) || []).length;
  const lines = SAMPLE.rows.reduce((n, r) => n + 1 + (r.subItems || []).length, 0);
  ok('a row for the headings, then one per line', rows === lines + 1, { rows, expected: lines + 1 });
  ok('so "Mrs. Grace Bediako-Asante" shares a row with the item it belongs to',
    new RegExp('Replacement of Damaged Privacy Screens[\\s\\S]{0,900}?Mrs\\. Grace Bediako-Asante').test(tbl));
  ok('and "Senior Presbyter" with the send-off, not a line above it',
    new RegExp('Send-off of the District Minister[\\s\\S]{0,900}?Senior Presbyter').test(tbl));

  console.log('Whose item is it — the Responsible column says it two ways:');
  {
    // Review of Minutes: the Session Clerk takes the whole item, both sets of
    // minutes under it. ONE name, merged down the block and centred, matching
    // the clock time opposite it.
    const trs = tbl.split(/(?=<w:tr[ >])/).slice(1);
    const rowOf = re => trs.findIndex(tr => re.test(tr));
    const review = rowOf(/Review of Minutes/);
    ok('the Review of Minutes heading row carries the name', review > 0);
    ok('and it is merged down the block, like the clock time beside it',
      (trs[review].match(/<w:vMerge w:val="restart"\/>/g) || []).length === 2,
      (trs[review].match(/<w:vMerge[^/]*\/>/g) || []));
    ok('so the name is written once, not repeated under each set of minutes',
      (tbl.match(/Session Clerk/g) || []).length === 3,   // Roll, Review, Correspondence
      (tbl.match(/Session Clerk/g) || []).length);
    ok('the sub-item rows beneath it carry no name of their own',
      !/11th June 2026 Session Meeting[\s\S]{0,600}?Session Clerk/.test(trs[review + 1] || ''),
      (trs[review + 1] || '').slice(0, 80));

    // Matters Arising: a different person answers for each heading, so the
    // column goes back to a name per line, level with its own heading.
    const matters = rowOf(/Matters Arising/);
    ok('the Matters Arising heading row is NOT merged on the Responsible side',
      (trs[matters].match(/<w:vMerge w:val="restart"\/>/g) || []).length === 1,
      (trs[matters].match(/<w:vMerge[^/]*\/>/g) || []));
    ok('because its sub-items each answer for themselves',
      new RegExp('Update on Building Project[\\s\\S]{0,600}?Ing\\. Sampson Agudze').test(trs[matters + 1] || ''),
      (trs[matters + 1] || '').slice(0, 60));
    ok('an item whose sub-item owns the name does not centre the item’s own',
      (trs[rowOf(/Main Business/)].match(/<w:vMerge w:val="restart"\/>/g) || []).length === 1);
    // A one-line item has no block to be centred against. Centring there put a
    // two-line name (Devotion's two people) ABOVE its own row and printed it
    // through the rule between it and the column headings.
    ok('a one-line item keeps its name on its own line, not centred',
      (trs[rowOf(/Devotion/)].match(/<w:vMerge w:val="restart"\/>/g) || []).length === 1,
      (trs[rowOf(/Devotion/)].match(/<w:vMerge[^/]*\/>/g) || []));
    ok('and the name is still there',
      /Ing\. Sampson Agudze \/ Mad\. Gladys Biama Sackey/.test(trs[rowOf(/Devotion/)]));
  }

  console.log('The rules: one ruled block per agenda item, nothing between its sub-items:');
  ok('every row carries a right-hand rule, on the Time column only',
    (tbl.match(/<w:right w:val="single"/g) || []).length === rows,
    { right: (tbl.match(/<w:right w:val="single"/g) || []).length, rows });
  ok('no vertical rule between Item and Responsible',
    !/<w:left w:val="single"/.test(tbl));
  // A rule above each item and below its last sub-item: three cells apiece.
  ok('a rule above each numbered item',
    (tbl.match(/<w:top w:val="single"/g) || []).length === (SAMPLE.rows.length + 1) * 3,
    (tbl.match(/<w:top w:val="single"/g) || []).length);
  ok('and one below the last of its sub-items',
    (tbl.match(/<w:bottom w:val="single"/g) || []).length === (SAMPLE.rows.length + 1) * 3,
    (tbl.match(/<w:bottom w:val="single"/g) || []).length);

  console.log('The masthead comes from the template, not from the code:');
  ok('the crest is in the header, where their document keeps it',
    !!zip.getEntry('word/header1.xml') && /<w:drawing>/.test(zip.getEntry('word/header1.xml').getData().toString('utf8')));
  ok('A4, with their margins',
    /<w:pgSz w:w="11906" w:h="16838"/.test(xml) && /<w:pgMar w:top="450"[^/]*w:left="873"/.test(xml),
    xml.match(/<w:pgMar[^/]*\/>/));

  console.log('The two formats agree, and the Time column holds every time:');
  {
    const pdfSrc = fs.readFileSync('./utils/sessionMinutesPdf.js', 'utf8');
    const twips = (pdfSrc.match(/const AG_TWIPS = \[([\d, ]+)\]/) || [])[1];
    ok('the PDF uses the same column widths as the Word file, not a guess at them',
      twips && twips.replace(/\s/g, '') === '2141,4678,3989', twips);
    ok('and the same table geometry — 540.4pt wide, starting at 34.65pt',
      /const AG_TBL_X = 34\.65;/.test(pdfSrc) && /const AG_TBL_W = 540\.4;/.test(pdfSrc));

    // The whole point of widening it: measure the real strings in the real face.
    const PDFDocument = require('pdfkit');
    const probe = new PDFDocument({ size: 'A4' });
    probe.registerFont('Ag', './utils/fonts/Carlito-Regular.ttf');
    probe.font('Ag').fontSize(11);
    const usable = 540.4 * 2141 / 10808 - 5.75;
    const worst = ['6:30 pm (8 mins)', '6:40 pm (10 mins)', '12:30 pm (10 mins)',
      '10:05 pm (45 mins)', '12:45 pm (105 mins)'];
    worst.forEach(str => ok(`"${str}" fits on one line`,
      probe.widthOfString(str) <= usable,
      { width: +probe.widthOfString(str).toFixed(1), usable: +usable.toFixed(1) }));

    ok('the block is tall enough to hold the Time, however it wraps',
      /const asideH = Math\.max\(/.test(pdfSrc) && /if \(asideH > blockH\)/.test(pdfSrc));
  }

  console.log('The Calibri-metric face ships with the app, so the PDF cannot fall back:');
  ok('Carlito is bundled', fs.existsSync('./utils/fonts/Carlito-Regular.ttf')
    && fs.existsSync('./utils/fonts/Carlito-Bold.ttf'));
  ok('with its licence beside it', fs.existsSync('./utils/fonts/Carlito-LICENCE.txt'));
  ok('and it is tried FIRST, before anything on the box',
    /AG_CANDIDATES = \[[\s\S]{0,600}?path\.join\(__dirname, 'fonts', 'Carlito-Regular\.ttf'\)/
      .test(fs.readFileSync('./utils/sessionMinutesPdf.js', 'utf8')));

  console.log('And the PDF is the same document in the other format:');
  const pdf = await buildSessionAgendaPdf(SAMPLE);
  ok('it builds', Buffer.isBuffer(pdf) && pdf.length > 20000, pdf && pdf.length);
  const text = pdf.toString('latin1');
  // Was Liberation Sans on the server, which is ~9% wider than Calibri and is
  // what overflowed the Time column. Now it can only be the bundled face.
  ok('set in Carlito — the same metrics as the Word file’s Calibri',
    /Carlito/.test(text) && !/LiberationSans|DejaVuSans/.test(text),
    (text.match(/\/BaseFont\s*\/[A-Za-z0-9+\-]+/g) || []).slice(0, 6));
  ok('and it is not the old boxed grid — no full cell rectangles',
    !/function buildSessionAgendaPdf[\s\S]*doc\.rect\(x, y, w, rowH\)/.test(
      fs.readFileSync('./utils/sessionMinutesPdf.js', 'utf8')));
  ok('its masthead and title are sans, like the Word file’s',
    /const F = AG_FB\(\);/.test(fs.readFileSync('./utils/sessionMinutesPdf.js', 'utf8')));
  const pdfSrc = fs.readFileSync('./utils/sessionMinutesPdf.js', 'utf8');
  ok('it centres a whole-block name on the same rule as the Word file',
    /const wholeBlock = subs\.length > 0 && !perLine/.test(pdfSrc));
  ok('and never draws it above the top of its own block',
    (pdfSrc.match(/Math\.max\(top \+ AG_ROW_PAD/g) || []).length === 2,
    (pdfSrc.match(/Math\.max\(top \+ AG_ROW_PAD/g) || []).length);

  console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
