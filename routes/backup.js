const express = require('express');
const { DB_PATH, BACKUP_DIR, backupToDocuments, listBackups } = require('../db/index');
const store = require('../db/store');
const { isLocalRequest } = require('../lib/access');
const { RestoreError, describeBackup, restore } = require('../lib/backupRestore');

const router = express.Router();

// Restoring replaces the club's whole database - only ever from the main
// computer itself, never from another device, whatever PIN it used.
function mainComputerOnly(req, res, next) {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'A backup can only be restored on the main computer.' });
    return next();
}

function fail(res, err) {
    if (err instanceof RestoreError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: `Restore failed: ${err.message}` });
}

// Info for the Player Database page's "Database backups" panel - where
// automatic backups land and what's there, without digging through Explorer.
router.get('/status', (req, res) => {
    res.json({ backup_dir: BACKUP_DIR, backups: listBackups() });
});

// Downloads the live database right now (persisted first, so it reflects
// everything up to this exact moment, not just the last automatic backup).
router.get('/download', (req, res) => {
    store.persist();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.download(DB_PATH, `game_scheduler_${stamp}.db`);
});

// Also copies straight into the Documents backup folder (same as the
// automatic per-launch backup), for "back it up right now" without a
// separate download+move step.
router.post('/now', (req, res) => {
    store.persist();
    const backupPath = backupToDocuments();
    if (!backupPath) return res.status(500).json({ error: 'Backup failed - see server logs for details.' });
    res.json({ backup_dir: BACKUP_DIR, backups: listBackups() });
});

// What is in a backup - shown before the club confirms a restore.
router.get('/describe/:name', async (req, res) => {
    try {
        res.json(await describeBackup(req.params.name));
    } catch (err) {
        fail(res, err);
    }
});

// Restore one of the backups in the backups folder.
router.post('/restore', mainComputerOnly, async (req, res) => {
    try {
        res.json(await restore({ name: req.body && req.body.name }));
    } catch (err) {
        fail(res, err);
    }
});

// Restore from a database file the club has elsewhere (a downloaded copy,
// or the file from the old computer when moving to a new one).
router.post('/restore-upload', mainComputerOnly, express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'No file received.' });
        res.json(await restore({ buffer: req.body }));
    } catch (err) {
        fail(res, err);
    }
});

module.exports = router;
