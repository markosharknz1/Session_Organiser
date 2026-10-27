// The committee report against a throwaway in-memory database.
// Run: node lib/committeeReport.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { committeeReport, committeeCsv } = require('./committeeReport');

let SQL;
let passed = 0;
let failed = 0;

async function freshDb() {
    if (!SQL) SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    return db;
}

async function test(name, fn) {
    try {
        const db = await freshDb();
        await fn(db);
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.stack || err.message}`);
    }
}

function session(db, id, date) {
    db.run(`INSERT INTO sessions (id, date, label, status, mode, current_phase) VALUES (?, ?, 'Night', 'closed', 'manual', 'idle')`, [id, date]);
}
function player(db, id, first, last, status = 'active') {
    db.run(`INSERT INTO players (id, first_name, last_name, skill_level, gender, membership_status) VALUES (?, ?, ?, 'C', 'M', ?)`, [id, first, last, status]);
}
function attend(db, sessionId, playerId, state = 'here_today', reason = null) {
    db.run(`INSERT INTO attendance (session_id, player_id, state, left_reason) VALUES (?, ?, ?, ?)`, [sessionId, playerId, state, reason]);
}
let gameId = 0;
function game(db, sessionId, round, players, winner = null) {
    gameId++;
    db.run(`INSERT INTO courts (id, court_number, is_active) VALUES (?, ?, 1)`, [gameId, gameId]);
    db.run(`INSERT INTO games (id, session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'doubles', 'manual', 'completed')`, [gameId, sessionId, gameId, round]);
    players.forEach((p, i) => db.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`, [gameId, p, i < 2 ? 1 : 2]));
    if (winner) db.run(`INSERT INTO game_results (game_id, winner_side) VALUES (?, ?)`, [gameId, winner]);
}

// A small club: Ann is an old hand (first came in 2024), Bob and Cy are new
// in Q1 2025 - Bob keeps coming, Cy tries it once - Dee books and never
// arrives, Eve is checked in by mistake.
function seed(db) {
    session(db, 1, '2024-11-05');
    session(db, 2, '2025-01-07');
    session(db, 3, '2025-01-14');
    session(db, 4, '2025-02-04');
    session(db, 5, '2025-04-01'); // outside Q1
    player(db, 1, 'Ann', 'Old');
    player(db, 2, 'Bob', 'New', 'guest');
    player(db, 3, 'Cy', 'Once', 'guest');
    player(db, 4, 'Dee', 'Booked');
    player(db, 5, 'Eve', 'Mistake');
    player(db, 6, 'Fay', 'Later');
    attend(db, 1, 1);
    attend(db, 2, 1); attend(db, 2, 2); attend(db, 2, 3); attend(db, 2, 4, 'booked'); attend(db, 2, 5, 'left', 'no-show');
    attend(db, 3, 1); attend(db, 3, 2);
    attend(db, 4, 1); attend(db, 4, 2, 'left', 'departed');
    attend(db, 5, 1); attend(db, 5, 6);
    game(db, 2, 1, [1, 2, 3, 4], 1);
    game(db, 3, 1, [1, 2, 3, 4]);
    game(db, 3, 2, [2, 1, 3, 4], 2);
    game(db, 5, 1, [1, 6, 2, 3]);
}

async function main() {
    await test('headline counts for a quarter', async (db) => {
        seed(db);
        const r = committeeReport(db, '2025-01-01', '2025-03-31');
        assert.strictEqual(r.sessions_held, 3);
        assert.strictEqual(r.unique_players, 3, 'Ann, Bob, Cy - not the booking, not the mistake');
        assert.strictEqual(r.attendances, 3 + 3 + 1);
        assert.strictEqual(r.average_per_session, 2.3);
        assert.deepStrictEqual(r.by_membership, { active: 1, lapsed: 0, guest: 2 });
    });

    await test('new players and whether they came back', async (db) => {
        seed(db);
        const r = committeeReport(db, '2025-01-01', '2025-03-31');
        assert.strictEqual(r.new_players, 2, 'Bob and Cy; Ann first came in 2024');
        assert.strictEqual(r.returned_after_first, 1, 'Bob came back, Cy did not');
        assert.strictEqual(r.retention_rate, 50);
        assert.deepStrictEqual(r.retention.map((b) => [b.key, b.players]), [['once', 1], ['two_three', 1], ['four_five', 0], ['six_plus', 0]]);
        const bob = r.players.find((p) => p.first_name === 'Bob');
        assert.deepStrictEqual([bob.is_new, bob.first_seen, bob.sessions, bob.matches, bob.wins, bob.losses], [true, '2025-01-07', 3, 3, 1, 1]);
        const ann = r.players.find((p) => p.first_name === 'Ann');
        assert.deepStrictEqual([ann.is_new, ann.sessions, ann.matches, ann.wins, ann.losses], [false, 3, 3, 1, 1]);
    });

    await test('players are ordered by sessions then matches; the range can be open-ended', async (db) => {
        seed(db);
        const r = committeeReport(db, null, null);
        assert.strictEqual(r.sessions_held, 5);
        assert.deepStrictEqual(r.players.map((p) => p.first_name), ['Ann', 'Bob', 'Cy', 'Fay']);
        assert.strictEqual(r.new_players, 4, 'with no range everyone is "new"');
        const fay = r.players.find((p) => p.first_name === 'Fay');
        assert.strictEqual(fay.matches, 1);
    });

    await test('an empty range reports zeros rather than failing', async (db) => {
        seed(db);
        const r = committeeReport(db, '2030-01-01', '2030-12-31');
        assert.deepStrictEqual([r.sessions_held, r.unique_players, r.new_players, r.retention_rate, r.players.length], [0, 0, 0, null, 0]);
    });

    await test('the CSV carries the summary and one row per player, with commas escaped', async (db) => {
        seed(db);
        db.run(`UPDATE players SET last_name = 'Old, Jr' WHERE id = 1`);
        const csv = committeeCsv(committeeReport(db, '2025-01-01', '2025-03-31'));
        const lines = csv.split('\r\n');
        assert.strictEqual(lines[0], 'Game Scheduler committee report');
        assert.ok(lines.includes('Sessions held,3'));
        assert.ok(lines.includes('New players who came back,1,50%'));
        assert.ok(lines.includes('Last name,First name,Grade,Membership,Gender,New in range,First seen,Sessions attended,Matches played,Won,Lost'));
        assert.ok(lines.includes('"Old, Jr",Ann,C,active,M,No,2024-11-05,3,3,1,1'));
        assert.ok(lines.includes('New,Bob,C,guest,M,Yes,2025-01-07,3,3,1,1'));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
