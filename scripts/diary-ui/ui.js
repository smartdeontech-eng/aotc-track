const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright'); const fs = require('fs');
let n = 0, fail = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const day = k => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
(async () => {
  const W = +(process.env.W || 1280), dark = process.env.DARK === '1';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: W, height: 950 } });
  const tok = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const as = async who => { await ctx.clearCookies(); await ctx.addCookies([{ name: 'token', value: tok[who], domain: '127.0.0.1', path: '/' }]); };
  await as('clerk');
  await page.goto('http://127.0.0.1:4557/diary.html'); await page.waitForSelector('.dy-views'); await page.waitForTimeout(800);
  if (dark) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  ok(await page.locator('#addBtn').isVisible() && await page.locator('#ppBtn').isVisible(), 'the Clerk sees + Add and Preaching plan');
  const conf = await page.locator('.dy-confirm').innerText().catch(() => '');
  ok(/Put these on the diary\? \(2\)/.test(conf) && /Opanyin Kofi Mensah/.test(conf) && /One-week observance — the late Madam Ama Owusu/.test(conf), 'two found dates wait to be confirmed (a letter, a family’s announcement)');
  await page.click('[data-view="month"]'); await page.waitForTimeout(200);
  const chips = await page.locator('.dy-chip').allInnerTexts();
  console.log('   chips:', chips.slice(0, 8).join(' | '));
  ok(chips.some(c => /Harvest launch/.test(c)) && chips.some(c => /Church Choir/.test(c)), 'the month shows the programme and the meeting');
  await page.screenshot({ path: `shots/diary-${W}${dark ? '-dark' : ''}.png`, fullPage: true });
  // accept the letter
  await page.locator('.dy-sug', { hasText: 'Opanyin Kofi Mensah' }).getByRole('button', { name: 'Put on the diary' }).click();
  await page.waitForSelector('#fKind');
  ok(await page.inputValue('#fKind') === 'funeral' && await page.inputValue('#fDate') === day(10), 'the form opens filled in (Funeral, the date from the letter)');
  await page.fill('#fTime', '9am'); await page.locator('#fTime').blur(); await page.fill('#fVenue', 'the AOTC Chapel');
  ok(await page.inputValue('#fTime') === '9:00 am', 'time put in the minutes’ style');
  await page.click('#fSave'); await page.waitForTimeout(900);
  ok(/\(1\)/.test(await page.locator('.dy-confirm').innerText().catch(() => '')), 'one left to confirm');
  await page.locator('.dy-sug').getByRole('button', { name: 'Not for the diary' }).click(); await page.waitForTimeout(600);
  ok(await page.locator('.dy-confirm').count() === 0, 'declining clears the box');
  // list view
  await page.click('[data-view="list"]'); await page.waitForTimeout(200);
  const list = await page.locator('#view').innerText();
  ok(/Funeral of the late Opanyin Kofi Mensah/.test(list) || day(10).slice(5, 7) !== day(0).slice(5, 7), 'list view shows the new funeral (when it falls this month)');
  // details
  await page.locator('.dy-item', { hasText: 'Harvest launch' }).first().click(); await page.waitForTimeout(200);
  ok(/Venue[\s\S]*the AOTC Chapel/.test(await page.locator('#itemBody').innerText()) && await page.locator('[data-edit]').isVisible(), 'an entry opens with its details and Change');
  await page.click('[data-close]');
  // filters
  await page.click('[data-kind="programme"]'); await page.waitForTimeout(200);
  ok(!(await page.locator('#view').innerText()).includes('Harvest launch'), 'a kind can be hidden');
  await page.click('[data-kind="programme"]');
  // preaching modal opens
  await page.click('#ppBtn'); ok(await page.locator('#ppOverlay').isVisible() && await page.locator('#ppFile').isVisible(), 'the preaching plan upload opens'); await page.click('#ppCancel');
  // a secretary
  await as('sec'); await page.goto('http://127.0.0.1:4557/diary.html'); await page.waitForSelector('.dy-views'); await page.waitForTimeout(800);
  ok(!(await page.locator('#addBtn').isVisible()) && await page.locator('.dy-confirm').count() === 0, 'a secretary sees the diary but no Add and no suggestions');
  ok((await page.locator('#view').innerText()).length > 20, '…and sees what is on');
  // Home
  await as('clerk'); await page.goto('http://127.0.0.1:4557/index.html'); await page.waitForTimeout(2500);
  const home = await page.locator('#hmEvents').innerText().catch(() => '');
  console.log('   home:', home.replace(/\n/g, ' / ').slice(0, 300));
  ok(/Harvest launch/.test(home), 'Home’s Coming up includes the Church Diary');
  ok(await page.locator('a.lnk[href="/diary.html"]').count() === 1, 'Coming up links to the Church Diary');
  ok(errors.length === 0, 'no page errors ' + errors.join('; '));
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
