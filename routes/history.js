const express = require('express');
const store = require('../db/store');

const router = express.Router();

// Read-only audit trail over games/game_players. No writes here at all - the
// history is append-only for dispute purposes, so this router deliberately
// exposes no mutation routes. Uses skill_level_at_time (the snapshot taken
// when each game was created), not the player's current grade, so a later
// promotion/demotion never rewrites what happened.

// List of sessions with summary counts, for the history landing page.
router.get('/sessions', (req, res) => {
    const sessions = store.query(
        `SELECT s.id, s.date, s.label, s.mode, s.status, s.template_id, s.scheduled_start_time,
                (SELECT COUNT(DISTINCT a.player_id) FROM attendance a WHERE a.session_id = s.id) AS players_checked_in,
                (SELECT COUNT(DISTINCT g.round_number) FROM games g WHERE g.session_id = s.id AND g.status IN ('active','completed')) AS rounds_played,
                (SELECT COUNT(*) FROM games g WHERE g.session_id = s.id AND g.status IN ('active','completed')) AS games_played
         FROM sessions s
         ORDER BY s.date DESC, s.id DESC`
    );
    res.json(sessions);
});

// Full round-by-round breakdown of one session.
router.get('/sessions/:id', (req, res) => {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // started_at is when the round actually went on court; rounds from
    // before that column existed fall back to when the game was created.
    const games = store.query(
        `SELECT g.id, g.court_id, g.round_number, g.format, g.status, g.mode, c.court_number,
                COALESCE(g.started_at, g.created_at) AS started_at
         FROM games g JOIN courts c ON c.id = g.court_id
         WHERE g.session_id = ? AND g.status IN ('active','completed')
         ORDER BY g.round_number, c.court_number`,
        [req.params.id]
    );
    const gamesWithPlayers = games.map((g) => ({
        ...g,
        players: store.query(
            `SELECT gp.player_id, gp.side, gp.skill_level_at_time, p.first_name, p.last_name
             FROM game_players gp JOIN players p ON p.id = gp.player_id
             WHERE gp.game_id = ? ORDER BY gp.side, p.last_name`,
            [g.id]
        ),
    }));

    // Group into rounds for easy rendering.
    const rounds = [];
    for (const g of gamesWithPlayers) {
        let round = rounds.find((r) => r.round_number === g.round_number);
        if (!round) {
            round = { round_number: g.round_number, started_at: g.started_at, games: [] };
            rounds.push(round);
        }
        if (g.started_at < round.started_at) round.started_at = g.started_at;
        round.games.push(g);
    }

    res.json({ session, rounds });
});

// How many games each player present tonight has had - the fairness
// check staff want while building a round. Least-played first; a player
// currently on court is included (their live game counts).
router.get('/sessions/:id/games-per-player', (req, res) => {
    const session = store.queryOne('SELECT id FROM sessions WHERE id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const rows = store.query(
        `SELECT p.id AS player_id, p.first_name, p.last_name, p.skill_level, p.gender, a.state,
                (SELECT COUNT(*) FROM game_players gp JOIN games g ON g.id = gp.game_id
                 WHERE gp.player_id = p.id AND g.session_id = a.session_id AND g.status IN ('active','completed')) AS games_played
         FROM attendance a JOIN players p ON p.id = a.player_id
         WHERE a.session_id = ? AND a.state IN ('here_today','playing')
         ORDER BY games_played ASC, p.last_name, p.first_name`,
        [req.params.id]
    );
    res.json(rows);
});

// Every game a specific player appeared in, across all sessions - answers
// "what grade were they officially at when this game was played". Optional
// date range narrows it.
router.get('/players/:id', (req, res) => {
    const player = store.queryOne('SELECT * FROM players WHERE id = ?', [req.params.id]);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const { from, to } = req.query;
    const params = [req.params.id];
    let dateFilter = '';
    if (from) { dateFilter += ' AND s.date >= ?'; params.push(from); }
    if (to) { dateFilter += ' AND s.date <= ?'; params.push(to); }

    const games = store.query(
        `SELECT g.id AS game_id, g.round_number, g.format, g.status, g.mode,
                s.id AS session_id, s.date, s.label, c.court_number,
                gp.side, gp.skill_level_at_time
         FROM game_players gp
         JOIN games g ON g.id = gp.game_id
         JOIN sessions s ON s.id = g.session_id
         JOIN courts c ON c.id = g.court_id
         WHERE gp.player_id = ? AND g.status IN ('active','completed')${dateFilter}
         ORDER BY s.date DESC, g.round_number DESC`,
        params
    );

    // For each game, also fetch the other three players and which were
    // partners vs opponents - the actual detail a grading dispute needs.
    const detailed = games.map((g) => {
        const others = store.query(
            `SELECT gp.player_id, gp.side, gp.skill_level_at_time, p.first_name, p.last_name
             FROM game_players gp JOIN players p ON p.id = gp.player_id
             WHERE gp.game_id = ? AND gp.player_id != ?`,
            [g.game_id, req.params.id]
        );
        // "Threes" has no sides: the other two on the court are both
        // people this player played against, in turn.
        const unsided = g.format === 'threes';
        return {
            ...g,
            partners: unsided ? [] : others.filter((o) => o.side === g.side),
            opponents: unsided ? others : others.filter((o) => o.side !== g.side),
        };
    });

    res.json({ player, games: detailed });
});

module.exports = router;
