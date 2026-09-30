// Round lifecycle transitions, shared between the manual "Start/End round"
// buttons, the auto-generate algorithm, and the timer-driven scheduler that
// calls these same functions on phase_ends_at expiry. Keeping the transition
// logic here (not in route handlers) means the scheduler doesn't duplicate it.
const store = require('../db/store');
const { broadcast } = require('./eventBus');
const { generateRound } = require('./autoGenerate');

class LifecycleError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function nowStr() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function plusMinutes(mins) {
    return new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function plusMs(ms) {
    return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Stored as 'YYYY-MM-DD HH:MM:SS' (matches SQLite's datetime('now'), UTC) -
// same parsing lib/scheduler.js's tick() already does for the same reason.
function parseUtc(dtStr) {
    return new Date(`${dtStr.replace(' ', 'T')}Z`).getTime();
}

function getNextRoundNumber(sessionId) {
    const row = store.queryOne(
        `SELECT MAX(round_number) AS m FROM games WHERE session_id = ? AND status IN ('active','completed')`,
        [sessionId]
    );
    return (row.m || 0) + 1;
}

function getActiveRoundNumber(sessionId) {
    const row = store.queryOne(`SELECT round_number FROM games WHERE session_id = ? AND status = 'active' LIMIT 1`, [sessionId]);
    return row ? row.round_number : null;
}

function clubSettings() {
    return store.queryOne('SELECT * FROM club_settings WHERE id = 1');
}

const FORMAT_SIZES = { singles: 2, doubles: 4, threes: 3 };

function stagedCountFor(sessionId, roundNumber) {
    return store.queryOne(
        `SELECT COUNT(*) AS n FROM games WHERE session_id = ? AND round_number = ? AND status = 'staged'`,
        [sessionId, roundNumber]
    ).n;
}

// A staged court can be short a player or two while still being designed
// (see routes/games.js's relaxed validateLineup) - it just can't be started
// that way. Returns the short courts, not just a bool, so the error can
// name them.
function incompleteStagedCourts(sessionId, roundNumber) {
    const staged = store.query(
        `SELECT g.format, c.court_number, COUNT(gp.player_id) AS player_count
         FROM games g
         JOIN courts c ON c.id = g.court_id
         LEFT JOIN game_players gp ON gp.game_id = g.id
         WHERE g.session_id = ? AND g.round_number = ? AND g.status = 'staged'
         GROUP BY g.id
         ORDER BY c.court_number`,
        [sessionId, roundNumber]
    );
    return staged.filter((g) => g.player_count < FORMAT_SIZES[g.format]);
}

function activateStagedRound(sessionId, roundNumber) {
    const staged = store.query(`SELECT * FROM games WHERE session_id = ? AND round_number = ? AND status = 'staged'`, [sessionId, roundNumber]);
    for (const game of staged) {
        store.run(`UPDATE games SET status = 'active', started_at = datetime('now') WHERE id = ?`, [game.id]);
        const players = store.query('SELECT player_id FROM game_players WHERE game_id = ?', [game.id]);
        for (const p of players) {
            store.run(
                `UPDATE attendance SET state = 'playing' WHERE session_id = ? AND player_id = ? AND state != 'left'`,
                [sessionId, p.player_id]
            );
        }
    }
    return staged.length;
}

// Inserts an auto-generated plan directly as active games (no staged step -
// nobody needs to review it in hands-off auto mode).
function insertGeneratedGames(sessionId, roundNumber, plan) {
    for (const g of plan) {
        const gameId = store.insert(
            `INSERT INTO games (session_id, court_id, round_number, format, mode, status, started_at) VALUES (?, ?, ?, ?, 'auto', 'active', datetime('now'))`,
            [sessionId, g.court_id, roundNumber, g.format]
        );
        for (const p of g.players) {
            const player = store.queryOne('SELECT skill_level FROM players WHERE id = ?', [p.player_id]);
            store.run(
                'INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, ?)',
                [gameId, p.player_id, p.side, player.skill_level]
            );
            store.run(
                `UPDATE attendance SET state = 'playing' WHERE session_id = ? AND player_id = ? AND state != 'left'`,
                [sessionId, p.player_id]
            );
        }
    }
    return plan.length;
}

// Same shape as insertGeneratedGames, but stages the plan instead of
// activating it, and leaves attendance alone (staging never changes
// attendance.state - see routes/games.js's staged-game insert). Used by
// preGenerateNextRound so the auto-generated plan looks, to every other
// consumer (the display, the designer), exactly like a round staff staged
// by hand ahead of time.
function insertStagedGeneratedGames(sessionId, roundNumber, plan) {
    for (const g of plan) {
        const gameId = store.insert(
            `INSERT INTO games (session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'auto', 'staged')`,
            [sessionId, g.court_id, roundNumber, g.format]
        );
        for (const p of g.players) {
            const player = store.queryOne('SELECT skill_level FROM players WHERE id = ?', [p.player_id]);
            store.run(
                'INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, ?)',
                [gameId, p.player_id, p.side, player.skill_level]
            );
        }
    }
    return plan.length;
}

// Auto mode only: the scheduler calls this on every tick during a round's
// last PRE_GENERATE_WINDOW_MS, so the next round exists as staged games
// (not yet on court) before the current one even ends - otherwise auto mode
// never has anything staged, since beginRound() normally only generates a
// round at the moment it activates it. That gap meant the external display's
// "up next" panel (which only ever shows staged games) had nothing to show
// in auto mode until the round had already started, defeating the point of
// a "what's coming up" screen. beginRound()'s existing staged-first check
// picks this up automatically at break-end, so nothing downstream needs to
// know a round was pre-generated versus staged by hand.
//
// Safe to call every tick: a no-op once the next round already has staged
// games (from an earlier tick, or from a court staff staged by hand), and
// silently does nothing if generateRound can't build a full round yet (the
// normal break-end path will retry, and surface the real error if it still
// can't). 5 minutes (not 1) gives staff real time to notice and fix a bad
// pairing on the Rounds page before it goes live - see the "next round
// ready for review" callout in public/manage.js, shown only there (never
// the external Display, which already only ever shows a staged round once
// current_phase leaves 'game' - see routes/display.js).
const PRE_GENERATE_WINDOW_MS = 5 * 60000;

function preGenerateNextRound(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session || session.mode !== 'auto' || session.current_phase !== 'game') return;

    const nextRound = getNextRoundNumber(sessionId);
    if (stagedCountFor(sessionId, nextRound) > 0) return;

    const plan = generateRound(store.getDb(), sessionId, nextRound);
    if (plan.length === 0) return;

    insertStagedGeneratedGames(sessionId, nextRound, plan);
    store.persist();
    broadcast('game', { session_id: sessionId });
}

function setGamePhase(sessionId, gameMinutes) {
    store.run(
        `UPDATE sessions SET current_phase = 'game', phase_started_at = ?, phase_ends_at = ? WHERE id = ?`,
        [nowStr(), plusMinutes(gameMinutes), sessionId]
    );
}

function setAwaitingLineup(sessionId) {
    store.run(`UPDATE sessions SET current_phase = 'awaiting_lineup', phase_started_at = NULL, phase_ends_at = NULL WHERE id = ?`, [sessionId]);
}

// Freezes the currently-running game or break timer for an injury,
// announcement, or anything else that needs everyone's attention right now.
// Works for both auto and manual mode, and for a game or a break - an
// announcement is just as likely mid-changeover as mid-game. Nulling
// phase_ends_at is what actually stops lib/scheduler.js's tick() from
// force-expiring the phase (it already skips any session with no end time);
// the remaining duration is captured separately so resumeCurrentPhase can
// pick up with the correct time left, not a fresh full countdown.
// phase_started_at is left untouched - it still reflects when the round/
// break genuinely began, pause or not. Courts/games themselves are
// untouched too - this pauses the SESSION's phase timer, not any one court.
function pauseCurrentPhase(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    if (session.current_phase !== 'game' && session.current_phase !== 'break') {
        throw new LifecycleError(409, 'Nothing to pause - no round or break currently in progress');
    }
    const remainingMs = Math.max(0, parseUtc(session.phase_ends_at) - Date.now());
    store.run(
        `UPDATE sessions SET current_phase = 'paused', phase_ends_at = NULL, paused_remaining_ms = ?, paused_from_phase = ?, phase_paused_at = ? WHERE id = ?`,
        [remainingMs, session.current_phase, nowStr(), sessionId]
    );
    store.persist();
    broadcastRoundChange(sessionId);
    return { paused_from: session.current_phase, remaining_ms: remainingMs };
}

// Resumes into whichever phase was paused, with the exact time that was
// left when it was paused - not a fresh countdown.
function resumeCurrentPhase(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    if (session.current_phase !== 'paused') throw new LifecycleError(409, 'Session is not currently paused');

    const phaseEndsAt = plusMs(session.paused_remaining_ms ?? 0);
    store.run(
        `UPDATE sessions SET current_phase = ?, phase_ends_at = ?, paused_remaining_ms = NULL, paused_from_phase = NULL, phase_paused_at = NULL WHERE id = ?`,
        [session.paused_from_phase, phaseEndsAt, sessionId]
    );
    store.persist();
    broadcastRoundChange(sessionId);
    return { resumed_to: session.paused_from_phase, phase_ends_at: phaseEndsAt };
}

function broadcastRoundChange(sessionId) {
    broadcast('session', { session_id: sessionId });
    broadcast('game', { session_id: sessionId });
    broadcast('attendance', { session_id: sessionId });
}

// Tries staged games first, then auto-generate if the session is in auto
// mode. Returns { source: 'staged'|'auto', games_activated } or null if
// nothing could be started (caller decides how to handle that).
function beginRound(sessionId, session, roundNumber) {
    const stagedCount = stagedCountFor(sessionId, roundNumber);
    if (stagedCount > 0) {
        const incomplete = incompleteStagedCourts(sessionId, roundNumber);
        if (incomplete.length > 0) {
            const detail = incomplete
                .map((g) => {
                    const short = FORMAT_SIZES[g.format] - g.player_count;
                    return `Court ${g.court_number} needs ${short} more player${short === 1 ? '' : 's'}`;
                })
                .join(', ');
            throw new LifecycleError(400, `Cannot start round ${roundNumber} - some courts are incomplete: ${detail}`);
        }
        return { source: 'staged', games_activated: activateStagedRound(sessionId, roundNumber) };
    }
    if (session.mode === 'auto') {
        const plan = generateRound(store.getDb(), sessionId, roundNumber);
        if (plan.length > 0) {
            return { source: 'auto', games_activated: insertGeneratedGames(sessionId, roundNumber, plan) };
        }
    }
    return null;
}

// Starts the next un-played round from an idle/awaiting_lineup state.
function startNextRound(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    if (session.status !== 'open') throw new LifecycleError(400, 'Session is not open');
    if (session.mode === 'social') throw new LifecycleError(400, 'This session is in social mode - it has no rounds to manage.');
    if (session.current_phase === 'game') throw new LifecycleError(409, 'A round is already active');

    const nextRound = getNextRoundNumber(sessionId);
    const result = beginRound(sessionId, session, nextRound);
    if (!result) {
        const reason = session.mode === 'auto'
            ? `Auto-generate could not build round ${nextRound}: not enough players present, or not enough free courts.`
            : `No games staged for round ${nextRound}. Build the lineup first.`;
        throw new LifecycleError(session.mode === 'auto' ? 422 : 400, reason);
    }

    const club = clubSettings();
    const gameMinutes = session.game_minutes ?? club.default_game_minutes;
    setGamePhase(sessionId, gameMinutes);
    store.persist();
    broadcastRoundChange(sessionId);
    return { round_number: nextRound, games_activated: result.games_activated, source: result.source };
}

// Ends the currently active round: completes its games, sends players back to
// here_today, and flips the session into a break.
function endGamePhase(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    if (session.current_phase !== 'game') throw new LifecycleError(409, 'No active round to end');

    const activeGames = store.query(`SELECT * FROM games WHERE session_id = ? AND status = 'active'`, [sessionId]);
    for (const g of activeGames) {
        store.run(`UPDATE games SET status = 'completed' WHERE id = ?`, [g.id]);
    }
    store.run(`UPDATE attendance SET state = 'here_today' WHERE session_id = ? AND state = 'playing'`, [sessionId]);

    const club = clubSettings();
    const breakMinutes = session.break_minutes ?? club.default_break_minutes;
    store.run(
        `UPDATE sessions SET current_phase = 'break', phase_started_at = ?, phase_ends_at = ? WHERE id = ?`,
        [nowStr(), plusMinutes(breakMinutes), sessionId]
    );
    store.persist();
    broadcastRoundChange(sessionId);
    return { completed_games: activeGames.length };
}

// Ends the break: staged games for the next round activate immediately
// (skipping the awaiting_lineup gap, per spec). If none are staged and the
// session is in auto mode, runs the auto-generate algorithm - this is what
// makes auto mode genuinely hands-off across a full session. If auto-generate
// can't build a round (too few players etc.), that must fail visibly rather
// than silently stall, since nobody may be watching an unattended session.
function endBreakPhase(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    if (session.current_phase !== 'break') throw new LifecycleError(409, 'Not currently on a break');

    const nextRound = getNextRoundNumber(sessionId);
    const result = beginRound(sessionId, session, nextRound);

    if (result) {
        const club = clubSettings();
        const gameMinutes = session.game_minutes ?? club.default_game_minutes;
        setGamePhase(sessionId, gameMinutes);
        store.persist();
        broadcastRoundChange(sessionId);
        return { activated_round: nextRound, games_activated: result.games_activated, source: result.source };
    }

    if (session.mode === 'auto') {
        const message = `Auto-generate could not build round ${nextRound} for session ${sessionId}: not enough players present, or not enough free courts.`;
        console.error(`[roundLifecycle] ${message}`);
        setAwaitingLineup(sessionId);
        store.persist();
        broadcast('session', { session_id: sessionId });
        broadcast('auto_generate_failed', { session_id: sessionId, message });
        return { activated_round: null, error: message };
    }

    setAwaitingLineup(sessionId);
    store.persist();
    broadcast('session', { session_id: sessionId });
    return { activated_round: null };
}

function roundStatus(sessionId) {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw new LifecycleError(404, 'Session not found');
    const nextRound = getNextRoundNumber(sessionId);
    return {
        current_phase: session.current_phase,
        current_round: getActiveRoundNumber(sessionId),
        next_round_number: nextRound,
        phase_started_at: session.phase_started_at,
        phase_ends_at: session.phase_ends_at,
        staged_next_count: stagedCountFor(sessionId, nextRound),
        mode: session.mode,
        paused_from_phase: session.paused_from_phase,
        paused_remaining_ms: session.paused_remaining_ms,
    };
}

module.exports = {
    LifecycleError,
    getNextRoundNumber,
    getActiveRoundNumber,
    startNextRound,
    endGamePhase,
    endBreakPhase,
    pauseCurrentPhase,
    resumeCurrentPhase,
    preGenerateNextRound,
    PRE_GENERATE_WINDOW_MS,
    roundStatus,
};
