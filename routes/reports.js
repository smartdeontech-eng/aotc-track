// AOTC Track — Report generation (Phase 4).
// One click -> quarterly report as Word (.docx), in the existing formats.
// Every generated file is archived under generated/ with an audit record.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { assemble } = require('../utils/reportData');
const { buildReport } = require('../utils/reportDocx');
const { buildPdfReport, buildCongregationPdf, buildConferencePdf } = require('../utils/reportPdf');
const { buildCongregationDocx } = require('../utils/reportDocx');
const { assembleCongregation } = require('../utils/congregationData');
const { assembleConference } = require('../utils/conferenceData');
const { fillDistrictExcel } = require('../utils/districtExcel');

function isClerkOrAdmin(req, dbRef) {
  if (['admin','localadmin'].includes(req.user.role)) return true;
  const u = dbRef.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('approvals.manage');
}

const GENERATED_DIR = path.join(__dirname, '..', 'generated');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

const { actor, userEntity, isAdmin, canViewAll } = require('../utils/scope');
function resolveEntity(req) {
  if (canViewAll(req)) {
    const type = req.query.entityType, id = req.query.entityId;
    if (type && id !== undefined) return { type, id: Number(id) };
  }
  const ent = userEntity(req);
  return ent && ent.type !== 'congregation' ? { type: ent.type, id: Number(ent.id) } : null;
}

// JSON data for print view / preview
router.get('/data', requireAuth, (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  const data = assemble({ year, quarter, entityType: ent.type, entityId: ent.id });
  if (!data) return res.status(404).json({ error: 'Entity not found.' });
  res.json(data);
});

// Generate + download the Word report (archived with version number)
router.get('/docx', requireAuth, requirePermission('reports.generate'), async (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  const data = assemble({ year, quarter, entityType: ent.type, entityId: ent.id });
  if (!data) return res.status(404).json({ error: 'Entity not found.' });

  const buf = await buildReport(data, 'quarterly');
  const priors = db.findAll('generated_reports', r => r.year === year && r.quarter === quarter && r.entityType === ent.type && Number(r.entityId) === Number(ent.id));
  const version = priors.length + 1;
  const safeName = data.entity.name.replace(/[^A-Za-z0-9]+/g, '_');
  const filename = `${safeName}_Q${quarter}_${year}_Report_v${version}.docx`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buf);
  const rec = db.insert('generated_reports', {
    year, quarter, entityType: ent.type, entityId: Number(ent.id),
    entityName: data.entity.name, filename, version,
    generatedBy: actor(req).userName, generatedAt: new Date().toISOString(),
    submittedAtGeneration: !!data.submission,
  });
  logActivity({ ...actor(req), action: `Generated Q${quarter} ${year} report (v${version})`, entityType: 'report', entityId: rec.id, entityLabel: data.entity.name });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});


// Generate the PDF report — served INLINE so it opens in the browser's
// PDF viewer (framed page view), same as the mainframe's invoice PDFs.
router.get('/pdf', requireAuth, requirePermission('reports.generate'), async (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  const data = assemble({ year, quarter, entityType: ent.type, entityId: ent.id });
  if (!data) return res.status(404).json({ error: 'Entity not found.' });

  const buf = await buildPdfReport(data);
  const priors = db.findAll('generated_reports', r => r.year === year && r.quarter === quarter && r.entityType === ent.type && Number(r.entityId) === Number(ent.id));
  const version = priors.length + 1;
  const safeName = data.entity.name.replace(/[^A-Za-z0-9]+/g, '_');
  const filename = `${safeName}_Q${quarter}_${year}_Report_v${version}.pdf`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buf);
  const rec = db.insert('generated_reports', {
    year, quarter, entityType: ent.type, entityId: Number(ent.id),
    entityName: data.entity.name, filename, version, format: 'pdf',
    generatedBy: actor(req).userName, generatedAt: new Date().toISOString(),
    submittedAtGeneration: !!data.submission,
  });
  logActivity({ ...actor(req), action: `Generated Q${quarter} ${year} PDF report (v${version})`, entityType: 'report', entityId: rec.id, entityLabel: data.entity.name });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buf);
});


// ---- Congregational consolidated report + District Excel (Session Clerk/admin) ----
function archiveCongregation(req, res, buf, ext, label, year, quarter) {
  const priors = db.findAll('generated_reports', r => r.year === year && r.quarter === quarter && r.entityType === 'congregation');
  const version = priors.filter(r => r.filename.endsWith(ext)).length + 1;
  const filename = `AOT_Congregation_Q${quarter}_${year}_${label}_v${version}${ext}`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buf);
  const rec = db.insert('generated_reports', {
    year, quarter, entityType: 'congregation', entityId: 0,
    entityName: 'AOT Congregation', filename, version,
    generatedBy: actor(req).userName, generatedAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: `Generated congregational Q${quarter} ${year} ${label}`, entityType: 'report', entityId: rec.id, entityLabel: 'AOT Congregation' });
  return filename;
}

router.get('/congregation/pdf', requireAuth, async (req, res) => {
  if (!isClerkOrAdmin(req, db)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can generate the congregational report.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  const data = assembleCongregation({ year, quarter });
  const buf = await buildCongregationPdf(data);
  const filename = archiveCongregation(req, res, buf, '.pdf', 'Report', year, quarter);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buf);
});

router.get('/congregation/docx', requireAuth, async (req, res) => {
  if (!isClerkOrAdmin(req, db)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can generate the congregational report.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  const data = assembleCongregation({ year, quarter });
  const buf = await buildCongregationDocx(data);
  const filename = archiveCongregation(req, res, buf, '.docx', 'Report', year, quarter);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

router.get('/district-excel', requireAuth, async (req, res) => {
  if (!isClerkOrAdmin(req, db)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can generate the District Excel.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || 1;
  try {
    const buf = Buffer.from(await fillDistrictExcel({ year, quarter }));
    const filename = archiveCongregation(req, res, buf, '.xlsx', 'District_Excel', year, quarter);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error('[district-excel]', e);
    res.status(500).json({ error: 'Could not fill the District template: ' + e.message });
  }
});

// ---- Conference notes (annual narratives, entered by the entity) ----
router.get('/conference-notes', requireAuth, (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  res.json(db.findOne('conference_notes', n => n.year === year && n.entityType === ent.type && Number(n.entityId) === Number(ent.id)) || {});
});
router.put('/conference-notes', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.body.year) || (db.findOne('years', y => y.active) || {}).year;
  const patch = {};
  ['preamble', 'achievements', 'challenges', 'emergingFocus'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
  });
  if (req.body.goalNotes !== undefined) patch.goalNotes = req.body.goalNotes;
  const existing = db.findOne('conference_notes', n => n.year === year && n.entityType === ent.type && Number(n.entityId) === Number(ent.id));
  const rec = existing ? db.update('conference_notes', existing.id, patch)
    : db.insert('conference_notes', { year, entityType: ent.type, entityId: Number(ent.id), ...patch });
  logActivity({ ...actor(req), action: 'Saved conference notes', entityType: 'conference_notes', entityId: rec.id, entityLabel: `${year}` });
  res.json(rec);
});

// ---- Congregational Conference report (annual, committee/group) ----
router.get('/conference/pdf', requireAuth, requirePermission('reports.generate'), async (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const data = assembleConference({ year, entityType: ent.type, entityId: ent.id });
  if (!data) return res.status(404).json({ error: 'Entity not found.' });
  const buf = await buildConferencePdf(data);
  const safeName = data.entity.name.replace(/[^A-Za-z0-9]+/g, '_');
  const priors = db.findAll('generated_reports', r => r.year === year && r.quarter === 0 && r.entityType === ent.type && Number(r.entityId) === Number(ent.id));
  const version = priors.length + 1;
  const filename = `${safeName}_Conference_Report_${year}_v${version}.pdf`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buf);
  const rec = db.insert('generated_reports', {
    year, quarter: 0, entityType: ent.type, entityId: Number(ent.id),
    entityName: data.entity.name, filename, version,
    generatedBy: actor(req).userName, generatedAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: `Generated ${year} Conference report (v${version})`, entityType: 'report', entityId: rec.id, entityLabel: data.entity.name });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buf);
});

// Report history (own entity, or all for admins/clerk/viewers)
router.get('/history', requireAuth, (req, res) => {
  let list = db.findAll('generated_reports');
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent) return res.json([]);
    list = list.filter(r => r.entityType === ent.type && Number(r.entityId) === Number(ent.id));
  }
  res.json(list.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || '')));
});

// Re-download an archived copy
router.get('/download/:id', requireAuth, (req, res) => {
  const rec = db.findById('generated_reports', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Report not found.' });
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent || ent.type !== rec.entityType || Number(ent.id) !== Number(rec.entityId)) {
      return res.status(403).json({ error: 'You can only download your own reports.' });
    }
  }
  const fp = path.join(GENERATED_DIR, path.basename(rec.filename));
  if (!fs.existsSync(fp)) return res.status(410).json({ error: 'The archived file is no longer on the server.' });
  const isPdf = rec.filename.endsWith('.pdf');
  const isXlsx = rec.filename.endsWith('.xlsx');
  res.setHeader('Content-Type', isPdf ? 'application/pdf' : isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `${isPdf ? 'inline' : 'attachment'}; filename="${rec.filename}"`);
  res.send(fs.readFileSync(fp));
});

module.exports = router;
