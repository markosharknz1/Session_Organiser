const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { getNextRoundNumber } = require('../lib/roundLifecycle');

const router = express.Router();

const FORMAT_SIZES = { singles: 2, doubles: 4 };

function gameWithPlayers(gameId) {
    const game = store.queryOne('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return null;
    // games_played: the player's games this session up to and including
    // this round (active/completed only, so a staged "up next" game shows
    // what they've had so far, a live one counts itself) - the "(3)" shown
    // beside each name on the Rounds page.
    const players = store.query(
        `SELECT gp.player_id, gp.side, gp.skill_level_at_time, p.first_name, p.last_name, p.gender,
                (SELECT COUNT(*) FROM game_players gp2 JOIN games g2 ON g2.id = gp2.game_id
                 WHERE gp2.player_id = gp.player_id AND g2.session_id = ? AND g2.round_number <= ?
                   AND g2.status IN ('active','completed')) AS games_played
         FROM game_players gp JOIN players p ON p.id = gp.player_id
         WHERE gp.game_id = ? ORDER BY gp.side, p.last_name`,
        [game.session_id, game.round_number, gameId]
    );
    return { ...game, players };
}

// Validates a proposed lineup against the schema rules and current session
// state. excludeGameIds lets an edit (PUT), or a batch of several courts
// saved together, validate against everyone else without tripping over
// its own (or the rest of the batch's) existing rows - a court/player
// genuinely being moved between two games in the SAME save isn't a real
// conflict, it just looks like one if the game(s) it's moving out of
// aren't excluded too.
function validateLineup({ sessionId, courtId, roundNumber, format, players, excludeGameIds = [] }) {
    const errors = [];

    if (!FORMAT_SIZES[format]) {
        errors.push(`format must be one of ${Object.keys(FORMAT_SIZES).join(', ')}`);
        return errors;
    }
    // A court being designed can be incomplete (1 up to expectedSize players)
    // while staged - it just can't start a round that way (see the
    // completeness gate in roundLifecycle's beginRound). Only a fully empty
    // request or one that overflows a side/court is rejected outright.
    const expectedSize = FORMAT_SIZES[format];
    if (!Array.isArray(players) || players.length < 1 || players.length > expectedSize) {
        errors.push(`${format} allows 1 to ${expectedSize} players while staging (needs all ${expectedSize} before the round can start)`);
        return errors;
    }
    if (!players.every((p) => p.side === 1 || p.side === 2)) {
        errors.push('every player must be assigned to side 1 or side 2');
        return errors;
    }
    const perSide = expectedSize / 2;
    const side1 = players.filter((p) => p.side === 1);
    const side2 = players.filter((p) => p.side === 2);
    if (side1.length > perSide || side2.length > perSide) {
        errors.push(`each side holds at most ${perSide} player${perSide > 1 ? 's' : ''}`);
    }
    const playerIds = players.map((p) => p.player_id);
    if (new Set(playerIds).size !== playerIds.length) {
        errors.push('a player cannot appear twice in the same game');
    }

    const nextRound = getNextRoundNumber(sessionId);
    if (!Number.isInteger(roundNumber) || roundNumber < nextRound) {
        errors.push(`round_number must be ${nextRound} or later (round ${nextRound} is the next unplayed round)`);
    }

    const courtInSession = store.queryOne(
        `SELECT * FROM session_courts WHERE session_id = ? AND court_id = ? AND in_use = 1`,
        [sessionId, courtId]
    );
    if (!courtInSession) errors.push('court_id is not an in-use court for this session');

    const excludeClause = excludeGameIds.length ? `AND id NOT IN (${excludeGameIds.map(() => '?').join(',')})` : '';
    const courtTaken = store.queryOne(
        `SELECT id FROM games WHERE session_id = ? AND court_id = ? AND round_number = ? AND status IN ('staged','active') ${excludeClause}`,
        [sessionId, courtId, roundNumber, ...excludeGameIds]
    );
    if (courtTaken) errors.push('a game is already staged/active on this court for this round');

    const doubleBookedExcludeClause = excludeGameIds.length ? `AND g.id NOT IN (${excludeGameIds.map(() => '?').join(',')})` : '';
    for (const playerId of playerIds) {
        const attendance = store.queryOne(
            `SELECT * FROM attendance WHERE session_id = ? AND player_id = ? AND state != 'left' ORDER BY id DESC LIMIT 1`,
            [sessionId, playerId]
        );
        if (!attendance) {
            errors.push(`player ${playerId} is not present in this session`);
            continue;
        }
        const doubleBooked = store.queryOne(
            `SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
             WHERE g.session_id = ? AND g.round_number = ? AND g.status IN ('staged','active') AND gp.player_id = ? ${doubleBookedExcludeClause}`,
            [sessionId, roundNumber, playerId, ...excludeGameIds]
        );
        if (doubleBooked) errors.push(`player ${playerId} is already assigned to another game in round ${roundNumber}`);
    }

    return errors;
}

function insertGame({ sessionId, courtId, roundNumber, format, players }) {
    const gameId = store.insert(
        `INSERT INTO games (session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'manual', 'staged')`,
        [sessionId, courtId, roundNumber, format]
    );
    for (const p of players) {
        const player = store.queryOne('SELECT skill_level FROM players WHERE id = ?', [p.player_id]);
        store.run(
            'INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, ?)',
            [gameId, p.player_id, p.side, player.skill_level]
        );
    }
    return gameId;
}

router.get('/sessions/:sessionId/games', (req, res) => {
    const { round_number, status } = req.query;
    let sql = 'SELECT id FROM games WHERE session_id = ?';
    const params = [req.params.sessionId];
    if (round_number) {
        sql += ' AND round_number = ?';
        params.push(round_number);
    }
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY round_number, court_id';
    const ids = store.query(sql, params).map((r) => r.id);
    res.json(ids.map(gameWithPlayers));
});

router.get('/games/:id', (req, res) => {
    const game = gameWithPlayers(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
});

router.post('/sessions/:sessionId/games', (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { court_id, round_number, format, players } = req.body;
    // validateLineup runs real queries with these fields as bind params - a
    // malformed/missing field (e.g. no round_number) can throw there rather
    // than cleanly failing validation, so it's inside the same try/catch as
    // the write, not called separately above it.
    try {
        const errors = validateLineup({ sessionId, courtId: court_id, roundNumber: round_number, format, players: players || [] });
        if (errors.length) return res.status(400).json({ errors });

        const gameId = insertGame({ sessionId, courtId: court_id, roundNumber: round_number, format, players });
        store.persist();
        broadcast('game', { session_id: sessionId });
        res.status(201).json(gameWithPlayers(gameId));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/games/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Game not found' });
    if (existing.status !== 'staged') return res.status(409).json({ error: 'Only staged games can be edited' });

    const court_id = req.body.court_id ?? existing.court_id;
    const round_number = req.body.round_number ?? existing.round_number;
    const format = req.body.format ?? existing.format;
    const players = req.body.players;
    if (!Array.isArray(players)) return res.status(400).json({ error: 'players is required' });

    try {
        const errors = validateLineup({
            sessionId: existing.session_id,
            courtId: court_id,
            roundNumber: round_number,
            format,
            players,
            excludeGameIds: [existing.id],
        });
        if (errors.length) return res.status(400).json({ errors });

        store.run('UPDATE games SET court_id=?, round_number=?, format=? WHERE id=?', [court_id, round_number, format, existing.id]);
        store.run('DELETE FROM game_players WHERE game_id = ?', [existing.id]);
        for (const p of players) {
            const player = store.queryOne('SELECT skill_level FROM players WHERE id = ?', [p.player_id]);
            store.run(
                'INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, ?)',
                [existing.id, p.player_id, p.side, player.skill_level]
            );
        }
        store.persist();
        broadcast('game', { session_id: existing.session_id });
        res.json(gameWithPlayers(existing.id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Saves several courts' lineups in one request, validated and applied
// together - what a single-court PUT/POST can't do safely on its own.
// Dragging a player from one currently-being-edited court to another (both
// still unsaved server-side) used to make BOTH saves fail: saving either
// court one at a time checked the new lineup against the OTHER court's
// still-unchanged server-side game, which correctly-but-unhelpfully still
// held that player - "player X is already assigned to another game in
// round N", for a court that was only ever local, unsaved state. Here,
// every game_id already in this batch is excluded from every court's own
// conflict checks (see validateLineup's excludeGameIds), since the whole
// batch is replacing itself as one unit - a player moving between two
// courts in the SAME save is never a real conflict, only a transient one
// against data this very request is about to overwrite anyway.
router.put('/sessions/:sessionId/games/batch', (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { round_number, courts } = req.body;
    if (!Array.isArray(courts) || courts.length === 0) return res.status(400).json({ error: 'courts array is required' });

    // Everything below - the pre-checks and validateLineup included - runs
    // real queries against caller-supplied fields, so it's all inside one
    // try/catch: a malformed request should come back as a clean error, not
    // an uncaught exception (validateLineup previously ran outside any
    // try/catch in the single-court routes too - same fix applied there).
    try {
        // A court in the batch that references an existing game must
        // actually be a staged game belonging to this session - same rule
        // PUT /games/:id already enforces one at a time.
        for (const c of courts) {
            if (c.game_id) {
                const existing = store.queryOne('SELECT * FROM games WHERE id = ?', [c.game_id]);
                if (!existing) return res.status(404).json({ error: `Game ${c.game_id} not found` });
                if (existing.session_id !== sessionId) return res.status(400).json({ error: `Game ${c.game_id} does not belong to this session` });
                if (existing.status !== 'staged') return res.status(409).json({ error: `Only staged games can be edited (game ${c.game_id})` });
            }
        }

        // Within-batch duplicate check: two courts in the same batch
        // claiming the same player isn't something a single court's own
        // validateLineup call can ever catch, since it only ever sees one
        // court's players.
        const claimedBy = new Map(); // player_id -> court_id
        const batchErrors = [];
        for (const c of courts) {
            for (const p of (c.players || [])) {
                if (claimedBy.has(p.player_id)) {
                    batchErrors.push(`player ${p.player_id} is assigned to both court ${claimedBy.get(p.player_id)} and court ${c.court_id} in this save`);
                } else {
                    claimedBy.set(p.player_id, c.court_id);
                }
            }
        }
        if (batchErrors.length) return res.status(400).json({ errors: batchErrors });

        const excludeGameIds = courts.map((c) => c.game_id).filter(Boolean);
        const allErrors = [];
        for (const c of courts) {
            const errors = validateLineup({
                sessionId, courtId: c.court_id, roundNumber: round_number, format: c.format,
                players: c.players || [], excludeGameIds,
            });
            allErrors.push(...errors.map((e) => `Court ${c.court_id}: ${e}`));
        }
        if (allErrors.length) return res.status(400).json({ errors: allErrors });

        // sql.js is fully synchronous - either every court below applies and
        // store.persist() runs, or an unexpected error throws first and
        // NOTHING in this batch has been written to disk yet.
        const savedGameIds = courts.map((c) => {
            if (c.game_id) {
                store.run('UPDATE games SET court_id=?, round_number=?, format=? WHERE id=?', [c.court_id, round_number, c.format, c.game_id]);
                store.run('DELETE FROM game_players WHERE game_id = ?', [c.game_id]);
                for (const p of (c.players || [])) {
                    const player = store.queryOne('SELECT skill_level FROM players WHERE id = ?', [p.player_id]);
                    store.run('INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, ?)', [c.game_id, p.player_id, p.side, player.skill_level]);
                }
                return c.game_id;
            }
            return insertGame({ sessionId, courtId: c.court_id, roundNumber: round_number, format: c.format, players: c.players || [] });
        });
        store.persist();
        broadcast('game', { session_id: sessionId });
        res.json(savedGameIds.map(gameWithPlayers));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete('/games/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Game not found' });
    if (existing.status !== 'staged') return res.status(409).json({ error: 'Only staged games can be unstaged' });
    store.run('DELETE FROM game_players WHERE game_id = ?', [existing.id]);
    store.run('DELETE FROM games WHERE id = ?', [existing.id]);
    store.persist();
    broadcast('game', { session_id: existing.session_id });
    res.status(204).end();
});

module.exports = router;
