#!/usr/bin/env node
// Before every deploy: the version in package.json must be the newest entry in
// changes.json, so the About page and the update bar tell the truth. Bump both
// for each release (a new number every time, even for a small fix).
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
let changes = [];
try { changes = require(path.join(root, 'changes.json')); } catch (e) { console.error('changes.json is missing or not valid JSON.'); process.exit(1); }
const top = Array.isArray(changes) && changes[0];
if (!top || top[0] !== pkg.version) {
  console.error(`Version mismatch: package.json says ${pkg.version}, changes.json starts with ${top ? top[0] : 'nothing'}. Add a line for ${pkg.version} at the top of changes.json.`);
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(pkg.released || '')) { console.error('package.json needs "released": "YYYY-MM-DD".'); process.exit(1); }
console.log(`version ${pkg.version} (${pkg.released}): package.json and changes.json agree`);
