const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');

const router = express.Router();

const { PUBLIC_DIR, CLUB_ASSETS, CLUB_ICON_ICO } = require('../db/index');
const { pngToIco } = require('../lib/pngToIco');

// Where the club's own icon and sound live - defined once in db/index.js,
// because every backup takes a copy of them too.
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');
const CUSTOM_PNG_PATH = CLUB_ASSETS.icon.file;
const CUSTOM_ICO_PATH = CLUB_ICON_ICO;
const DEFAULT_PNG_PATH = path.join(ICON_DIR, 'icon-192.png');
const MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Client-side (club.js) already resizes to 256x256 before uploading; this is
// the server-side re-validation, independent of whatever the browser sent -
// same "never trust the client" pattern as the CSV/Excel importer.
// The raw-body limit is deliberately looser than MAX_BYTES so an oversized
// (but not absurd) upload reaches the handler below and gets the friendly
// "must be 2MB or smaller" message, rather than body-parser's generic
// "request entity too large" for anything past the real 2MB rule.
router.post('/icon', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'No file received.' });
    }
    if (buf.length > MAX_BYTES) {
        return res.status(400).json({ error: 'Icon must be 2MB or smaller.' });
    }
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
        return res.status(400).json({ error: 'Icon must be a PNG file.' });
    }

    try {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(CUSTOM_PNG_PATH, buf);
        fs.writeFileSync(CUSTOM_ICO_PATH, pngToIco(buf));

        const existing = store.queryOne('SELECT club_icon_ver FROM club_settings WHERE id = 1');
        const nextVer = (existing?.club_icon_ver || 0) + 1;
        store.run('UPDATE club_settings SET club_icon_ver = ? WHERE id = 1', [nextVer]);
        store.persist();

        res.json({ ok: true, version: nextVer });
    } catch (err) {
        res.status(500).json({ error: `Could not save the icon: ${err.message}` });
    }
});

router.get('/icon', (req, res) => {
    const filePath = fs.existsSync(CUSTOM_PNG_PATH) ? CUSTOM_PNG_PATH : DEFAULT_PNG_PATH;
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('png').sendFile(filePath);
});

// --- The club's own round-end sound -----------------------------------------
// A .wav the club uploads in Settings > Club details > Round-end sound,
// played by the Display screen / Rounds page instead of the built-in horn
// (public/horn.js). Kept as a plain file beside the custom icon; the
// club_settings.club_horn_ver column says whether one is in use.
const CUSTOM_HORN_PATH = CLUB_ASSETS.horn.file;
const SOUND_DIR = path.dirname(CUSTOM_HORN_PATH);
const MAX_HORN_BYTES = 5 * 1024 * 1024;

function isWav(buf) {
    return buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

function setHornVersion(ver) {
    store.run('UPDATE club_settings SET club_horn_ver = ? WHERE id = 1', [ver]);
    store.persist();
    // Every open Display / Rounds page reloads its sound straight away.
    broadcast('club_settings', {});
}

router.post('/horn', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'No file received.' });
    }
    if (buf.length > MAX_HORN_BYTES) {
        return res.status(400).json({ error: 'The sound must be 5MB or smaller - a few seconds is plenty.' });
    }
    if (!isWav(buf)) {
        return res.status(400).json({ error: 'The sound must be a .wav file.' });
    }
    try {
        fs.mkdirSync(SOUND_DIR, { recursive: true });
        fs.writeFileSync(CUSTOM_HORN_PATH, buf);
        const existing = store.queryOne('SELECT club_horn_ver FROM club_settings WHERE id = 1');
        const nextVer = Math.abs(existing?.club_horn_ver || 0) + 1;
        setHornVersion(nextVer);
        res.json({ ok: true, version: nextVer });
    } catch (err) {
        res.status(500).json({ error: `Could not save the sound: ${err.message}` });
    }
});

router.get('/horn', (req, res) => {
    if (!fs.existsSync(CUSTOM_HORN_PATH)) return res.status(404).json({ error: 'No custom sound uploaded.' });
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the URL carries ?v=<club_horn_ver>
    res.type('audio/wav').sendFile(CUSTOM_HORN_PATH);
});

// Back to the built-in horn.
router.delete('/horn', (req, res) => {
    try {
        if (fs.existsSync(CUSTOM_HORN_PATH)) fs.unlinkSync(CUSTOM_HORN_PATH);
        const existing = store.queryOne('SELECT club_horn_ver FROM club_settings WHERE id = 1');
        const ver = -Math.abs(existing?.club_horn_ver || 0);
        setHornVersion(ver);
        res.json({ ok: true, version: ver });
    } catch (err) {
        res.status(500).json({ error: `Could not remove the sound: ${err.message}` });
    }
});

module.exports = router;
