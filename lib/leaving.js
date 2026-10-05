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

module.exports = { vacateStagedGames, settleVacancies };
