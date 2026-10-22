// Game results - who won each court's match - the optional extra behind
// Settings > Game defaults > "Record game results" and the per-night tick
// on the start panel. A match is one court for one timed round; inside it
// the players may get through one game or several, each with its own
// score, so a result is a winner plus any number of game scores. Nothing
// here changes a grade or feeds auto-generate; it is evidence for the
// club's own grading decisions.
const store = require('../db/store');

class ResultError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const toScore = (v) => {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 0) {
        throw new ResultError(400, 'scores must be whole numbers, 0 or more');
    }
    return n;
};

// Accepts scores as [[21, 18], [19, 21]] or [{ side1_score, side2_score }],
// plus the older single-game side1_score / side2_score pair.
function parseScores(body) {
    let raw = body.scores;
    if (raw === undefined || raw === null) {
        const has1 = body.side1_score !== undefined && body.side1_score !== null && body.side1_score !== '';
        const has2 = body.side2_score !== undefined && body.side2_score !== null && body.side2_score !== '';
        if (has1 !== has2) throw new ResultError(400, 'give both sides\' scores for a game, or neither');
        raw = has1 ? [[body.side1_score, body.side2_score]] : [];
    }
    if (!Array.isArray(raw)) throw new ResultError(400, 'scores must be a list of games');
    if (raw.length > 20) throw new ResultError(400, 'at most 20 games in one match');
    return raw.map((g) => {
        const pair = Array.isArray(g) ? g : [g && g.side1_score, g && g.side2_score];
        return [toScore(pair[0]), toScore(pair[1])];
    });
}

// Who the scores say won: more games, then more points, else nobody (null).
function impliedWinner(scores) {
    if (!scores.length) return null;
    let g1 = 0; let g2 = 0; let p1 = 0; let p2 = 0;
    for (const [a, b] of scores) {
        if (a > b) g1++; else if (b > a) g2++;
        p1 += a; p2 += b;
    }
    if (g1 !== g2) return g1 > g2 ? 1 : 2;
    if (p1 !== p2) return p1 > p2 ? 1 : 2;
    return null;
}

// Records (or replaces) the result of a match that has been played or is on
// court. winner_side may be left out when the scores decide it.
function recordResult(gameId, body = {}) {
    const game = store.queryOne('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    if (!['active', 'completed'].includes(game.status)) throw new ResultError(409, 'A result can only be recorded once the game is on court or played');
    if (game.format === 'threes') throw new ResultError(400, 'Threes has no sides - results are not recorded for it');

    const scores = parseScores(body);
    const implied = impliedWinner(scores);
    let winner = body.winner_side === null || body.winner_side === undefined || body.winner_side === '' ? null : Number(body.winner_side);
    if (winner === null) winner = implied;
    if (winner !== 1 && winner !== 2) {
        throw new ResultError(400, scores.length ? 'the scores are level - say which side won' : 'winner_side must be 1 or 2 (or give the scores)');
    }
    if (implied !== null && implied !== winner) throw new ResultError(400, 'the scores and the winner disagree');

    store.run(
        `INSERT INTO game_results (game_id, winner_side, side1_score, side2_score, recorded_at) VALUES (?, ?, NULL, NULL, datetime('now'))
         ON CONFLICT(game_id) DO UPDATE SET winner_side = excluded.winner_side, side1_score = NULL, side2_score = NULL, recorded_at = excluded.recorded_at`,
        [gameId, winner]
    );
    store.run('DELETE FROM game_scores WHERE game_id = ?', [gameId]);
    scores.forEach(([a, b], i) => store.run('INSERT INTO game_scores (game_id, game_no, side1_score, side2_score) VALUES (?, ?, ?, ?)', [gameId, i + 1, a, b]));
    return resultFor(gameId);
}

function clearResult(gameId) {
    const game = store.queryOne('SELECT id FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    store.run('DELETE FROM game_scores WHERE game_id = ?', [gameId]);
    store.run('DELETE FROM game_results WHERE game_id = ?', [gameId]);
}

// { winner_side, scores: [[21, 18], ...], recorded_at } or null.
function resultFor(gameId) {
    const row = store.queryOne('SELECT winner_side, side1_score, side2_score, recorded_at FROM game_results WHERE game_id = ?', [gameId]);
    if (!row) return null;
    let scores = store.query('SELECT side1_score, side2_score FROM game_scores WHERE game_id = ? ORDER BY game_no', [gameId]).map((s) => [s.side1_score, s.side2_score]);
    // a result saved before scores were per game
    if (!scores.length && row.side1_score !== null && row.side2_score !== null) scores = [[row.side1_score, row.side2_score]];
    return { winner_side: row.winner_side, scores, recorded_at: row.recorded_at };
}

// Win-loss record for one player over an optional date range: matches with
// a result they were on the winning / losing side of, and matches played
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

module.exports = { ResultError, recordResult, clearResult, resultFor, playerRecord, impliedWinner };
