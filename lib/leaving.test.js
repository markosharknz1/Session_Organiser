// A player leaving, against the real store in a throwaway folder (same
// GAME_SCHEDULER_* overrides as the backup tests, so nothing here can touch
// the club's database or backups).
// Run: node lib/leaving.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-leaving-test-'));
process.env.GAME_SCHEDULER_DB_PATH = path.join(ROOT, 'app', 'game_scheduler.db');
process.env.GAME_SCHEDULER_BACKUP_DIR = path.join(ROOT, 'backups');
process.env.GAME_SCHEDULER_PUBLIC_DIR = path.join(ROOT, 'app', 'public');
fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true });

const store = require('../db/store');
const { vacateStagedGames, settleVacancies } = require('./leaving');
const { endGamePhase } = require('./roundLifecycle');
const { generateRound } = require('./autoGenerate');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

let SESSION;
const playerIds = [];

function addGame(court, round, status, players) {
    const id = store.insert(
        `INSERT INTO games (session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, 'doubles', 'manual', ?)`,
        [SESSION, court, round, status]
    );
    players.forEach((p, i) => store.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`, [id, p, i < 2 ? 1 : 2]));
    return id;
}
const onCourt = (gameId) => store.query('SELECT player_id FROM game_players WHERE game_id = ? ORDER BY player_id', [gameId]).map((r) => r.player_id);
const vacancies = (gameId) => store.query('SELECT player_id, side FROM game_vacancies WHERE game_id = ? ORDER BY player_id', [gameId]);
const stateOf = (playerId) => store.queryOne('SELECT state, left_reason, leave_after_round FROM attendance WHERE session_id = ? AND player_id = ?', [SESSION, playerId]);

async function main() {
    await store.init();
    SESSION = store.insert(`INSERT INTO sessions (date, label, status, mode, current_phase) VALUES ('2026-07-01', 'Test night', 'open', 'manual', 'idle')`);
    const courts = [1, 2].map((n) => {
        const id = store.insert('INSERT INTO courts (court_number, is_active) VALUES (?, 1)', [30 + n]);
        store.run('INSERT INTO session_courts (session_id, court_id, in_use) VALUES (?, ?, 1)', [SESSION, id]);
        return id;
    });
    for (let i = 0; i < 9; i++) {
        const id = store.insert(`INSERT INTO players (first_name, last_name, skill_level, gender, membership_status) VALUES (?, 'Test', 'C', 'M', 'active')`, [`P${i}`]);
        store.run(`INSERT INTO attendance (session_id, player_id, state) VALUES (?, ?, 'here_today')`, [SESSION, id]);
        playerIds.push(id);
    }
    const [a, b, c, d, e, f, g, h, spare] = playerIds;

    let active, next, later;
    await test('leaving now: off every court not yet played, the place remembered; the court being played is untouched', async () => {
        active = addGame(courts[0], 1, 'active', [a, b, c, d]);
        next = addGame(courts[0], 2, 'staged', [a, b, c, d]);
        later = addGame(courts[1], 3, 'staged', [e, f, a, h]);
        assert.strictEqual(vacateStagedGames(SESSION, a, 0), 2);
        assert.deepStrictEqual(onCourt(active), [a, b, c, d]);
        assert.deepStrictEqual(onCourt(next), [b, c, d]);
        assert.deepStrictEqual(onCourt(later), [e, f, h]);
        assert.deepStrictEqual(vacancies(next), [{ player_id: a, side: 1 }]);
        assert.deepStrictEqual(vacancies(later), [{ player_id: a, side: 2 }]);
    });

    await test('a court saved still short keeps its red box; filled again, the box goes', async () => {
        settleVacancies(next);
        assert.strictEqual(vacancies(next).length, 1);
        store.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, 1, 'C')`, [next, spare]);
        settleVacancies(next);
        assert.strictEqual(vacancies(next).length, 0);
    });

    await test('leaving after round 2: keeps the round 2 court, comes off round 3', async () => {
        const r2 = addGame(courts[1], 2, 'staged', [e, f, g, h]);
        store.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, 2, 'C')`, [later, g]);
        store.run('UPDATE attendance SET leave_after_round = 2 WHERE session_id = ? AND player_id = ?', [SESSION, g]);
        assert.strictEqual(vacateStagedGames(SESSION, g, 2), 1);
        assert.ok(onCourt(r2).includes(g), 'still playing round 2');
        assert.ok(!onCourt(later).includes(g), 'off round 3');
        assert.deepStrictEqual(vacancies(later).map((v) => v.player_id).sort(), [a, g].sort());
    });

    await test('auto-generate leaves out anyone who will have gone by that round', async () => {
        store.run(`DELETE FROM game_players WHERE game_id = ?`, [later]);
        store.run(`DELETE FROM game_vacancies WHERE game_id = ?`, [later]);
        store.run(`DELETE FROM games WHERE id = ?`, [later]);
        const ids = (round) => generateRound(store.getDb(), SESSION, round).flatMap((gm) => gm.players.map((p) => p.player_id));
        assert.ok(!ids(3).includes(g), 'not in round 3');
        store.run('UPDATE attendance SET leave_after_round = 3 WHERE session_id = ? AND player_id = ?', [SESSION, g]);
        const pool3 = store.query(
            `SELECT player_id FROM attendance WHERE session_id = ? AND state IN ('here_today','playing') AND (leave_after_round IS NULL OR leave_after_round >= 3)`,
            [SESSION]
        ).map((r) => r.player_id);
        assert.ok(pool3.includes(g), 'available again if they are staying for round 3');
        store.run('UPDATE attendance SET leave_after_round = 2 WHERE session_id = ? AND player_id = ?', [SESSION, g]);
    });

    await test('when their last round ends they are marked as having left early - not before', async () => {
        store.run(`UPDATE sessions SET current_phase = 'game' WHERE id = ?`, [SESSION]);
        store.run(`UPDATE attendance SET state = 'playing' WHERE session_id = ? AND player_id IN (?, ?, ?, ?)`, [SESSION, a, b, c, d]);
        endGamePhase(SESSION); // round 1 ends
        assert.deepStrictEqual(stateOf(g), { state: 'here_today', left_reason: null, leave_after_round: 2 });

        store.run(`UPDATE games SET status = 'active' WHERE session_id = ? AND round_number = 2`, [SESSION]);
        store.run(`UPDATE attendance SET state = 'playing' WHERE session_id = ? AND player_id = ?`, [SESSION, g]);
        store.run(`UPDATE sessions SET current_phase = 'game' WHERE id = ?`, [SESSION]);
        endGamePhase(SESSION); // round 2 ends
        assert.deepStrictEqual(stateOf(g), { state: 'left', left_reason: 'departed', leave_after_round: null });
        assert.strictEqual(stateOf(e).state, 'here_today', 'everyone else carries on');
    });

    console.log(`\n${passed} leaving tests passed`);
}

main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* temp folder */ } });
