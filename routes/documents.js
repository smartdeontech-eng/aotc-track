// AOTC Track — Document Library (SharePoint-style).
// Central store for congregation documents (minutes, TORs, reports, finance
// papers) with per-document access control:
//   none < view < download < manage
// Resolution order for a user's effective level on a document:
//   1. Admin tier (admin / localadmin)            → manage (always)
//   2. The uploader, on their own document        → manage
//   3. Explicit per-USER override on the document → that level
//   4. Per-ROLE override on the document          → that level
//   5. The document's "everyone" default          → that level (default: view)
// Uploading requires the docs.upload permission (or admin tier). Setting who
// can see a document is ADMIN-TIER ONLY — uploaders manage their own files'
// content (edit/replace/delete) but not their permissions.
// Files live OUTSIDE public/ and are streamed through authenticated routes,
// same as marriage-files. "View only" is honoured by only serving inline-
// viewable types (PDF, images, plain text) through the view route; formats
// that a browser can only save to disk (docx, xlsx…) require download level.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth, ROLES } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const push = require('../utils/push');

const FILES_DIR = path.join(__dirname, '..', 'document-files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// ---- Levels ----
const LEVELS = ['none', 'view', 'download', 'manage'];
const rank = l => LEVELS.indexOf(l); // -1 for unknown → treated as none
const validLevel = l => ['none', 'view', 'download'].includes(l);

// ---- File types ----
const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
// Types ShareHub can display INSIDE the app — the only ones served at "view"
// level. PDFs/images/text render natively; Word and Excel are rendered by the
// vendored mammoth / SheetJS viewers. PowerPoint has no reliable in-browser
// renderer, so it stays download-only.
const INLINE_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('File type not accepted. Allowed: PDF, Word, Excel, PowerPoint, images, TXT, CSV.'));
  },
});

// ---- Helpers ----
const { actor } = require('../utils/scope');
function isElevated(req) {
  return ['admin', 'localadmin'].includes(req.user.role);
}
function canUpload(req) {
  if (isElevated(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('docs.upload');
}
function effectiveLevel(req, doc) {
  if (isElevated(req)) return 'manage';
  if (doc.uploadedBy && doc.uploadedBy.userId === req.user.id && canUpload(req)) return 'manage';
  const acc = doc.access || {};
  const userOverride = (acc.users || {})[String(req.user.id)];
  if (validLevel(userOverride)) return userOverride;
  const roleOverride = (acc.roles || {})[req.user.role];
  if (validLevel(roleOverride)) return roleOverride;
  return validLevel(acc.everyone) ? acc.everyone : 'view';
}
// Same resolution as effectiveLevel, but from a stored user record — used to
// work out who should be NOTIFIED about a document (no request involved).
function levelForUserRecord(u, doc) {
  if (['admin', 'localadmin'].includes(u.role)) return 'manage';
  if (doc.uploadedBy && doc.uploadedBy.userId === u.id && (u.permissions || []).includes('docs.upload')) return 'manage';
  const acc = doc.access || {};
  const userOverride = (acc.users || {})[String(u.id)];
  if (validLevel(userOverride)) return userOverride;
  const roleOverride = (acc.roles || {})[u.role];
  if (validLevel(roleOverride)) return roleOverride;
  return validLevel(acc.everyone) ? acc.everyone : 'view';
}

// Inbox + device push to everyone who can at least VIEW the document
// (except the uploader themselves). Never blocks the upload.
function notifyDocumentShared(rec, who) {
  try {
    const ids = activeUsers(u => u.id !== who.userId && rank(levelForUserRecord(u, rec)) >= rank('view'))
      .map(u => u.id);
    push.sendPushToUsers(ids, {
      title: 'New document in ShareHub',
      body: `${who.userName} uploaded “${rec.title}” to ${rec.category}.`,
      url: '/documents.html',
    }).catch(() => {});
  } catch (e) { console.error('[documents] notify failed (non-fatal):', e.message); }
}

function normaliseAccess(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const access = { everyone: validLevel(raw.everyone) ? raw.everyone : 'view', roles: {}, users: {} };
  for (const [role, lvl] of Object.entries(raw.roles || {})) {
    if (ROLES.includes(role) && validLevel(lvl)) access.roles[role] = lvl;
  }
  for (const [uid, lvl] of Object.entries(raw.users || {})) {
    if (db.findById('users', uid) && validLevel(lvl)) access.users[String(Number(uid))] = lvl;
  }
  return access;
}
function summarise(doc, myLevel) {
  return {
    id: doc.id, title: doc.title, description: doc.description || '',
    category: doc.category || 'General',
    originalName: doc.originalName, mimetype: doc.mimetype, size: doc.size,
    inlineViewable: INLINE_TYPES.includes(doc.mimetype),
    uploadedBy: doc.uploadedBy, createdAt: doc.createdAt, updatedAt: doc.updatedAt || doc.createdAt,
    myLevel,
    // Full access map only for those who can manage it (the permissions editor).
    ...(myLevel === 'manage' ? { access: doc.access } : {}),
  };
}
const s = (x, max = 300) => String(x === null || x === undefined ? '' : x).trim().slice(0, max);

// ---- Categories ----
// 'Building Project' holds project papers — contracts, certificates, permits,
// drawings, valuations. Categories are editable in the UI (admin tier).
const DEFAULT_CATEGORIES = ['Session Minutes', 'Committee TORs', 'Quarterly Reports', 'Finance', 'Building Project', 'General'];
function ensureCategories() {
  const cats = db.readAll('document_categories');
  if (cats.length) return cats;
  DEFAULT_CATEGORIES.forEach(name => db.insert('document_categories', { name }));
  return db.readAll('document_categories');
}

router.get('/categories', requireAuth, (req, res) => {
  res.json(ensureCategories());
});

router.post('/categories', requireAuth, (req, res) => {
  if (!isElevated(req)) return res.status(403).json({ error: 'Only administrators can manage categories.' });
  const name = s(req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  if (db.findOne('document_categories', c => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'That category already exists.' });
  }
  res.json(db.insert('document_categories', { name }));
});

// Rename a category. Documents store the category BY NAME, so every document
// filed under the old name is moved to the new one in the same operation —
// otherwise a rename would orphan them.
router.put('/categories/:id', requireAuth, (req, res) => {
  if (!isElevated(req)) return res.status(403).json({ error: 'Only administrators can manage categories.' });
  const cat = db.findById('document_categories', req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  const name = s(req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  if (db.findOne('document_categories', c => c.id !== cat.id && c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'Another category already uses that name.' });
  }
  const docs = db.findAll('documents', d => d.category === cat.name);
  docs.forEach(d => db.update('documents', d.id, { category: name }));
  const updated = db.update('document_categories', cat.id, { name });
  res.json({ ...updated, movedDocuments: docs.length });
});

router.delete('/categories/:id', requireAuth, (req, res) => {
  if (!isElevated(req)) return res.status(403).json({ error: 'Only administrators can manage categories.' });
  const cat = db.findById('document_categories', req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  if (db.findOne('documents', d => d.category === cat.name)) {
    return res.status(400).json({ error: 'Category is in use — move or delete its documents first.' });
  }
  db.remove('document_categories', cat.id);
  res.json({ ok: true });
});

// ---- List (only what I'm allowed to see) ----
router.get('/', requireAuth, (req, res) => {
  const out = [];
  for (const doc of db.readAll('documents')) {
    const lvl = effectiveLevel(req, doc);
    if (rank(lvl) >= rank('view')) out.push(summarise(doc, lvl));
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json({ documents: out, canUpload: canUpload(req), isAdmin: isElevated(req) });
});

// ---- Upload ----
router.post('/', requireAuth, (req, res) => {
  if (!canUpload(req)) return res.status(403).json({ error: 'You have not been given permission to upload documents. Ask an admin for access.' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Attach a file to upload.' });
    const title = s(req.body.title, 160) || s(req.file.originalname, 160);
    const category = s(req.body.category, 60) || 'General';
    if (!db.findOne('document_categories', c => c.name === category)) ensureCategories();
    // Only admins may set access at upload time; uploaders get the default.
    let access = { everyone: 'view', roles: {}, users: {} };
    if (isElevated(req) && req.body.access) {
      try { access = normaliseAccess(JSON.parse(req.body.access)); } catch (e) { /* keep default */ }
    }
    const ext = ALLOWED_TYPES[req.file.mimetype];
    const filename = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFileSync(path.join(FILES_DIR, filename), req.file.buffer);
    const who = actor(req);
    const rec = db.insert('documents', {
      title, category, description: s(req.body.description, 600),
      filename, originalName: s(req.file.originalname, 200), mimetype: req.file.mimetype, size: req.file.size,
      uploadedBy: who, access,
    });
    logActivity({ ...who, action: 'Uploaded document', entityType: 'document', entityId: rec.id, entityLabel: title, detail: `${category} · ${(req.file.size / 1024).toFixed(0)} KB` });
    notifyDocumentShared(rec, who);
    res.json(summarise(rec, 'manage'));
  });
});

// ---- Metadata edit (manage level: owner or admin) ----
router.put('/:id', requireAuth, (req, res) => {
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (effectiveLevel(req, doc) !== 'manage') return res.status(403).json({ error: 'You cannot edit this document.' });
  const patch = {};
  if (req.body.title !== undefined) patch.title = s(req.body.title, 160) || doc.title;
  if (req.body.description !== undefined) patch.description = s(req.body.description, 600);
  if (req.body.category !== undefined) patch.category = s(req.body.category, 60) || doc.category;
  const updated = db.update('documents', doc.id, patch);
  const who = actor(req);
  logActivity({ ...who, action: 'Edited document details', entityType: 'document', entityId: doc.id, entityLabel: updated.title });
  res.json(summarise(updated, effectiveLevel(req, updated)));
});

// ---- Permissions (ADMIN TIER ONLY) ----
router.put('/:id/access', requireAuth, (req, res) => {
  if (!isElevated(req)) return res.status(403).json({ error: 'Only administrators can change who has access to a document.' });
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const access = normaliseAccess(req.body.access);
  const updated = db.update('documents', doc.id, { access });
  const who = actor(req);
  const overrides = Object.keys(access.roles).length + Object.keys(access.users).length;
  logActivity({ ...who, action: 'Changed document access', entityType: 'document', entityId: doc.id, entityLabel: doc.title, detail: `everyone: ${access.everyone}${overrides ? ` + ${overrides} override(s)` : ''}` });
  res.json(summarise(updated, 'manage'));
});

// ---- Replace file (manage level) ----
router.post('/:id/file', requireAuth, (req, res) => {
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (effectiveLevel(req, doc) !== 'manage') return res.status(403).json({ error: 'You cannot replace this document.' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Attach the replacement file.' });
    const ext = ALLOWED_TYPES[req.file.mimetype];
    const filename = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFileSync(path.join(FILES_DIR, filename), req.file.buffer);
    const old = path.join(FILES_DIR, path.basename(doc.filename || ''));
    if (doc.filename && fs.existsSync(old)) { try { fs.unlinkSync(old); } catch (e) { /* non-fatal */ } }
    const updated = db.update('documents', doc.id, {
      filename, originalName: s(req.file.originalname, 200), mimetype: req.file.mimetype, size: req.file.size,
    });
    const who = actor(req);
    logActivity({ ...who, action: 'Replaced document file', entityType: 'document', entityId: doc.id, entityLabel: doc.title });
    res.json(summarise(updated, effectiveLevel(req, updated)));
  });
});

// ---- Serve: view (inline) & download (attachment) ----
function streamFile(res, doc, disposition) {
  const fp = path.join(FILES_DIR, path.basename(doc.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Stored file is missing on the server.' });
  const safeName = (doc.originalName || 'document').replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', doc.mimetype);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  fs.createReadStream(fp).pipe(res);
}

router.get('/:id/file', requireAuth, async (req, res) => {
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const lvl = effectiveLevel(req, doc);
  if (rank(lvl) < rank('view')) return res.status(403).json({ error: 'You do not have access to this document.' });
  // "View only" can only be honoured for types a browser renders in-tab.
  if (!INLINE_TYPES.includes(doc.mimetype) && rank(lvl) < rank('download')) {
    return res.status(403).json({ error: 'This file type cannot be previewed — downloading it requires download access.' });
  }
  // View-only PDFs are stamped with the viewer's name + date before leaving
  // the server, so screenshots/saved copies are traceable. Download-level
  // users see the clean file.
  if (doc.mimetype === 'application/pdf' && lvl === 'view') {
    const fp = path.join(FILES_DIR, path.basename(doc.filename));
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Stored file is missing on the server.' });
    const who = actor(req);
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const { stampPdf } = require('../utils/docWatermark');
    const stamped = await stampPdf(fs.readFileSync(fp), `Viewed by ${who.userName} · ${date}`);
    if (stamped) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="view-only.pdf"');
      return res.send(stamped);
    }
    // Stamping failed (rare: encrypted/malformed PDF) — serve the original
    // rather than blocking a legitimate reader.
  }
  streamFile(res, doc, 'inline');
});

router.get('/:id/download', requireAuth, (req, res) => {
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (rank(effectiveLevel(req, doc)) < rank('download')) {
    return res.status(403).json({ error: 'You have view-only access to this document.' });
  }
  const who = actor(req);
  logActivity({ ...who, action: 'Downloaded document', entityType: 'document', entityId: doc.id, entityLabel: doc.title });
  streamFile(res, doc, 'attachment');
});

// ---- Delete (manage level) ----
router.delete('/:id', requireAuth, (req, res) => {
  const doc = db.findById('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (effectiveLevel(req, doc) !== 'manage') return res.status(403).json({ error: 'You cannot delete this document.' });
  const fp = path.join(FILES_DIR, path.basename(doc.filename || ''));
  if (doc.filename && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) { /* non-fatal */ } }
  db.remove('documents', doc.id);
  const who = actor(req);
  logActivity({ ...who, action: 'Deleted document', entityType: 'document', entityId: doc.id, entityLabel: doc.title, snapshot: doc });
  res.json({ ok: true });
});

module.exports = router;
