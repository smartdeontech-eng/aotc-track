// The SQLite datastore (Oct 2026): the JSON files are read in exactly, the old
// contract still holds, two processes no longer lose records, and the way back
// (export) gives the same records. Throwaway folders under $HOME only.
const path = require('path'), fs = require('fs'), os = require('os'), { execFileSync, spawn } = require('child_process');
const root = path.join(__dirname, '..');
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
const base = fs.mkdtempSync(path.join(os.homedir(), 'sqlite-test-'));
const D = path.join(base, 'data'); fs.mkdirSync(D);
const W = (c, v) => fs.writeFileSync(path.join(D, c + '.json'), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
W('users', [{ id: 3, name: 'C' }, { id: 1, name: 'A' }, { id: 2, name: 'B' }]);
W('groups', [{ id: 1, name: 'Choir' }, { id: 1, name: 'Copy' }, { name: 'No id' }]);
W('empty', '');
fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify({ churchName: 'AOTC' }));
const run = (code, env = {}) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, AOTC_DATA_DIR: D, ...env }, encoding: 'utf8', stdio: 'pipe' });

(async () => {
  try {
    head('Look first (scripts/sqlite-import.js) changes nothing');
    const look = execFileSync(process.execPath, [path.join(root, 'scripts/sqlite-import.js'), D], { encoding: 'utf8' });
    ok(/users\s+3/.test(look) && /groups\s+3/.test(look) && /repeated id/.test(look) && /no id/.test(look) && /ready/.test(look), 'counts and the two id problems are reported');
    ok(!fs.existsSync(path.join(D, 'aotc.db')) && fs.existsSync(path.join(D, 'users.json')), 'no database made, no file moved');

    head('First open reads the JSON in');
    process.env.AOTC_DATA_DIR = D;
    const db = require(path.join(root, 'utils/db'));
    ok(!fs.existsSync(path.join(D, 'aotc.db')), 'requiring the store opens nothing (it opens on first use)');
    db.open();
    ok(fs.existsSync(path.join(D, 'aotc.db')), 'data/aotc.db created');
    ok(!fs.existsSync(path.join(D, 'users.json')) && fs.existsSync(path.join(D, 'json-before-sqlite', 'users.json')), 'users.json moved to json-before-sqlite/');
    ok(fs.existsSync(path.join(D, 'settings.json')), 'settings.json left where it is');
    ok(db.findAll('users').map(u => u.name).join('') === 'CAB', 'records keep their order (insertion order, as the JSON store)');
    ok(db.findById('users', 2).name === 'B', 'ids kept');
    const g = db.findAll('groups');
    ok(g.length === 3 && g[0].id === 1 && g[0].name === 'Choir' && g[1].id === 2 && g[2].id === 3, `a repeated id and a missing id get the next free ids (${g.map(x => x.id + ':' + x.name).join(', ')})`);
    ok(db.findAll('empty').length === 0, 'an empty file is an empty collection');

    head('The contract');
    const r = db.insert('users', { name: 'D' });
    ok(r.id === 4 && r.createdAt, 'insert: next id, createdAt');
    ok(db.update('users', 4, { role: 'x' }).role === 'x' && db.findById('users', 4).updatedAt, 'update merges and stamps updatedAt');
    ok(db.update('users', 99, { a: 1 }) === null, 'update of a missing record is null');
    db.mutate('users', 4, u => ({ ...u, tags: [...(u.tags || []), 't'] }));
    ok(db.findById('users', 4).tags.join() === 't', 'mutate');
    ok(db.mutate('users', 4, () => null).name === 'D', 'mutate returning nothing leaves it');
    ok(db.findOne('users', u => u.name === 'A').id === 1 && db.findOne('users', () => false) === null, 'findOne');
    ok(db.remove('users', 4) === true && db.remove('users', 4) === false && !db.findById('users', 4), 'remove');
    ok(db.findById('users', '2').name === 'B', 'findById takes a string id, as before');
    ok(db.findAll('nothing_yet').length === 0 && db.insert('nothing_yet', { a: 1 }).id === 1, 'a new collection starts at id 1');
    W('late', [{ id: 7, x: 1 }]);
    ok(db.findById('late', 7).x === 1, 'a JSON file for a collection with no rows is read on first use');

    head('Two processes at once (the IFAIMA measurement: JSON kept 163 of 300)');
    const code = `const db=require(${JSON.stringify(path.join(root, 'utils/db'))}); for(let i=0;i<150;i++) db.insert('race',{p:process.pid,i});`;
    await Promise.all([0, 1].map(() => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['-e', code], { env: { ...process.env, AOTC_DATA_DIR: D } });
      let err = ''; c.stderr.on('data', d => { err += d; });
      c.on('exit', x => (x ? rej(new Error(err)) : res()));
    })));
    const race = db.findAll('race');
    ok(race.length === 300 && new Set(race.map(x => x.id)).size === 300, `300 inserts from two processes: ${race.length} kept, ${new Set(race.map(x => x.id)).size} distinct ids`);
    const counter = db.insert('counter', { n: 0 });
    const code2 = `const db=require(${JSON.stringify(path.join(root, 'utils/db'))}); for(let i=0;i<100;i++) db.mutate('counter',${counter.id},c=>({...c,n:c.n+1}));`;
    await Promise.all([0, 1].map(() => new Promise(res => spawn(process.execPath, ['-e', code2], { env: { ...process.env, AOTC_DATA_DIR: D } }).on('exit', res))));
    ok(db.findById('counter', counter.id).n === 200, `200 mutate() calls from two processes: counter = ${db.findById('counter', counter.id).n}`);

    head('Snapshot and the way back');
    const snap = db.snapshot(path.join(base, 'snap', 'aotc.db'));
    ok(fs.statSync(snap).size > 0, 'snapshot written while the store is open');
    const viaSnap = run(`process.env.DB_PATH=${JSON.stringify(snap)}; const db=require(${JSON.stringify(path.join(root, 'utils/db'))}); console.log(db.findAll('race').length)`, { AOTC_DATA_DIR: path.join(base, 'snap') });
    ok(viaSnap.trim() === '300', 'the snapshot opens and holds the records');
    const out = path.join(base, 'export');
    execFileSync(process.execPath, [path.join(root, 'scripts/sqlite-export.js'), out], { env: { ...process.env, AOTC_DATA_DIR: D }, encoding: 'utf8' });
    const users = JSON.parse(fs.readFileSync(path.join(out, 'users.json'), 'utf8'));
    ok(users.map(u => u.name).join('') === 'CAB', 'export writes the JSON store format, in order');
    const back = run(`const db=require(${JSON.stringify(path.join(root, 'utils/db'))}); console.log(JSON.stringify(db.findAll('users').map(u=>u.id+u.name)))`, { AOTC_DATA_DIR: out });
    ok(back.trim() === JSON.stringify(['3C', '1A', '2B']), 'export read back in gives the same records');

    head('On a laptop the project\'s own data/ is never opened by accident');
    let guard = '';
    try { execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'utils/db'))}).findAll('users')`], { env: { ...process.env, AOTC_DATA_DIR: '', DB_PATH: '', NODE_ENV: '' }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { guard = String(e.stderr); }
    ok(/Not opening .*only opened from a throwaway copy/.test(guard), 'without AOTC_DATA_DIR / DB_PATH / AOTC_LOCAL_DB it refuses, saying why');
    ok(!fs.existsSync(path.join(root, 'data', 'aotc.db')), 'and data/aotc.db was not created');

    head('A JSON file that cannot be read stops the start, and is left alone');
    const bad = path.join(base, 'bad'); fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'users.json'), '[{"id":1,');
    let threw = '';
    try { run(`require(${JSON.stringify(path.join(root, 'utils/db'))}).open()`, { AOTC_DATA_DIR: bad }); } catch (e) { threw = String(e.stderr || e.message); }
    ok(/could not be read into the database/.test(threw), 'refuses to start, saying which file');
    ok(fs.existsSync(path.join(bad, 'users.json')), 'the file stays where it was');
    let lookBad = 0; try { execFileSync(process.execPath, [path.join(root, 'scripts/sqlite-import.js'), bad]); } catch (e) { lookBad = e.status; }
    ok(lookBad === 1, 'the look-first script says so too (exit 1)');
  } catch (e) { console.error(e); fail++; }
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\n${n - fail}/${n} checks${fail ? '' : ' — all green'}`);
  process.exit(fail ? 1 : 0);
})();
