// Singleton in-memory sql.js connection for the running server process.
// Every mutating call persists to disk immediately (persist()) - this is a
// single-writer local app, not a high-throughput server, so simplicity and
// durability win over batching writes.
const { openDb, applySchema, saveDb, ensureBaselineDefaults, ensureColumns, ensureAttendanceBookedState, ensureSessionsPausedPhase, ensureThreesFormat, ensureAttendanceWasBooked, trimPlayerNames, markLegacyAdhocCategoriesSystem, backfillSportsVoucherMethod, zeroVoucherAmounts, closeStaleOpenSessions, backupToDocuments, openDbFromBuffer, all, get } = require('./index');

let db = null;

// Everything a database goes through before it is used: the schema, the
// rows the app can't run without, and every upgrade step in order. Run on
// the club's own database at start-up, and on a backup being restored - so
// an old backup comes up to date the same way an old install does.
function migrate(db) {
    applySchema(db); // safety net if db:init was never run
    ensureBaselineDefaults(db); // self-heals a schema-only DB (e.g. demo data declined at install)
    ensureColumns(db); // retrofits columns added after this DB was first created
    ensureAttendanceBookedState(db); // table-rebuild migration: allows attendance.state = 'booked' (must run after ensureColumns)
    ensureSessionsPausedPhase(db); // table-rebuild migration: allows sessions.current_phase = 'paused' (must run after ensureColumns)
    ensureThreesFormat(db); // table-rebuild migration: allows format = 'threes' on templates, sessions and games (must run after the two above)
    ensureAttendanceWasBooked(db); // attendance.was_booked - pre-booked vs turned up on the day (must run after the attendance rebuild above)
    trimPlayerNames(db); // names stored with spaces around them sort to the wrong place
    markLegacyAdhocCategoriesSystem(db); // hide the old Cash/Card/Voucher categories from Settings, keep history intact
    backfillSportsVoucherMethod(db); // any Sports Voucher payment saved before this was tracked
    zeroVoucherAmounts(db); // a voucher redemption is never new money taken - zero any stale nonzero amount
    closeStaleOpenSessions(db); // yesterday's session left open overnight doesn't block tonight's
}

async function init() {
    db = await openDb();
    migrate(db);
    saveDb(db);
    backupToDocuments(); // one safety-net copy per launch to Documents\GameScheduler\backups
    return db;
}

// Swaps the running database for another one (a backup being restored -
// lib/backupRestore.js). The replacement is brought up to date and written
// to disk before the old one is let go.
async function replaceWith(buffer) {
    const next = await openDbFromBuffer(buffer);
    migrate(next);
    const previous = db;
    db = next;
    saveDb(db);
    try { previous.close(); } catch (err) { /* already closed */ }
    return db;
}

function run(sql, params = []) {
    db.run(sql, params);
}

function insert(sql, params = []) {
    db.run(sql, params);
    return get(db, 'SELECT last_insert_rowid() AS id').id;
}

function query(sql, params = []) {
    return all(db, sql, params);
}

function queryOne(sql, params = []) {
    return get(db, sql, params);
}

function persist() {
    saveDb(db);
}

// Exposes the raw sql.js connection for modules that need to reuse the
// shared all()/get() query helpers directly (e.g. lib/autoGenerate.js, which
// is designed to run against any db handle so it can be unit-tested against
// a throwaway in-memory database instead of the real one).
function getDb() {
    return db;
}

module.exports = { init, replaceWith, run, insert, query, queryOne, persist, getDb };
