const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the datastore at a throwaway directory BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-db-'));
process.env.AOTC_DATA_DIR = TMP;
const db = require('../utils/db');

test('insert assigns id + createdAt and is retrievable', () => {
  const r = db.insert('widgets', { name: 'A' });
  assert.strictEqual(r.id, 1);
  assert.ok(r.createdAt);
  assert.strictEqual(db.findById('widgets', 1).name, 'A');
});

test('ids increment per collection', () => {
  const a = db.insert('things', { n: 1 });
  const b = db.insert('things', { n: 2 });
  assert.strictEqual(b.id, a.id + 1);
});

test('update merges patch and preserves other fields', () => {
  const r = db.insert('users', { name: 'Ann', role: 'clerk' });
  const u = db.update('users', r.id, { role: 'admin' });
  assert.strictEqual(u.name, 'Ann');
  assert.strictEqual(u.role, 'admin');
  assert.ok(u.updatedAt);
});

test('mutate does atomic read-modify-write (array append)', () => {
  const r = db.insert('cases', { sessions: [] });
  db.mutate('cases', r.id, c => { c.sessions.push('s1'); return c; });
  db.mutate('cases', r.id, c => { c.sessions.push('s2'); return c; });
  assert.deepStrictEqual(db.findById('cases', r.id).sessions, ['s1', 's2']);
});

test('mutate returns null for missing record and can no-op', () => {
  assert.strictEqual(db.mutate('cases', 9999, c => c), null);
  const r = db.insert('cases', { v: 1 });
  const same = db.mutate('cases', r.id, () => null);
  assert.strictEqual(same.v, 1);
});

test('remove deletes the record', () => {
  const r = db.insert('temp', { x: 1 });
  assert.strictEqual(db.remove('temp', r.id), true);
  assert.strictEqual(db.findById('temp', r.id), null);
});

test('corrupt file is quarantined and read as empty', () => {
  fs.writeFileSync(path.join(TMP, 'broken.json'), '{ not json');
  assert.deepStrictEqual(db.findAll('broken'), []);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
