// A paragraph edited in the app after the export: it must come first, with the
// Clerk's wording, the merged result and a Merge button. Run after setup + makedocx.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const db = require(path.resolve(__dirname, '../../utils/db'));
let n = 0, fail = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
(async () => {
  // the Clerk edits item 8.1's second paragraph after exporting
  const d = db.findById('minutes_docs', 1);
  db.update('minutes_docs', 1, { sections: d.sections.map(s => s.key === 'other' ? { ...s, children: s.children.map((c, i) => i === 0 ? { ...c, body: c.body.replace('yet to follow up', 'still to follow up') } : c) } : s) });
  const W = process.env.W ? +process.env.W : 1280;
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: W, height: 900 } });
  await ctx.addCookies([{ name: 'token', value: fs.readFileSync('cookie.txt', 'utf8').trim().replace(/^token=/, ''), domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4555/minutes.html'); await page.waitForFunction(() => typeof openDoc === 'function'); await page.waitForTimeout(500);
  await page.evaluate(() => openDoc(1)); await page.waitForTimeout(500);
  await page.click('.mtab[data-pane="docs"]'); await page.setInputFiles('#prFile', 'proofread.docx'); await page.waitForSelector('#prBody .pr-group');
  const groups = await page.locator('#prBody .pr-group').allInnerTexts();
  ok(/Changed in the app/.test(groups[0]), 'the changed paragraph is listed first: ' + groups[0]);
  const card = page.locator('[data-pr="ch:2"]');
  const t = await card.innerText();
  ok(/What changed in the app since you sent it/.test(t) && /still/.test(t), 'shows the Clerk’s current wording');
  ok(/After merging/.test(t) && /still to follow up with Finance/.test(t), 'shows his correction merged into it');
  ok(await page.getByRole('button', { name: /Merge his 1 correction into your newer wording/ }).isVisible(), 'the merge-all button says what it does');
  ok(await card.locator('.pr-diff.pr-ctx del').first().innerText() === 'yet' && await card.locator('.pr-diff.pr-ctx ins').first().innerText() === 'still', 'it shows exactly what changed in the app: yet → still');
  await page.locator('#prCard').screenshot({ path: `shots/${W < 600 ? 'phone-' : ''}6-changed-first.png` });
  await card.getByRole('button', { name: 'Merge into my wording' }).click();
  await page.waitForFunction(() => /merged into your wording/.test(document.getElementById('prBody').innerText));
  await page.waitForFunction(() => /still to follow up with Finance/.test(doc.sections.find(s => s.key === 'other').children[0].body)).catch(() => {});
  ok(await page.evaluate(() => doc.sections.find(s => s.key === 'other').children[0].body.split('\n')[1]) === 'He added that he was still to follow up with Finance to complete the purchase.', 'Merge writes it into the minutes');
  await page.locator('[data-pr="ch:2"]').getByRole('button', { name: '↶ Undo' }).click();
  await page.waitForFunction(() => /Merge into my wording/.test(document.getElementById('prBody').innerText));
  ok(await page.evaluate(() => doc.sections.find(s => s.key === 'other').children[0].body.split('\n')[1]) === 'He added that he was still to follow up with finance to complete the purchase.', 'Undo restores the Clerk’s wording');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
