// Restoring a backup from inside the app (Player Database > Database
// backups). A backup is the database file plus, since v1.0.17, a small
// manifest naming the club's own icon and round-end sound as they were at
// that moment (db/index.js's backupToDocuments writes both).
//
// A restore: (1) saves the data as it is right now as one more backup, so
// a restore can itself be undone; (2) checks the chosen file really is a
// Game Scheduler database; (3) swaps it in - running the usual start-up
// upgrades, so an old backup comes up to date; (4) puts the icon and sound
// back as the manifest says. Nothing is touched if step 2 fails.
const fs = require('fs');
const path = require('path');
const {
    BACKUP_DIR, CLUB_ASSETS, CLUB_ICON_ICO, backupToDocuments, readBackupManifest, openDbFromBuffer, all, get,
} = require('../db/index');
const store = require('../db/store');
const { pngToIco } = require('./pngToIco');
const { broadcast } = require('./eventBus');

const BACKUP_NAME = /^game_scheduler_[A-Za-z0-9_.-]+\.db$/;
const REQUIRED_TABLES = ['players', 'sessions', 'attendance', 'games', 'game_players', 'club_settings'];

class RestoreError extends Error {}

function backupFile(name) {
    if (!BACKUP_NAME.test(String(name || '')) || String(name).includes('..')) throw new RestoreError('That is not a backup file name.');
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) throw new RestoreError('That backup no longer exists.');
    return file;
}

// Opens a candidate database read-only and says what is in it - or throws a
// RestoreError if it isn't a usable Game Scheduler database.
async function inspect(buffer) {
    if (!buffer || buffer.length < 100 || buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
        throw new RestoreError('That file is not a Game Scheduler database.');
    }
    let db;
    try {
        db = await openDbFromBuffer(buffer);
        const tables = new Set(all(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name));
        const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
        if (missing.length) throw new RestoreError('That file is a database, but not a Game Scheduler one.');
        const integrity = all(db, 'PRAGMA integrity_check').map((r) => Object.values(r)[0]);
        if (integrity.length !== 1 || integrity[0] !== 'ok') throw new RestoreError('That backup is damaged and cannot be restored.');
        const club = get(db, 'SELECT club_name FROM club_settings WHERE id = 1');
        const last = get(db, 'SELECT date, label FROM sessions ORDER BY date DESC, id DESC LIMIT 1');
        return {
            club_name: club ? club.club_name : null,
            players: get(db, 'SELECT COUNT(*) AS n FROM players').n,
            sessions: get(db, 'SELECT COUNT(*) AS n FROM sessions').n,
            last_session_date: last ? last.date : null,
            last_session_label: last ? last.label : null,
        };
    } catch (err) {
        if (err instanceof RestoreError) throw err;
        throw new RestoreError('That file could not be read as a Game Scheduler database.');
    } finally {
        if (db) { try { db.close(); } catch (e) { /* already closed */ } }
    }
}

async function describeBackup(name) {
    const file = backupFile(name);
    const manifest = readBackupManifest(file);
    const summary = await inspect(fs.readFileSync(file));
    return {
        name,
        ...summary,
        includes_icon_and_sound: !!manifest,
        has_icon: !!(manifest && manifest.assets && manifest.assets.icon),
        has_horn: !!(manifest && manifest.assets && manifest.assets.horn),
    };
}

// Puts one of the club's own files (icon / sound) back as a backup's
// manifest says. No manifest (an older backup, or an uploaded file): leave
// what is there alone.
function restoreAsset(key, manifest) {
    const asset = CLUB_ASSETS[key];
    if (!manifest || !manifest.assets || !(key in manifest.assets)) return 'kept';
    const stored = manifest.assets[key];
    if (stored) {
        const source = path.join(BACKUP_DIR, stored);
        if (!fs.existsSync(source)) return 'kept'; // the copy went missing - don't delete what's live
        fs.mkdirSync(path.dirname(asset.file), { recursive: true });
        const bytes = fs.readFileSync(source);
        fs.writeFileSync(asset.file, bytes);
        if (key === 'icon') fs.writeFileSync(CLUB_ICON_ICO, pngToIco(bytes));
        return 'restored';
    }
    let removed = false;
    for (const f of key === 'icon' ? [asset.file, CLUB_ICON_ICO] : [asset.file]) {
        if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; }
    }
    return removed ? 'removed' : 'none';
}

// source: { name } for a backup in the backups folder, or { buffer } for an
// uploaded database file (e.g. moving the club to a new computer).
async function restore(source) {
    const buffer = source.buffer || fs.readFileSync(backupFile(source.name));
    const manifest = source.name ? readBackupManifest(backupFile(source.name)) : null;
    const summary = await inspect(buffer); // throws before anything is changed

    const before = store.queryOne('SELECT club_icon_ver, club_horn_ver FROM club_settings WHERE id = 1') || {};
    store.persist();
    const safety = backupToDocuments();

    await store.replaceWith(buffer);
    const assets = { icon: restoreAsset('icon', manifest), horn: restoreAsset('horn', manifest) };

    // Browsers cache the icon and sound forever under their version number,
    // so always move past any version either database has used. The sound's
    // sign says whether a custom one is in use (see routes/branding.js).
    const now = store.queryOne('SELECT club_icon_ver, club_horn_ver FROM club_settings WHERE id = 1') || {};
    const iconVer = Math.max(before.club_icon_ver || 0, now.club_icon_ver || 0) + 1;
    const hornMagnitude = Math.max(Math.abs(before.club_horn_ver || 0), Math.abs(now.club_horn_ver || 0)) + 1;
    const hornVer = fs.existsSync(CLUB_ASSETS.horn.file) ? hornMagnitude : -hornMagnitude;
    store.run('UPDATE club_settings SET club_icon_ver = ?, club_horn_ver = ? WHERE id = 1', [iconVer, hornVer]);
    store.persist();

    // Every open screen (the TV included) refetches.
    for (const type of ['club_settings', 'session', 'attendance', 'game']) broadcast(type, {});

    return { restored: source.name || 'uploaded file', safety_backup: safety ? path.basename(safety) : null, summary, assets };
}

module.exports = { RestoreError, inspect, describeBackup, restore, BACKUP_NAME };
