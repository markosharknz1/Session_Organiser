// What happens to the courts ahead when a player leaves (or says they're
// leaving after a given round). Games that are on court or already played
// are never touched - only staged ones, the rounds still being built.
const store = require('../db/store');

const FORMAT_SIZES = { singles: 2, doubles: 4, threes: 3 };

// Takes the player off every staged game in the session after
// `afterRound` (0 = all of them), leaving a game_vacancies row behind each
// time so the Rounds page can show whose place needs filling. Returns how
// many courts were affected.
function vacateStagedGames(sessionId, playerId, afterRound = 0) {
    const staged = store.query(
        `SELECT gp.game_id, gp.side FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.player_id = ? AND g.session_id = ? AND g.status = 'staged' AND g.round_number > ?`,
        [playerId, sessionId, afterRound]
    );
    for (const row of staged) {
        store.run('DELETE FROM game_players WHERE game_id = ? AND player_id = ?', [row.game_id, playerId]);
        store.run('INSERT OR REPLACE INTO game_vacancies (game_id, player_id, side) VALUES (?, ?, ?)', [row.game_id, playerId, row.side]);
    }
    return staged.length;
}

// "Break for 1 game": off whatever is staged for that one round only, the
// place remembered the same way.
function vacateStagedRound(sessionId, playerId, round) {
    const staged = store.query(
        `SELECT gp.game_id, gp.side FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.player_id = ? AND g.session_id = ? AND g.status = 'staged' AND g.round_number = ?`,
        [playerId, sessionId, round]
    );
    for (const row of staged) {
        store.run('DELETE FROM game_players WHERE game_id = ? AND player_id = ?', [row.game_id, playerId]);
        store.run('INSERT OR REPLACE INTO game_vacancies (game_id, player_id, side) VALUES (?, ?, ?)', [row.game_id, playerId, row.side]);
    }
    return staged.length;
}

// Drops the "their place" markers for a player in a session (they are
// staying after all / back in play).
function clearVacanciesFor(sessionId, playerId, round = null) {
    const rows = store.query(
        `SELECT gv.game_id FROM game_vacancies gv JOIN games g ON g.id = gv.game_id
         WHERE gv.player_id = ? AND g.session_id = ? ${round ? 'AND g.round_number = ?' : ''}`,
        round ? [playerId, sessionId, round] : [playerId, sessionId]
    );
    for (const row of rows) store.run('DELETE FROM game_vacancies WHERE game_id = ? AND player_id = ?', [row.game_id, playerId]);
    return rows.length;
}

// Called after a staged game's lineup is saved: once the court is full
// again there is nothing left to flag. A vacancy for someone who is back
// on the court is dropped either way.
function settleVacancies(gameId) {
    const game = store.queryOne('SELECT format FROM games WHERE id = ?', [gameId]);
    if (!game) return;
    const count = store.queryOne('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?', [gameId]).n;
    if (count >= FORMAT_SIZES[game.format]) {
        store.run('DELETE FROM game_vacancies WHERE game_id = ?', [gameId]);
    } else {
        store.run(
            'DELETE FROM game_vacancies WHERE game_id = ? AND player_id IN (SELECT player_id FROM game_players WHERE game_id = ?)',
            [gameId, gameId]
        );
    }
}

// "Plays every 2nd game": once a round is on court, everyone in it who is
// alternating tonight sits out the next round. It uses the same marker as
// "Break for 1 game" (attendance.rest_round), so every page, the lineup
// check and auto-generate treat it the same way, the round-end clears it
// the same way, and "Back in play" overrides it for a night. Returns the
// player ids rested.
function restAlternatesAfterRound(sessionId, roundNumber) {
    const next = roundNumber + 1;
    const rows = store.query(
        `SELECT DISTINCT a.player_id FROM attendance a
         JOIN game_players gp ON gp.player_id = a.player_id
         JOIN games g ON g.id = gp.game_id
         WHERE a.session_id = ? AND a.alternate_rounds = 1 AND a.state != 'left'
           AND g.session_id = ? AND g.round_number = ? AND g.status IN ('active', 'completed')`,
        [sessionId, sessionId, roundNumber]
    );
    for (const r of rows) {
        store.run(`UPDATE attendance SET rest_round = ? WHERE session_id = ? AND player_id = ? AND state != 'left'`, [next, sessionId, r.player_id]);
        vacateStagedRound(sessionId, r.player_id, next);
    }
    return rows.map((r) => r.player_id);
}

module.exports = { vacateStagedGames, vacateStagedRound, clearVacanciesFor, settleVacancies, restAlternatesAfterRound };
