// Game results - who won each game - the optional extra behind Settings >
// Game defaults > "Record game results" and the per-night tick on the
// start panel. Phase 1: a winner per game (scores optional), shown in
// History and as a win-loss record on the player's page. Nothing here
// changes a grade or feeds auto-generate; it is evidence for the club's
// own grading decisions.
const store = require('../db/store');

class ResultError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const toScore = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new ResultError(400, 'scores must be whole numbers, 0 or more');
    return n;
};

// Records (or replaces) the result of a game that has been played or is on
// court. winner_side may be left out when both scores are given and differ.
function recordResult(gameId, body = {}) {
    const game = store.queryOne('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    if (!['active', 'completed'].includes(game.status)) throw new ResultError(409, 'A result can only be recorded once the game is on court or played');
    if (game.format === 'threes') throw new ResultError(400, 'Threes has no sides - results are not recorded for it');

    const side1 = toScore(body.side1_score);
    const side2 = toScore(body.side2_score);
    let winner = body.winner_side === null || body.winner_side === undefined || body.winner_side === '' ? null : Number(body.winner_side);
    if (winner === null && side1 !== null && side2 !== null && side1 !== side2) winner = side1 > side2 ? 1 : 2;
    if (winner !== 1 && winner !== 2) throw new ResultError(400, 'winner_side must be 1 or 2 (or give two different scores)');
    if (side1 !== null && side2 !== null && side1 !== side2 && (side1 > side2 ? 1 : 2) !== winner) {
        throw new ResultError(400, 'the scores and the winner disagree');
    }

    store.run(
        `INSERT INTO game_results (game_id, winner_side, side1_score, side2_score, recorded_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(game_id) DO UPDATE SET winner_side = excluded.winner_side, side1_score = excluded.side1_score, side2_score = excluded.side2_score, recorded_at = excluded.recorded_at`,
        [gameId, winner, side1, side2]
    );
    return resultFor(gameId);
}

function clearResult(gameId) {
    const game = store.queryOne('SELECT id FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    store.run('DELETE FROM game_results WHERE game_id = ?', [gameId]);
}

function resultFor(gameId) {
    return store.queryOne('SELECT winner_side, side1_score, side2_score, recorded_at FROM game_results WHERE game_id = ?', [gameId]) || null;
}

// Win-loss record for one player over an optional date range: games with a
// result they were on the winning / losing side of, and games played
// (sided formats only) that have no result yet.
function playerRecord(playerId, { from, to } = {}) {
    const params = [playerId];
    let dateFilter = '';
    if (from) { dateFilter += ' AND s.date >= ?'; params.push(from); }
    if (to) { dateFilter += ' AND s.date <= ?'; params.push(to); }
    const row = store.queryOne(
        `SELECT
            SUM(CASE WHEN r.winner_side = gp.side THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN r.winner_side IS NOT NULL AND r.winner_side != gp.side THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN r.winner_side IS NULL THEN 1 ELSE 0 END) AS unrecorded
         FROM game_players gp
         JOIN games g ON g.id = gp.game_id
         JOIN sessions s ON s.id = g.session_id
         LEFT JOIN game_results r ON r.game_id = g.id
         WHERE gp.player_id = ? AND g.status IN ('active','completed') AND g.format != 'threes'${dateFilter}`,
        params
    );
    return { wins: row.wins || 0, losses: row.losses || 0, unrecorded: row.unrecorded || 0 };
}

module.exports = { ResultError, recordResult, clearResult, resultFor, playerRecord };
