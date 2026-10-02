// Backup and restore, end to end, in a throwaway folder: the real store,
// the real backup function, the real restore - pointed (via the
// GAME_SCHEDULER_* overrides in db/index.js) at a temp directory so nothing
// here can touch the club's database, backups or uploads.
// Run: node lib/backupRestore.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-backup-test-'));
process.env.GAME_SCHEDULER_DB_PATH = path.join(ROOT, 'app', 'game_scheduler.db');
process.env.GAME_SCHEDULER_BACKUP_DIR = path.join(ROOT, 'backups');
process.env.GAME_SCHEDULER_PUBLIC_DIR = path.join(ROOT, 'app', 'public');
process.env.GAME_SCHEDULER_BACKUPS_TO_KEEP = '8';
fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true });

const { BACKUP_DIR, CLUB_ASSETS, CLUB_ICON_ICO, backupToDocuments, listBackups, readBackupManifest } = require('../db/index');
const store = require('../db/store');
const { RestoreError, describeBackup, restore, inspect } = require('./backupRestore');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

const PNG_A = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('icon version A')]);
const PNG_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('icon version B - different')]);
const WAV_A = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(40, 7)]);

function writeAsset(key, bytes) {
    fs.mkdirSync(path.dirname(CLUB_ASSETS[key].file), { recursive: true });
    fs.writeFileSync(CLUB_ASSETS[key].file, bytes);
}
const playerNames = () => store.query('SELECT first_name FROM players ORDER BY id').map((r) => r.first_name);
const addPlayer = (name) => { store.run(`INSERT INTO players (first_name, last_name, skill_level, membership_status) VALUES (?, 'Test', 'C', 'active')`, [name]); store.persist(); };
const base = (p) => path.basename(p);

async function main() {
    await store.init(); // a fresh database in the temp folder (and its first automatic backup)

    await test('everything under test lives in the temp folder', async () => {
        assert.ok(BACKUP_DIR.startsWith(ROOT));
        assert.ok(CLUB_ASSETS.icon.file.startsWith(ROOT) && CLUB_ASSETS.horn.file.startsWith(ROOT));
        assert.ok(fs.existsSync(process.env.GAME_SCHEDULER_DB_PATH));
    });

    let backupWithAssets;
    await test('a backup takes the database and the club icon and sound, and says so in its manifest', async () => {
        addPlayer('Ann'); addPlayer('Bob');
        store.run(`UPDATE club_settings SET club_name = 'Riverside Club', club_icon_ver = 3, club_horn_ver = 2 WHERE id = 1`); store.persist();
        writeAsset('icon', PNG_A); writeAsset('horn', WAV_A);
        backupWithAssets = backupToDocuments();
        assert.ok(fs.existsSync(backupWithAssets));
        const m = readBackupManifest(backupWithAssets);
        assert.match(m.assets.icon, /^assets\/[0-9a-f]{32}\.png$/);
        assert.match(m.assets.horn, /^assets\/[0-9a-f]{32}\.wav$/);
        assert.ok(fs.readFileSync(path.join(BACKUP_DIR, m.assets.icon)).equals(PNG_A));
        assert.ok(fs.readFileSync(path.join(BACKUP_DIR, m.assets.horn)).equals(WAV_A));
        const listed = listBackups().find((b) => b.name === base(backupWithAssets));
        assert.deepStrictEqual([listed.has_manifest, listed.has_icon, listed.has_horn], [true, true, true]);
    });

    await test('an unchanged icon or sound is stored once, however many backups there are', async () => {
        const before = fs.readdirSync(path.join(BACKUP_DIR, 'assets')).length;
        backupToDocuments();
        assert.strictEqual(fs.readdirSync(path.join(BACKUP_DIR, 'assets')).length, before);
    });

    await test('describe: what is in a backup, without changing anything', async () => {
        const d = await describeBackup(base(backupWithAssets));
        assert.deepStrictEqual({ club: d.club_name, players: d.players, icon: d.has_icon, horn: d.has_horn, both: d.includes_icon_and_sound }, { club: 'Riverside Club', players: 2, icon: true, horn: true, both: true });
        assert.deepStrictEqual(playerNames(), ['Ann', 'Bob']);
    });

    await test('restore puts the players, settings, icon and sound back - and saves what was there first', async () => {
        // the club carries on: a player removed, another added, new icon, sound removed
        store.run(`DELETE FROM players WHERE first_name = 'Bob'`); addPlayer('Cy');
        store.run(`UPDATE club_settings SET club_name = 'Renamed Club', club_icon_ver = 4, club_horn_ver = -2 WHERE id = 1`); store.persist();
        writeAsset('icon', PNG_B); fs.unlinkSync(CLUB_ASSETS.horn.file);
        assert.deepStrictEqual(playerNames(), ['Ann', 'Cy']);

        const result = await restore({ name: base(backupWithAssets) });
        assert.deepStrictEqual(playerNames(), ['Ann', 'Bob']);
        assert.strictEqual(store.queryOne('SELECT club_name FROM club_settings WHERE id = 1').club_name, 'Riverside Club');
        assert.ok(fs.readFileSync(CLUB_ASSETS.icon.file).equals(PNG_A), 'icon back to the backed-up one');
        assert.ok(fs.readFileSync(CLUB_ASSETS.horn.file).equals(WAV_A), 'sound restored');
        assert.ok(fs.existsSync(CLUB_ICON_ICO), 'shortcut icon regenerated');
        assert.deepStrictEqual(result.assets, { icon: 'restored', horn: 'restored' });
        assert.strictEqual(result.summary.players, 2);

        // versions move past anything either database used, so no browser shows a stale file
        const v = store.queryOne('SELECT club_icon_ver, club_horn_ver FROM club_settings WHERE id = 1');
        assert.strictEqual(v.club_icon_ver, 5);
        assert.strictEqual(v.club_horn_ver, 3);

        // the state just before the restore was saved, and can be restored in turn
        assert.ok(result.safety_backup);
        const undo = await describeBackup(result.safety_backup);
        assert.deepStrictEqual([undo.club_name, undo.players, undo.has_icon, undo.has_horn], ['Renamed Club', 2, true, false]);
        // and what is on disk is the restored database, not just what is in memory
        const onDisk = await inspect(fs.readFileSync(process.env.GAME_SCHEDULER_DB_PATH));
        assert.strictEqual(onDisk.club_name, 'Riverside Club');
    });

    await test('undoing a restore: the safety backup brings back the later state, including "no sound"', async () => {
        const safety = listBackups().find((b) => b.has_icon && !b.has_horn);
        const result = await restore({ name: safety.name });
        assert.deepStrictEqual(playerNames(), ['Ann', 'Cy']);
        assert.ok(fs.readFileSync(CLUB_ASSETS.icon.file).equals(PNG_B));
        assert.ok(!fs.existsSync(CLUB_ASSETS.horn.file), 'the sound is removed because that backup had none');
        assert.deepStrictEqual(result.assets, { icon: 'restored', horn: 'removed' });
        assert.ok(store.queryOne('SELECT club_horn_ver FROM club_settings WHERE id = 1').club_horn_ver < 0, 'back to the built-in horn');
    });

    await test('a file that is not a Game Scheduler database is refused and nothing changes', async () => {
        const before = playerNames();
        const backupsBefore = listBackups().length;
        await assert.rejects(restore({ buffer: Buffer.from('this is not a database at all, just some text that is long enough to pass a length check..........') }), RestoreError);
        await assert.rejects(restore({ name: '../../game_scheduler.db' }), RestoreError);
        await assert.rejects(restore({ name: 'game_scheduler_nope.db' }), RestoreError);
        const SQL = await require('sql.js')();
        const other = new SQL.Database(); other.run('CREATE TABLE notes (id INTEGER)');
        await assert.rejects(restore({ buffer: Buffer.from(other.export()) }), /not a Game Scheduler one/);
        assert.deepStrictEqual(playerNames(), before);
        assert.strictEqual(listBackups().length, backupsBefore, 'no safety backup is made for a refused restore');
    });

    await test('restoring an uploaded database file (no manifest) leaves the icon and sound alone', async () => {
        const iconBefore = fs.readFileSync(CLUB_ASSETS.icon.file);
        const result = await restore({ buffer: fs.readFileSync(backupWithAssets) });
        assert.deepStrictEqual(playerNames(), ['Ann', 'Bob']);
        assert.deepStrictEqual(result.assets, { icon: 'kept', horn: 'kept' });
        assert.ok(fs.readFileSync(CLUB_ASSETS.icon.file).equals(iconBefore));
        assert.ok(store.queryOne('SELECT club_horn_ver FROM club_settings WHERE id = 1').club_horn_ver < 0, 'no sound file on disk, so the built-in horn');
    });

    await test('an older backup with no manifest restores the data and keeps the current icon and sound', async () => {
        const old = path.join(BACKUP_DIR, 'game_scheduler_2020-01-01T00-00-00-000Z.db');
        fs.copyFileSync(backupWithAssets, old);
        const d = await describeBackup(base(old));
        assert.strictEqual(d.includes_icon_and_sound, false);
        const result = await restore({ name: base(old) });
        assert.deepStrictEqual(result.assets, { icon: 'kept', horn: 'kept' });
    });

    await test('only the newest backups are kept, and stored icons/sounds nothing refers to are cleared out', async () => {
        writeAsset('horn', Buffer.concat([WAV_A, Buffer.from('a different sound')]));
        for (let i = 0; i < 6; i++) backupToDocuments();
        const backups = listBackups();
        assert.strictEqual(backups.length, 8);
        assert.ok(!backups.some((b) => b.name.includes('2020-01-01')), 'the oldest went first');
        const manifests = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json'));
        assert.strictEqual(manifests.length, 8, 'manifests are pruned with their backups');
        const referenced = new Set(backups.flatMap((b) => Object.values(readBackupManifest(path.join(BACKUP_DIR, b.name)).assets).filter(Boolean).map(base)));
        assert.deepStrictEqual(new Set(fs.readdirSync(path.join(BACKUP_DIR, 'assets'))), referenced);
        assert.ok(fs.existsSync(path.join(BACKUP_DIR, 'README.txt')), 'the README is never pruned');
    });

    console.log(`\n${passed} backup/restore tests passed`);
}

main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* temp folder */ } });
