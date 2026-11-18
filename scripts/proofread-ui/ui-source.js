// Corrections on text the app writes from details kept elsewhere (the opening,
// a letter…): a button opens where it comes from, and "Back to proofreading"
// returns. Seeds its own proofreading record; run after setup.js.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const db = require(path.resolve(__dirname, '../../utils/db'));
let n = 0, fail = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
(async () => {
  const letter = 'A letter of appreciation was received from Rev Prince Amoh, on behalf of himself and his family, thanking the Session for their presence, prayers and immense support during his Send-Off.';
  db.insert('correspondence', { minutesId: 1, heading: 'Appreciation', from: 'Rev Prince Amoh', summary: letter, status: 'tabled' });
  const open = 'The meeting commenced at 6.32 p.m. Mrs Cecilia Pokua Anto led the Session in devotion.';
  db.insert('minutes_proofreads', { docId: 1, date: '2026-09-24', fileName: 'x.docx', uploadedAt: new Date().toISOString(), proofreader: 'Dr. N. Tweneboa', words: 100, corrections: 2, lessons: [], comments: [],
    changes: [
      { id: 1, before: open, after: open.replace('6.32 p.m.', '6:32 pm'), segs: [{ text: 'The meeting commenced at ' }, { mode: 'del', text: '6.32 p.m.' }, { mode: 'ins', text: '6:32 pm' }, { text: ' Mrs Cecilia Pokua Anto led the Session in devotion.' }], at: { match: 'none' }, status: 'pending' },
      { id: 2, before: letter, after: letter.replace('immense', 'great'), segs: [{ text: letter }], at: { match: 'none' }, status: 'pending' },
    ] });
  const W = process.env.W ? +process.env.W : 1280;
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: W, height: 900 } });
  await ctx.addCookies([{ name: 'token', value: fs.readFileSync('cookie.txt', 'utf8').trim().replace(/^token=/, ''), domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4555/minutes.html'); await page.waitForFunction(() => typeof openDoc === 'function'); await page.waitForTimeout(500);
  await page.evaluate(() => openDoc(1)); await page.waitForTimeout(700);
  await page.click('.mtab[data-pane="docs"]'); await page.waitForSelector('#prBody .pr-group');
  const c1 = page.locator('[data-pr="ch:1"]'), c2 = page.locator('[data-pr="ch:2"]');
  ok(await c1.getByRole('button', { name: /opening & devotion details/ }).isVisible(), 'the opening line offers "Open the opening & devotion details"');
  ok(await c2.getByRole('button', { name: /letter on the Correspondence tab/ }).isVisible(), 'the letter offers "Open the letter on the Correspondence tab"');
  await page.locator('#prCard').screenshot({ path: `shots/${W < 600 ? 'phone-' : ''}7-source-buttons.png` });
  await c1.getByRole('button', { name: /opening & devotion/ }).click(); await page.waitForTimeout(900);
  ok(await page.locator('.mtab[data-pane="body"]').evaluate(e => e.classList.contains('active')), 'it opens the Minutes tab');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'pCommenced', 'with the cursor in the "commenced at" field');
  ok(await page.locator('.pr-flash').count() === 1, 'its box flashed');
  await page.screenshot({ path: `shots/${W < 600 ? 'phone-' : ''}8-source-opened.png` });
  await page.click('#prBackPill'); await page.waitForTimeout(500);
  ok(await page.locator('.mtab[data-pane="docs"]').evaluate(e => e.classList.contains('active')) && await c1.evaluate(e => e.classList.contains('pr-flash')), 'Back to proofreading returns to that card');
  await c2.getByRole('button', { name: /letter/ }).click(); await page.waitForTimeout(900);
  ok(await page.locator('.mtab[data-pane="corr"]').evaluate(e => e.classList.contains('active')), 'the letter opens the Correspondence tab');
  ok(await page.locator('.corr-card.pr-flash').count() === 1, 'at that letter, flashed');
  ok(await page.locator('#prBackPill').isVisible(), 'with the way back showing');
  await page.goBack(); await page.waitForTimeout(500);
  ok(await page.locator('.mtab[data-pane="docs"]').evaluate(e => e.classList.contains('active')), 'the phone Back button also returns');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
