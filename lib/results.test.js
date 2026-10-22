// Game results against the real store in a throwaway folder (same
// GAME_SCHEDULER_* overrides as the backup tests - nothing here can touch
// the club's database or backups).
// Run: node lib/results.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-results-test-'));
process.env.GAME_SCHEDULER_DB_PATH = path.join(ROOT, 'app', 'game_scheduler.db');
process.env.GAME_SCHEDULER_BACKUP_DIR = path.join(ROOT, 'backups');
process.env.GAME_SCHEDULER_PUBLIC_DIR = path.join(ROOT, 'app', 'public');
fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true });

const store = require('../db/store');
const { ResultError, recordResult, clearResult, resultFor, playerRecord } = require('./results');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

let SESSION;
let court;
const ids = [];

function addGame(round, status, players, format = 'doubles') {
    const id = store.insert(
        `INSERT INTO games (session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'manual', ?)`,
        [SESSION, court, round, format, status]
    );
    const perSide = format === 'threes' ? 3 : players.length / 2;
    players.forEach((p, i) => store.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`, [id, p, i < perSide ? 1 : 2]));
    return id;
}

async function main() {
    await store.init();
    SESSION = store.insert(`INSERT INTO sessions (date, label, status, mode, current_phase, record_results) VALUES ('2026-07-01', 'Test night', 'open', 'manual', 'idle', 1)`);
    court = store.insert('INSERT INTO courts (court_number, is_active) VALUES (31, 1)');
    store.run('INSERT INTO session_courts (session_id, court_id, in_use) VALUES (?, ?, 1)', [SESSION, court]);
    for (let i = 0; i < 4; i++) {
        ids.push(store.insert(`INSERT INTO players (first_name, last_name, skill_level, gender, membership_status) VALUES (?, 'Test', 'C', 'M', 'active')`, [`P${i}`]));
    }
    const [a, b, c, d] = ids;

    await test('the club setting and the per-night flag exist and default to off', async () => {
        assert.strictEqual(store.queryOne('SELECT record_results FROM club_settings WHERE id = 1').record_results, 0);
        const s = store.insert(`INSERT INTO sessions (date, label, status, mode, current_phase) VALUES ('2026-07-02', 'Plain', 'closed', 'manual', 'idle')`);
        assert.strictEqual(store.queryOne('SELECT record_results FROM sessions WHERE id = ?', [s]).record_results, 0);
    });

    let g1;
    await test('a winner is recorded for a played game, and can be changed or cleared', async () => {
        g1 = addGame(1, 'completed', [a, b, c, d]);
        assert.strictEqual(resultFor(g1), null);
        const r = recordResult(g1, { winner_side: 1 });
        assert.deepStrictEqual([r.winner_side, r.side1_score, r.side2_score], [1, null, null]);
        recordResult(g1, { winner_side: 2 });
        assert.strictEqual(resultFor(g1).winner_side, 2);
        clearResult(g1);
        assert.strictEqual(resultFor(g1), null);
    });

    await test('scores are optional; two different scores decide the winner, and must agree with one given', async () => {
        const r = recordResult(g1, { side1_score: 21, side2_score: 18 });
        assert.deepStrictEqual([r.winner_side, r.side1_score, r.side2_score], [1, 21, 18]);
        assert.throws(() => recordResult(g1, { winner_side: 2, side1_score: 21, side2_score: 18 }), /disagree/);
        assert.throws(() => recordResult(g1, { side1_score: 15, side2_score: 15 }), /winner_side/);
        assert.throws(() => recordResult(g1, { winner_side: 1, side1_score: -1 }), /whole numbers/);
        assert.throws(() => recordResult(g1, { winner_side: 3 }), ResultError);
    });

    await test('only a game on court or played can have a result; threes never does', async () => {
        const staged = addGame(2, 'staged', [a, b, c, d]);
        assert.throws(() => recordResult(staged, { winner_side: 1 }), /on court or played/);
        const active = addGame(2, 'active', [a, b, c, d]);
        assert.strictEqual(recordResult(active, { winner_side: 1 }).winner_side, 1);
        const threes = addGame(3, 'completed', [a, b, c], 'threes');
        assert.throws(() => recordResult(threes, { winner_side: 1 }), /Threes/);
        assert.throws(() => recordResult(999999, { winner_side: 1 }), /not found/);
    });

    await test('a player\'s win-loss record counts their side, leaves out unrecorded and threes games', async () => {
        // g1: side 1 (a, b) won. active round-2 game: side 1 (a, b) won. Plus one unrecorded.
        addGame(4, 'completed', [c, d, a, b]); // a on side 2, no result
        assert.deepStrictEqual(playerRecord(a), { wins: 2, losses: 0, unrecorded: 1 });
        assert.deepStrictEqual(playerRecord(c), { wins: 0, losses: 2, unrecorded: 1 });
        assert.deepStrictEqual(playerRecord(a, { from: '2026-08-01' }), { wins: 0, losses: 0, unrecorded: 0 });
    });

    console.log(`\n${passed} results tests passed`);
}

main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* temp folder */ } });
