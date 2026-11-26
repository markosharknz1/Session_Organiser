const express = require('express');
const store = require('../db/store');
const { getNextRoundNumber } = require('../lib/roundLifecycle');

const router = express.Router();

// Consecutive rounds sat out, counting back from the most recent round that
// has actually been played (active or completed). A player who played the
// most recent round scores 0; one who missed the last two scores 2. Rounds
// that started before a player checked in don't count against them - someone
// who just walked in hasn't "sat out" anything yet.
function sitOutCounts(sessionId, playerIds) {
    const rounds = store.query(
        `SELECT round_number, MIN(created_at) AS started_at
         FROM games WHERE session_id = ? AND status IN ('active','completed')
         GROUP BY round_number ORDER BY round_number DESC`,
        [sessionId]
    );

    const counts = new Map(playerIds.map((id) => [id, 0]));
    if (rounds.length === 0) return counts;

    const checkedInAt = new Map(store.query(
        `SELECT player_id, MIN(checked_in_at) AS t FROM attendance WHERE session_id = ? GROUP BY player_id`,
        [sessionId]
    ).map((r) => [r.player_id, r.t]));

    const playedByRound = new Map();
    for (const { round_number } of rounds) {
        const played = store.query(
            `SELECT DISTINCT gp.player_id FROM games g JOIN game_players gp ON gp.game_id = g.id
             WHERE g.session_id = ? AND g.round_number = ? AND g.status IN ('active','completed')`,
            [sessionId, round_number]
        ).map((r) => r.player_id);
        playedByRound.set(round_number, new Set(played));
    }

    for (const id of playerIds) {
        let streak = 0;
        for (const { round_number, started_at } of rounds) {
            if (playedByRound.get(round_number).has(id)) break;
            const arrival = checkedInAt.get(id);
            if (arrival && arrival > started_at) break; // round started before they arrived
            streak++;
        }
        counts.set(id, streak);
    }
    return counts;
}

// Everything the kiosk needs in one request: session/phase, active games per
// court, and the waiting pool with sit-out streaks.
router.get('/sessions/:id/display', (req, res) => {
    const sessionId = Number(req.params.id);
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const club = store.queryOne('SELECT club_name, default_break_minutes FROM club_settings WHERE id = 1');
    const breakMinutes = session.break_minutes ?? (club ? club.default_break_minutes : 3);

    const courts = store.query(
        `SELECT sc.court_id, c.court_number, c.label
         FROM session_courts sc JOIN courts c ON c.id = sc.court_id
         WHERE sc.session_id = ? AND sc.in_use = 1 ORDER BY c.court_number`,
        [sessionId]
    );

    const activeGames = store.query(
        `SELECT g.id, g.court_id, g.round_number, g.format FROM games g
         WHERE g.session_id = ? AND g.status = 'active' ORDER BY g.court_id`,
        [sessionId]
    ).map((g) => ({
        ...g,
        players: store.query(
            `SELECT gp.player_id, gp.side, gp.skill_level_at_time, p.first_name, p.last_name
             FROM game_players gp JOIN players p ON p.id = gp.player_id
             WHERE gp.game_id = ? ORDER BY gp.side, p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`,
            [g.id]
        ),
    }));

    // While there's no round actually on court (break, awaiting_lineup, or
    // before round 1 starts), show whatever's already staged for the next
    // round - lets players walk straight to their next court the moment the
    // break ends instead of waiting around for the lineup to be announced.
    let nextRoundGames = [];
    if (session.current_phase !== 'game') {
        const nextRound = getNextRoundNumber(sessionId);
        nextRoundGames = store.query(
            `SELECT g.id, g.court_id, g.round_number, g.format FROM games g
             WHERE g.session_id = ? AND g.round_number = ? AND g.status = 'staged' ORDER BY g.court_id`,
            [sessionId, nextRound]
        ).map((g) => ({
            ...g,
            players: store.query(
                `SELECT gp.player_id, gp.side, gp.skill_level_at_time, p.first_name, p.last_name
                 FROM game_players gp JOIN players p ON p.id = gp.player_id
                 WHERE gp.game_id = ? ORDER BY gp.side, p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`,
                [g.id]
            ),
        }));
    }

    // Staging a round doesn't change attendance.state (by design - see
    // routes/games.js), so anyone already staged into next_round_games
    // above is still 'here_today' too. Without excluding them, "Resting"
    // showed the exact same people already labeled "Up next" on a court -
    // not actually resting, just not on court *yet*.
    const assignedNextRoundIds = new Set(nextRoundGames.flatMap((g) => g.players.map((p) => p.player_id)));
    const waiting = store.query(
        `SELECT a.player_id, p.first_name, p.last_name, p.skill_level
         FROM attendance a JOIN players p ON p.id = a.player_id
         WHERE a.session_id = ? AND a.state = 'here_today'
         ORDER BY p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`,
        [sessionId]
    ).filter((w) => !assignedNextRoundIds.has(w.player_id));
    const counts = sitOutCounts(sessionId, waiting.map((w) => w.player_id));

    res.json({
        club_name: club ? club.club_name : 'Game Scheduler',
        session: {
            id: session.id,
            label: session.label,
            date: session.date,
            mode: session.mode,
            status: session.status,
            current_phase: session.current_phase,
            phase_started_at: session.phase_started_at,
            phase_ends_at: session.phase_ends_at,
            paused_from_phase: session.paused_from_phase,
            paused_remaining_ms: session.paused_remaining_ms,
            break_minutes: breakMinutes,
        },
        courts,
        active_games: activeGames,
        next_round_games: nextRoundGames,
        waiting: waiting.map((w) => ({ ...w, sit_out_count: counts.get(w.player_id) })),
    });
});

module.exports = router;
