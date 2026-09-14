const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'game_scheduler.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const BACKUP_DIR = path.join(os.homedir(), 'Documents', 'GameScheduler', 'backups');
const BACKUPS_TO_KEEP = 30; // roughly a month of daily backups before old ones are pruned

let SQL = null;

async function openDb() {
    if (!SQL) {
        SQL = await initSqlJs();
    }
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        return new SQL.Database(fileBuffer);
    }
    return new SQL.Database();
}

function applySchema(db) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.run(schema);
}

function saveDb(db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Inserts the rows the app hard-requires to function (club settings row,
// courts list, payment category list, skill compatibility grid) if - and
// only if - each table is currently empty. This is distinct from
// db/seed.js's fake demo data (players/sessions/templates): those are
// optional and destructive (wipe-then-insert), these are required and
// additive-only, so it's always safe to call this on every server boot as
// well as from db/init.js. Without it, a schema-only DB (the normal result
// of running db:init and declining the demo-data prompt) leaves the Club
// page unable to load - club_settings has no row 1, so every page load
// fails with "Cannot read properties of null (reading 'club_name')".
function ensureBaselineDefaults(db) {
    const count = (table) => all(db, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

    if (count('club_settings') === 0) {
        db.run(`INSERT INTO club_settings (id) VALUES (1)`); // schema DEFAULTs fill the rest
    }

    if (count('courts') === 0) {
        for (let n = 1; n <= 7; n++) {
            db.run(`INSERT INTO courts (court_number, label, is_active) VALUES (?, NULL, 1)`, [n]);
        }
    }

    // Payment categories are deliberately NOT seeded: they're the club's own
    // pricing tiers, and a new club sets up its own in Settings rather than
    // inheriting another club's list. Nothing needs them to exist - payment
    // tracking is off by default, and Settings/check-in both handle an
    // empty list with a clear "add some" message.

    if (count('skill_compatibility') === 0) {
        const grades = ['A', 'B', 'C', 'D', 'E'];
        const rank = Object.fromEntries(grades.map((g, i) => [g, i]));
        for (const a of grades) {
            for (const b of grades) {
                const allowed = Math.abs(rank[a] - rank[b]) <= 1 ? 1 : 0;
                db.run(`INSERT INTO skill_compatibility (skill_a, skill_b, allowed) VALUES (?, ?, ?)`, [a, b, allowed]);
            }
        }
    }
}

// Payment CATEGORY is what type of player someone is (Member, Non-Member,
// Concession, etc.) - the club's own editable pricing tiers, used for every
// session including ad-hoc ones (see routes/sessions.js's ad-hoc POST
// /sessions, which now seeds from these same categories rather than a
// separate set). How they actually paid (Cash/Card/Voucher) is a
// different, fixed dimension that follows whichever category was picked -
// see attendance.payment_method - not a category itself.
//
// An earlier version of this app used Cash/Card/Voucher AS ad-hoc-session
// categories, seeded directly into payment_categories - which cluttered
// the club's real Settings list with entries the club never configured
// and that didn't fit the "type of player" model at all. Real historical
// attendance rows already reference those category ids, so they can't
// simply be deleted without corrupting old records; instead this marks
// them is_system so Settings and every "add a new category" flow can
// filter them out going forward while old payment history still resolves
// to a real name. Idempotent (only touches existing rows by name, never
// inserts) and safe to call on every boot.
const LEGACY_ADHOC_CATEGORY_NAMES = ['Cash', 'Card', 'Voucher'];

function markLegacyAdhocCategoriesSystem(db) {
    db.run(
        `UPDATE payment_categories SET is_system = 1 WHERE name IN (${LEGACY_ADHOC_CATEGORY_NAMES.map(() => '?').join(',')})`,
        LEGACY_ADHOC_CATEGORY_NAMES
    );
}

// A Sports Voucher redemption is always paid via a voucher, by definition -
// check-in now auto-fills that for every new one (see checkin.js's
// applySportsVoucherMethodDefault), but an earlier version of this app
// left payment_method blank for the category entirely. Backfills those
// already-saved rows so they show up correctly in the "Paid via" columns
// and Tonight's totals' Voucher breakdown instead of looking unrecorded.
// Only touches rows that are still blank, so it never overwrites a
// method someone genuinely recorded differently.
function backfillSportsVoucherMethod(db) {
    db.run(
        `UPDATE attendance SET payment_method = 'Voucher'
         WHERE payment_method IS NULL
           AND payment_category_id IN (SELECT id FROM payment_categories WHERE name = 'Sports Voucher')`
    );
}

// A voucher was already paid for when it was bought/allocated - redeeming
// one checks the player in and counts toward headcounts, but is never new
// money taken on the night, so it must never inflate Tonight's totals or
// any session's "total funds" figure. routes/attendance.js now enforces
// this going forward (payment_method='Voucher' always forces amount to 0),
// but rows saved before that existed (any category, not just Sports
// Voucher - a regular category paid "via voucher" too) still carry a real
// dollar amount. Zeroing them here keeps every derived total (per-category,
// per-method, grand total) correct without special-casing voucher anywhere
// in the reporting/aggregation code - the underlying data is just correct.
function zeroVoucherAmounts(db) {
    db.run(
        `UPDATE attendance SET payment_amount_cents = 0
         WHERE payment_method = 'Voucher' AND payment_amount_cents != 0`
    );
}

// This app runs on the club's own computer, so the machine's system
// timezone IS the club's local time - deliberately NOT toISOString()
// (always UTC). A club well ahead of UTC (e.g. New Zealand, UTC+12/+13)
// hit a real bug from that: comparing against UTC "today" meant a session
// stayed "open" for up to ~12 hours *past* local midnight, since UTC's own
// calendar day doesn't roll over until well into the next local day -
// exactly the "still showing open" report that flagged this.
function todayLocalDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A session left 'open' overnight (staff forgot "Finish session", or the
// computer was just switched off without it) would otherwise block every
// future session forever - only one 'open' session is ever allowed at a
// time (see routes/sessions.js), so the next club night's "Start session"
// hits a 409 until someone manually finishes yesterday's. The app has no
// way to run code exactly at midnight while the computer is off, so instead
// this runs on every boot (same idiom as ensureBaselineDefaults) and closes
// any 'open' session whose date isn't today's local date - by the time the
// app is opened again, "today" has moved on regardless of exactly when
// the computer was shut down. Mirrors exactly what the manual "Finish
// session" button does (status -> 'closed', nothing else) - a session
// closed this way still shows in History with whatever games/attendance it
// had at closing time. The live scheduler (lib/scheduler.js) does the same
// check on a timer for the rarer case where the computer is left on
// through midnight instead of shut down.
function closeStaleOpenSessions(db) {
    const today = todayLocalDateStr();
    const stale = all(db, `SELECT id FROM sessions WHERE status = 'open' AND date < ?`, [today]);
    for (const { id } of stale) {
        db.run(`UPDATE sessions SET status = 'closed' WHERE id = ?`, [id]);
    }
    return stale.length;
}

// Adds columns introduced after a database was first created, since
// `CREATE TABLE IF NOT EXISTS` in schema.sql only affects brand-new tables -
// it never retrofits an existing one. Additive-only and idempotent (checks
// PRAGMA table_info first), so it's always safe to call on every server boot
// alongside ensureBaselineDefaults, and never touches existing data.
function ensureColumns(db) {
    const attendanceCols = all(db, `PRAGMA table_info(attendance)`).map((c) => c.name);
    if (!attendanceCols.includes('new_member')) {
        db.run(`ALTER TABLE attendance ADD COLUMN new_member INTEGER NOT NULL DEFAULT 0 CHECK (new_member IN (0,1))`);
    }
    if (!attendanceCols.includes('payment_method')) {
        // How they actually paid (Cash/Card/Voucher) - separate from
        // payment_category_id, which is what TYPE of player they are
        // (Member/Non-Member/etc.). See markLegacyAdhocCategoriesSystem's
        // comment for why these used to be conflated.
        db.run(`ALTER TABLE attendance ADD COLUMN payment_method TEXT CHECK (payment_method IN ('Cash','Card','Voucher'))`);
    }

    // Doubles (4 a court) or singles (2 a court, e.g. squash) - per template
    // and per session, so one club can run both kinds of night.
    const templateColsNow = all(db, `PRAGMA table_info(session_templates)`).map((c) => c.name);
    if (!templateColsNow.includes('default_format')) {
        db.run(`ALTER TABLE session_templates ADD COLUMN default_format TEXT NOT NULL DEFAULT 'doubles' CHECK (default_format IN ('doubles','singles'))`);
    }
    const sessionColsNow = all(db, `PRAGMA table_info(sessions)`).map((c) => c.name);
    if (!sessionColsNow.includes('format')) {
        db.run(`ALTER TABLE sessions ADD COLUMN format TEXT NOT NULL DEFAULT 'doubles' CHECK (format IN ('doubles','singles'))`);
    }

    const gamesCols = all(db, `PRAGMA table_info(games)`).map((c) => c.name);
    if (!gamesCols.includes('started_at')) {
        // When the game actually went on court - created_at is when it was
        // staged, which in auto mode is minutes earlier (pre-generation).
        db.run(`ALTER TABLE games ADD COLUMN started_at TEXT`);
    }

    const paymentCategoryCols = all(db, `PRAGMA table_info(payment_categories)`).map((c) => c.name);
    if (!paymentCategoryCols.includes('is_system')) {
        db.run(`ALTER TABLE payment_categories ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1))`);
    }

    const clubSettingsCols = all(db, `PRAGMA table_info(club_settings)`).map((c) => c.name);
    const newClubSettingsCols = [
        'smtp2go_api_key', 'smtp2go_sender_email', 'smtp2go_sender_name', 'summary_recipient_emails',
        'mailgun_api_key', 'mailgun_domain', 'mailgun_sender_email', 'mailgun_sender_name',
        'gmail_user', 'gmail_app_password',
        'square_access_token', 'square_location_id',
    ];
    for (const col of newClubSettingsCols) {
        if (!clubSettingsCols.includes(col)) {
            db.run(`ALTER TABLE club_settings ADD COLUMN ${col} TEXT`);
        }
    }
    if (!clubSettingsCols.includes('email_provider')) {
        // Which of smtp2go/mailgun/gmail's credentials above are actually
        // used to send the end-of-night summary (see lib/sendEmail.js).
        db.run(`ALTER TABLE club_settings ADD COLUMN email_provider TEXT NOT NULL DEFAULT 'smtp2go' CHECK (email_provider IN ('smtp2go','mailgun','gmail'))`);
    }
    if (!clubSettingsCols.includes('gender_aware_pairing')) {
        // On by default - auto-generate prefers mixed pairs / same-gender
        // courts over 3-1 or segregated-sides splits (see lib/autoGenerate.js).
        db.run(`ALTER TABLE club_settings ADD COLUMN gender_aware_pairing INTEGER NOT NULL DEFAULT 1 CHECK (gender_aware_pairing IN (0,1))`);
    }
    if (!clubSettingsCols.includes('club_icon_ver')) {
        // Bumped by routes/branding.js on every icon upload - lets every page
        // cache-bust the favicon/logo without needing a live push.
        db.run(`ALTER TABLE club_settings ADD COLUMN club_icon_ver INTEGER NOT NULL DEFAULT 0`);
    }
    if (!clubSettingsCols.includes('date_format')) {
        // Display-only preference (DMY/MDY/YMD) - see public/dateFormat.js.
        db.run(`ALTER TABLE club_settings ADD COLUMN date_format TEXT NOT NULL DEFAULT 'YMD' CHECK (date_format IN ('DMY','MDY','YMD'))`);
    }
    if (!clubSettingsCols.includes('allow_network_access')) {
        // Off by default: the server binds to 127.0.0.1 and Windows never
        // shows its "allow Node.js through the firewall" prompt. Clubs that
        // open the External Display on another device turn it on (Settings
        // > Club details > Game defaults); takes effect at the next start.
        db.run(`ALTER TABLE club_settings ADD COLUMN allow_network_access INTEGER NOT NULL DEFAULT 0 CHECK (allow_network_access IN (0,1))`);
    }

    const templateCols = all(db, `PRAGMA table_info(session_templates)`).map((c) => c.name);
    for (const col of ['default_game_minutes', 'default_break_minutes']) {
        if (!templateCols.includes(col)) {
            db.run(`ALTER TABLE session_templates ADD COLUMN ${col} INTEGER`);
        }
    }

    const sessionCols = all(db, `PRAGMA table_info(sessions)`).map((c) => c.name);
    if (!sessionCols.includes('notes')) {
        // Free-text, e.g. "sold 2 club shirts, $40 cash" - see the Notes
        // popup on Check-in/Rounds and the end-of-night summary email.
        db.run(`ALTER TABLE sessions ADD COLUMN notes TEXT`);
    }
}

// SQLite can't alter a CHECK constraint in place - unlike every other
// migration in this file (all a simple additive ALTER TABLE ADD COLUMN),
// adding 'booked' to attendance.state's allowed values needs a full table
// rebuild: copy every row into a fresh table with the new constraint, drop
// the old, rename. Only runs if the existing constraint doesn't already
// allow 'booked' (checked via sqlite_master's stored CREATE TABLE text,
// since PRAGMA table_info doesn't expose CHECK constraints) - so it's still
// safe to call on every boot like everything else here, a no-op once a
// database has already been rebuilt. Must run AFTER ensureColumns(), since
// it assumes every column ensureColumns can add (payment_method, new_member,
// ...) already exists on whatever real database it's rebuilding.
function ensureAttendanceBookedState(db) {
    const row = get(db, `SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance'`);
    if (!row || row.sql.includes("'booked'")) return;

    db.run(`CREATE TABLE attendance_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        player_id INTEGER NOT NULL REFERENCES players(id),
        checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
        state TEXT NOT NULL CHECK (state IN ('checked_in','here_today','playing','booked','left')) DEFAULT 'checked_in',
        left_reason TEXT CHECK (left_reason IN ('no-show','departed','injured','session_ended','removed')),
        payment_category_id INTEGER REFERENCES payment_categories(id),
        payment_amount_cents INTEGER,
        payment_method TEXT CHECK (payment_method IN ('Cash','Card','Voucher')),
        payment_note TEXT,
        first_time INTEGER NOT NULL DEFAULT 0 CHECK (first_time IN (0,1)),
        new_member INTEGER NOT NULL DEFAULT 0 CHECK (new_member IN (0,1))
    )`);
    db.run(`INSERT INTO attendance_new
        (id, session_id, player_id, checked_in_at, state, left_reason, payment_category_id, payment_amount_cents, payment_method, payment_note, first_time, new_member)
        SELECT id, session_id, player_id, checked_in_at, state, left_reason, payment_category_id, payment_amount_cents, payment_method, payment_note, first_time, new_member
        FROM attendance`);
    db.run(`DROP TABLE attendance`);
    db.run(`ALTER TABLE attendance_new RENAME TO attendance`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_player ON attendance(player_id)`);
}

// Same table-rebuild approach as ensureAttendanceBookedState, for the same
// reason (SQLite can't alter a CHECK constraint in place) - adds 'paused'
// to sessions.current_phase's allowed values, plus 3 new nullable columns
// that track enough state to resume a paused phase with the correct
// remaining time (see lib/roundLifecycle.js's pauseCurrentPhase/
// resumeCurrentPhase). Must run after ensureColumns() so every column it
// copies (including 'notes', added by a plain ALTER TABLE earlier in that
// same function) already exists on whatever real database it's rebuilding.
function ensureSessionsPausedPhase(db) {
    const row = get(db, `SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`);
    if (!row || row.sql.includes("'paused'")) return;

    db.run(`CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER REFERENCES session_templates(id),
        date TEXT NOT NULL,
        label TEXT,
        scheduled_start_time TEXT,
        scheduled_end_time TEXT,
        location TEXT,
        status TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
        mode TEXT NOT NULL CHECK (mode IN ('auto','manual','social')),
        game_minutes INTEGER,
        break_minutes INTEGER,
        max_capacity INTEGER,
        current_phase TEXT NOT NULL CHECK (current_phase IN ('idle','game','break','awaiting_lineup','paused')) DEFAULT 'idle',
        phase_started_at TEXT,
        phase_ends_at TEXT,
        notes TEXT,
        paused_remaining_ms INTEGER,
        phase_paused_at TEXT,
        paused_from_phase TEXT CHECK (paused_from_phase IN ('game','break'))
    )`);
    db.run(`INSERT INTO sessions_new
        (id, template_id, date, label, scheduled_start_time, scheduled_end_time, location, status, mode, game_minutes, break_minutes, max_capacity, current_phase, phase_started_at, phase_ends_at, notes)
        SELECT id, template_id, date, label, scheduled_start_time, scheduled_end_time, location, status, mode, game_minutes, break_minutes, max_capacity, current_phase, phase_started_at, phase_ends_at, notes
        FROM sessions`);
    db.run(`DROP TABLE sessions`);
    db.run(`ALTER TABLE sessions_new RENAME TO sessions`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
}

// A plain-text explainer dropped once into the backup folder itself, so
// it's findable by anyone who stumbles onto Documents\GameScheduler\backups
// without already knowing what this app is or where to get it again -
// written fresh any time its content changes (e.g. a URL update), left
// alone otherwise. Filename deliberately does NOT match the
// "game_scheduler_*.db" pattern backup rotation prunes below, so it's
// never at risk of being swept up by that cleanup - if that pattern is
// ever changed, keep this filename excluded from it.
const BACKUP_README_PATH_ = path.join(BACKUP_DIR, 'README.txt');
const BACKUP_README_CONTENT = `Game Scheduler - database backups
==================================

This folder holds automatic backups of the club's Game Scheduler database
(game_scheduler_<timestamp>.db), one per app launch. The newest ${BACKUPS_TO_KEEP}
are kept; older ones are deleted automatically.

To restore a backup:
1. Close Game Scheduler completely.
2. Copy the backup file you want back to the Game Scheduler folder (where
   "Game Scheduler.cmd" lives), and rename it to "game_scheduler.db"
   (replacing the current one).
3. Start Game Scheduler again.

To re-download the app itself:
  Repository:  https://github.com/markosharknz1/Session_Organiser
  Releases:    https://github.com/markosharknz1/Session_Organiser/releases

Download the latest release ZIP, extract it, then restore a backup as
above if you need to bring your club's data back.
`;

function writeBackupReadme() {
    if (fs.existsSync(BACKUP_README_PATH_) && fs.readFileSync(BACKUP_README_PATH_, 'utf8') === BACKUP_README_CONTENT) return;
    fs.writeFileSync(BACKUP_README_PATH_, BACKUP_README_CONTENT);
}

// Copies the live database to Documents\GameScheduler\backups, timestamped,
// so real club data isn't only ever stored in one place. Runs once per
// server boot (see db/store.js) - club nights happen periodically, not
// continuously, so "one backup per launch" gives a natural daily-ish
// cadence without spamming a backup on every single write. Prunes down to
// the newest BACKUPS_TO_KEEP afterward so the folder doesn't grow forever.
// Never throws - a failed backup (e.g. no Documents folder, disk full)
// should never stop the app from starting.
function backupToDocuments() {
    try {
        if (!fs.existsSync(DB_PATH)) return null;
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        writeBackupReadme();

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `game_scheduler_${stamp}.db`);
        fs.copyFileSync(DB_PATH, backupPath);

        // Only ever matches "game_scheduler_*.db" - README.txt is never at risk of pruning.
        const files = fs.readdirSync(BACKUP_DIR)
            .filter((f) => f.startsWith('game_scheduler_') && f.endsWith('.db'))
            .sort(); // ISO timestamps in the filename sort chronologically
        const toDelete = files.slice(0, Math.max(0, files.length - BACKUPS_TO_KEEP));
        for (const f of toDelete) fs.unlinkSync(path.join(BACKUP_DIR, f));

        return backupPath;
    } catch (err) {
        console.error('Backup to Documents failed (non-fatal):', err.message);
        return null;
    }
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('game_scheduler_') && f.endsWith('.db'))
        .map((f) => {
            const stat = fs.statSync(path.join(BACKUP_DIR, f));
            return { name: f, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Runs a SELECT and returns an array of plain row objects.
function all(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

function get(db, sql, params = []) {
    const rows = all(db, sql, params);
    return rows[0] || null;
}

module.exports = {
    DB_PATH, SCHEMA_PATH, BACKUP_DIR, openDb, applySchema, saveDb, all, get,
    ensureBaselineDefaults, ensureColumns, ensureAttendanceBookedState, ensureSessionsPausedPhase, markLegacyAdhocCategoriesSystem, backfillSportsVoucherMethod, zeroVoucherAmounts, closeStaleOpenSessions, backupToDocuments, listBackups,
    todayLocalDateStr,
};
