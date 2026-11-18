const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright'); const fs = require('fs');
let n = 0, fail = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
(async () => {
  const W = +(process.env.W || 1280), dark = process.env.DARK === '1';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: W, height: 1000 } });
  await ctx.addCookies([{ name: 'token', value: fs.readFileSync('token.txt', 'utf8').trim(), domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4556/minutes.html'); await page.waitForFunction(() => typeof openDoc === 'function'); await page.waitForTimeout(600);
  await page.evaluate(() => openDoc(1)); await page.waitForTimeout(900);
  if (dark) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  const where = await page.evaluate(() => Object.fromEntries(['pCommenced', 'addVisitorsBtn', 'pConstitutedBy', 'reviewList', 'carryList', 'addPrayerBtn', 'pCloseMoved', 'pRecordedBy'].map(id => { const e = document.getElementById(id); const s = e && e.closest('[data-mi]'); return [id, s ? s.dataset.mi : (e && e.closest('#mParking') ? 'PARKED' : 'none')]; })));
  console.log('  ', JSON.stringify(where));
  ok(where.pCommenced === 'devotion:-1' && where.addVisitorsBtn === 'presentation:-1' && where.pConstitutedBy === 'constitution:-1' && where.reviewList === 'review:-1' && where.carryList === 'matters:-1' && where.addPrayerBtn === 'prayers:-1' && where.pCloseMoved === 'closure:-1' && where.pRecordedBy === 'closure:-1', 'each pick group sits in its own section block');
  const jump = await page.locator('#secJump .sec-jump-btn').allInnerTexts();
  console.log('   jump:', jump.join(' | '));
  ok(jump.length >= 8 && /Opening/.test(jump[0]), 'section bar lists the sections in order');
  // typing in a pick field, then Tab: the cursor goes on to the next field
  await page.fill('#pCommenced', '6:32 pm'); await page.press('#pCommenced', 'Tab'); await page.waitForTimeout(500);
  const f = await page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : ''; });
  ok(/nowBtn|pDevotionBy/.test(f), `Tab after a pick field moves on to the next field (${f})`);
  await page.fill('#pDevotionBy', 'Mrs Cecilia Pokua Anto'); await page.press('#pDevotionBy', 'Tab'); await page.waitForTimeout(500);
  const f2 = await page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : ''; });
  ok(f2 && f2 !== 'BODY', `…and again from the next one (${f2})`);
  await page.locator('.sec-jump-btn', { hasText: 'Closure' }).click(); await page.waitForTimeout(800);
  ok(await page.locator('#pCloseMoved').evaluate(e => { const r = e.getBoundingClientRect(); return r.top > 0 && r.top < innerHeight; }), 'the bar jumps to Closure');
  if (dark) {
    const bg = await page.locator('#grpPrayers .prayer-card').evaluate(e => getComputedStyle(e).backgroundColor);
    const pv = await page.locator('#closurePreview').evaluate(e => getComputedStyle(e).backgroundColor);
    console.log('   dark prayer bg', bg, 'preview bg', pv);
    ok(!/255, 255, 255|251, 252, 255|246, 248, 252/.test(bg + pv), 'night mode: prayers and closure preview are dark');
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#pane-body').screenshot({ path: `shots/layout-${W}${dark ? '-dark' : ''}.png` });
  ok(errors.length === 0, 'no page errors ' + errors.join('; '));
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
