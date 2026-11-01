// Game results - who won each court's match - the optional extra behind
// Settings > Game defaults > "Record game results" and the per-night tick
// on the start panel. A match is one court for one timed round; inside it
// the players may get through one game or several, each with its own
// score, so a result is a winner plus any number of game scores.
//
// Doubles and singles have two sides: scores are [side1, side2] per game
// and the winner is a side. Threes (three in a squash box) has no sides:
// each game is between two of the three players, scores are
// { a, b, score_a, score_b } (player ids), and the winner is the player who
// won the most games in the box.
//
// Nothing here changes a grade or feeds auto-generate; it is evidence for
// the club's own grading decisions.
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
const MAX_GAMES = 20;

// --- sided formats (doubles, singles) ---

// Accepts scores as [[21, 18], [19, 21]] or [{ side1_score, side2_score }],
// plus the older single-game side1_score / side2_score pair.
function parseSidedScores(body) {
    let raw = body.scores;
    if (raw === undefined || raw === null) {
        const has1 = body.side1_score !== undefined && body.side1_score !== null && body.side1_score !== '';
        const has2 = body.side2_score !== undefined && body.side2_score !== null && body.side2_score !== '';
        if (has1 !== has2) throw new ResultError(400, 'give both sides\' scores for a game, or neither');
        raw = has1 ? [[body.side1_score, body.side2_score]] : [];
    }
    if (!Array.isArray(raw)) throw new ResultError(400, 'scores must be a list of games');
    if (raw.length > MAX_GAMES) throw new ResultError(400, `at most ${MAX_GAMES} games in one match`);
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

// --- threes ---

function parseThreesScores(body, playerIds) {
    const raw = body.scores === undefined || body.scores === null ? [] : body.scores;
    if (!Array.isArray(raw)) throw new ResultError(400, 'scores must be a list of games');
    if (raw.length > MAX_GAMES) throw new ResultError(400, `at most ${MAX_GAMES} games in one match`);
    return raw.map((g) => {
        const a = Number(g && g.a); const b = Number(g && g.b);
        if (!playerIds.includes(a) || !playerIds.includes(b) || a === b) throw new ResultError(400, 'each game in a threes box is between two of its three players');
        return { a, b, score_a: toScore(g.score_a), score_b: toScore(g.score_b) };
    });
}

// Who the box's scores say won: most games won, then best points
// difference, else nobody (null).
function impliedThreesWinner(scores, playerIds) {
    if (!scores.length) return null;
    const games = new Map(playerIds.map((id) => [id, 0]));
    const diff = new Map(playerIds.map((id) => [id, 0]));
    for (const g of scores) {
        if (g.score_a > g.score_b) games.set(g.a, games.get(g.a) + 1);
        else if (g.score_b > g.score_a) games.set(g.b, games.get(g.b) + 1);
        diff.set(g.a, diff.get(g.a) + g.score_a - g.score_b);
        diff.set(g.b, diff.get(g.b) + g.score_b - g.score_a);
    }
    const ranked = playerIds.slice().sort((x, y) => games.get(y) - games.get(x) || diff.get(y) - diff.get(x));
    const [first, second] = ranked;
    if (games.get(first) === games.get(second) && diff.get(first) === diff.get(second)) return null;
    return first;
}

// Records (or replaces) the result of a match that has been played or is on
// court. The winner may be left out when the scores decide it.
function recordResult(gameId, body = {}) {
    const game = store.queryOne('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    if (!['active', 'completed'].includes(game.status)) throw new ResultError(409, 'A result can only be recorded once the game is on court or played');

    let winnerSide = null; let winnerPlayer = null; let rows;
    if (game.format === 'threes') {
        const playerIds = store.query('SELECT player_id FROM game_players WHERE game_id = ?', [gameId]).map((r) => r.player_id);
        const scores = parseThreesScores(body, playerIds);
        const implied = impliedThreesWinner(scores, playerIds);
        winnerPlayer = body.winner_player_id === null || body.winner_player_id === undefined || body.winner_player_id === '' ? null : Number(body.winner_player_id);
        if (winnerPlayer === null) winnerPlayer = implied;
        if (!playerIds.includes(winnerPlayer)) {
            throw new ResultError(400, scores.length ? 'the box is level - say who won' : 'winner_player_id must be one of the three players (or give the scores)');
        }
        if (implied !== null && implied !== winnerPlayer) throw new ResultError(400, 'the scores and the winner disagree');
        rows = scores.map((g) => [g.a, g.b, g.score_a, g.score_b]);
    } else {
        const scores = parseSidedScores(body);
        const implied = impliedWinner(scores);
        winnerSide = body.winner_side === null || body.winner_side === undefined || body.winner_side === '' ? null : Number(body.winner_side);
        if (winnerSide === null) winnerSide = implied;
        if (winnerSide !== 1 && winnerSide !== 2) {
            throw new ResultError(400, scores.length ? 'the scores are level - say which side won' : 'winner_side must be 1 or 2 (or give the scores)');
        }
        if (implied !== null && implied !== winnerSide) throw new ResultError(400, 'the scores and the winner disagree');
        rows = scores.map(([a, b]) => [null, null, a, b]);
    }

    store.run(
        `INSERT INTO game_results (game_id, winner_side, winner_player_id, side1_score, side2_score, recorded_at) VALUES (?, ?, ?, NULL, NULL, datetime('now'))
         ON CONFLICT(game_id) DO UPDATE SET winner_side = excluded.winner_side, winner_player_id = excluded.winner_player_id, side1_score = NULL, side2_score = NULL, recorded_at = excluded.recorded_at`,
        [gameId, winnerSide, winnerPlayer]
    );
    store.run('DELETE FROM game_scores WHERE game_id = ?', [gameId]);
    rows.forEach(([p1, p2, s1, s2], i) => store.run(
        'INSERT INTO game_scores (game_id, game_no, player1_id, player2_id, side1_score, side2_score) VALUES (?, ?, ?, ?, ?, ?)',
        [gameId, i + 1, p1, p2, s1, s2]
    ));
    return resultFor(gameId);
}

function clearResult(gameId) {
    const game = store.queryOne('SELECT id FROM games WHERE id = ?', [gameId]);
    if (!game) throw new ResultError(404, 'Game not found');
    store.run('DELETE FROM game_scores WHERE game_id = ?', [gameId]);
    store.run('DELETE FROM game_results WHERE game_id = ?', [gameId]);
}

// Sided: { winner_side, scores: [[21, 18], ...] }. Threes:
// { winner_player_id, scores: [{ a, b, score_a, score_b }, ...] }. Null
// until recorded.
function resultFor(gameId) {
    const row = store.queryOne('SELECT winner_side, winner_player_id, side1_score, side2_score, recorded_at FROM game_results WHERE game_id = ?', [gameId]);
    if (!row) return null;
    const games = store.query('SELECT player1_id, player2_id, side1_score, side2_score FROM game_scores WHERE game_id = ? ORDER BY game_no', [gameId]);
    let scores;
    if (row.winner_player_id) {
        scores = games.map((g) => ({ a: g.player1_id, b: g.player2_id, score_a: g.side1_score, score_b: g.side2_score }));
    } else {
        scores = games.map((g) => [g.side1_score, g.side2_score]);
        // a result saved before scores were per game
        if (!scores.length && row.side1_score !== null && row.side2_score !== null) scores = [[row.side1_score, row.side2_score]];
    }
    return { winner_side: row.winner_side, winner_player_id: row.winner_player_id, scores, recorded_at: row.recorded_at };
}

// Win-loss record for one player over an optional date range: matches
// (or threes boxes) with a result they won / lost, and matches played
// that have no result yet.
function playerRecord(playerId, { from, to } = {}) {
    const params = [playerId];
    let dateFilter = '';
    if (from) { dateFilter += ' AND s.date >= ?'; params.push(from); }
    if (to) { dateFilter += ' AND s.date <= ?'; params.push(to); }
    const row = store.queryOne(
        `SELECT
            SUM(CASE WHEN r.winner_side = gp.side OR r.winner_player_id = gp.player_id THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN r.game_id IS NOT NULL AND NOT (COALESCE(r.winner_side = gp.side, 0) OR COALESCE(r.winner_player_id = gp.player_id, 0)) THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN r.game_id IS NULL THEN 1 ELSE 0 END) AS unrecorded
         FROM game_players gp
         JOIN games g ON g.id = gp.game_id
         JOIN sessions s ON s.id = g.session_id
         LEFT JOIN game_results r ON r.game_id = g.id
         WHERE gp.player_id = ? AND g.status IN ('active','completed')${dateFilter}`,
        params
    );
    return { wins: row.wins || 0, losses: row.losses || 0, unrecorded: row.unrecorded || 0 };
}

// 'won' / 'lost' / null for one player in one game, from its result row.
function outcomeFor(result, side, playerId) {
    if (!result) return null;
    if (result.winner_player_id) return result.winner_player_id === playerId ? 'won' : 'lost';
    return result.winner_side === side ? 'won' : 'lost';
}

module.exports = { ResultError, recordResult, clearResult, resultFor, playerRecord, outcomeFor, impliedWinner, impliedThreesWinner };
