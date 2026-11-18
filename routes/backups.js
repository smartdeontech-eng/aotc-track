const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { runBackup, listBackups, streamBackupZip } = require('../utils/backup');
const { logNotification } = require('../utils/notifications');

const router = express.Router();

router.get('/', requireAuth, requirePermission('staff.manage'), (req, res) => {
  res.json(listBackups());
});

router.post('/run', requireAuth, requirePermission('staff.manage'), (req, res) => {
  try {
    res.status(201).json(runBackup());
  } catch (e) {
    logNotification({ level: 'error', source: 'backup', message: `Manual backup failed: ${e.message}` });
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

router.get('/:name/download', requireAuth, requirePermission('staff.manage'), (req, res) => {
  // Guard against path traversal — only allow the expected backup-name shape.
  if (!/^backup-\d{8}-\d{6}$/.test(req.params.name)) {
    return res.status(400).json({ error: 'Invalid backup name.' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.zip"`);
  try {
    streamBackupZip(req.params.name, res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

module.exports = router;
