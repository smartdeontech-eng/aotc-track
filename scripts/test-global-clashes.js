// Every page loads app.js and then its own page script as two classic
// <script> tags. Classic scripts SHARE ONE GLOBAL SCOPE, so a `const money`
// in a page script and a `function money` in app.js are a redeclaration:
// the browser throws SyntaxError and the ENTIRE page script never runs.
//
// That failure is silent and brutal - no handler fires, no error card, the
// page just sits there with its static shell. It is exactly what happened to
// the Weekly Finance page, and it slipped through a jsdom test that stubbed
// app.js instead of loading it.
//
// This loads each pair into one context the way the browser does. app.js
// itself dies early here for want of a real DOM, which is fine: lexical
// bindings are instantiated when a script starts, so a clash is still caught.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const appSrc = fs.readFileSync(path.join(pub, 'js/app.js'), 'utf8');

const pages = fs.readdirSync(pub).filter(f => f.endsWith('.html'));
let bad = 0, checked = 0;

for (const page of pages) {
  const html = fs.readFileSync(path.join(pub, page), 'utf8');
  const scripts = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map(m => m[1])
    .filter(f => f !== 'app.js' && f !== 'theme-init.js');
  if (!scripts.length) continue;
  for (const s of scripts) {
    const file = path.join(pub, 'js', s);
    if (!fs.existsSync(file)) { console.log(`  MISSING  ${page} -> /js/${s}`); bad++; continue; }
    checked++;
    const ctx = { console: { log(){}, warn(){}, error(){} }, window: {}, document: {}, location: { search: '' },
      navigator: {}, setTimeout, setInterval, clearTimeout, fetch: () => {}, localStorage: {}, CSS: {} };
    vm.createContext(ctx);
    try { vm.runInContext(appSrc, ctx, { filename: 'app.js' }); } catch (e) { /* no DOM; bindings are made */ }
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: s });
    } catch (e) {
      // NOT `e instanceof SyntaxError`: the error comes from the vm's own
      // realm, so it is not an instance of the host's SyntaxError and the
      // check silently passes everything. Compare the name instead.
      if (e && e.name === 'SyntaxError') {
        console.log(`  CLASH    ${page.padEnd(26)} /js/${s}`);
        console.log(`           ${e.message}`);
        bad++;
      }
      // any other runtime error is expected - there is no real DOM here
    }
  }
}
console.log(`\n${checked} page scripts checked against app.js - ${bad ? bad + ' BROKEN' : 'no global clashes'}`);
process.exit(bad ? 1 : 0);
