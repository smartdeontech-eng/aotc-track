// Export the minutes from the running server and "proofread" them like Dr Tweneboa would.
const JSZip = require(require('path').resolve(__dirname, '../../node_modules/jszip')); const fs = require('fs');
(async () => {
  const [, , base, cookie, id] = process.argv;
  const ex = await fetch(`${base}/api/minutes/${id}/minutes.docx`, { headers: { cookie } });
  if (!ex.ok) throw new Error('export ' + ex.status);
  const zip = await JSZip.loadAsync(Buffer.from(await ex.arrayBuffer()));
  let xml = await zip.file('word/document.xml').async('string');
  const A = 'w:id="900" w:author="Dr. N. Tweneboa" w:date="2026-10-01T10:00:00Z"';
  const run = t => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const findRun = text => { const m = xml.match(new RegExp(`<w:r>(?:(?!<w:r>)[\\s\\S])*?<w:t[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</w:t></w:r>`)); return m && m[0]; };
  const swap = (w, h) => { const i = xml.indexOf(w); if (i < 0) throw new Error('no run'); xml = xml.slice(0, i) + h + xml.slice(i + w.length); };
  const P1 = 'The Session Clerk informed the Session that the data was already available, and explained that distant members had been divided amongst Presbyters.';
  const P2 = 'He added that he was yet to follow up with finance to complete the purchase.';
  const P3 = 'The legal team was to be shared with Head Office.';
  swap(findRun(P1), run('The Session Clerk informed the Session that the data was already available') + `<w:del ${A}><w:r><w:delText>, and</w:delText></w:r></w:del><w:ins ${A}>${run(' and')}</w:ins>` + run(' explained that distant members had been ') + `<w:del ${A}><w:r><w:delText>divided amongst</w:delText></w:r></w:del><w:ins ${A}>${run('allocated to')}</w:ins>` + run(' Presbyters.'));
  swap(findRun(P2), run('He added that he was yet to follow up with ') + `<w:del ${A}><w:r><w:delText>finance</w:delText></w:r></w:del><w:ins ${A}>${run('Finance')}</w:ins>` + run(' to complete the purchase.'));
  swap(findRun(P3), run('The legal team was to be shared ') + '<w:commentRangeStart w:id="8"/>' + run('with Head Office') + '<w:commentRangeEnd w:id="8"/>' + run('.'));
  zip.file('word/document.xml', xml);
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="8" w:author="Dr. N. Tweneboa"><w:p><w:r><w:t>Perhaps “shared with the legal teams of the Presbytery and Head Office”?</w:t></w:r></w:p></w:comment></w:comments>`);
  fs.writeFileSync('proofread.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  console.log('docx ok');
})().catch(e => { console.error(e); process.exit(1); });
