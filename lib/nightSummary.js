// The end-of-night summary: what the person closing up wants to know in
// one look - how many came, how the play went, and what was taken. Shown
// when a session is finished (public/sessionSummaryModal.js), from History
// for any past night, and in the emailed summary.
//
// Mostly an assembly job: who came / left / was injured is the tally's
// (lib/tallyReport.js), the money is the payment breakdown's
// (lib/sessionReport.js). New here: the play (rounds, games, how evenly
// the games were shared out, results entered), visitors, and how the
// turnout compares with this session's usual.
//
// There is deliberately nothing about money owed: a club that takes
// payment at the desk has no IOUs to chase.
const { all, get } = require('../db/index');
const { sessionTally } = require('./tallyReport');
const { paymentBreakdown } = require('./sessionReport');

const fullName = (p) => `${p.first_name} ${p.last_name}`;

// A game counts once it has been on court - 'active' (still on when the
// session was finished) or 'completed'. A staged court never happened.
const PLAYED = `g.status IN ('active', 'completed')`;

function playSummary(db, session, arrivedPlayers) {
    const totals = get(
        db,
        `SELECT COUNT(*) AS games, COUNT(DISTINCT g.round_number) AS rounds, COUNT(DISTINCT g.court_id) AS courts,
                MIN(COALESCE(g.started_at, g.created_at)) AS first_game_at, MAX(COALESCE(g.started_at, g.created_at)) AS last_game_at
         FROM games g WHERE g.session_id = ? AND ${PLAYED}`,
        [session.id]
    );
    if (!totals || !totals.games) return null;

    const perPlayer = new Map(all(
        db,
        `SELECT gp.player_id, COUNT(*) AS n FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE g.session_id = ? AND ${PLAYED} GROUP BY gp.player_id`,
        [session.id]
    ).map((r) => [r.player_id, r.n]));

    // How evenly the games were shared is only a fair question about the
    // people who were there to the end: someone who went home after three
    // rounds, or arrived for the last two, was always going to have fewer.
    // So "stayed" = arrived and not marked as having left. Late arrivals
    // can't be told apart and are simply part of the spread.
    const stayed = arrivedPlayers.filter((p) => !p.status);
    const counts = stayed.map((p) => perPlayer.get(p.player_id) || 0);
    let share = null;
    if (counts.length) {
        const fewest = Math.min(...counts);
        const most = Math.max(...counts);
        share = {
            players: counts.length,
            fewest,
            most,
            average: Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10,
            // who had the fewest - worth naming only when it's a few people
            // standing out, not when everyone had the same
            fewest_players: fewest < most ? stayed.filter((p) => (perPlayer.get(p.player_id) || 0) === fewest).map((p) => p.name) : [],
        };
    }

    let results = null;
    if (session.record_results) {
        const recorded = get(
            db,
            `SELECT COUNT(*) AS n FROM games g JOIN game_results r ON r.game_id = g.id
             WHERE g.session_id = ? AND ${PLAYED} AND (r.winner_side IS NOT NULL OR r.winner_player_id IS NOT NULL)`,
            [session.id]
        ).n;
        results = { recorded, of: totals.games };
    }

    return {
        rounds: totals.rounds,
        games: totals.games,
        courts: totals.courts,
        first_game_at: totals.first_game_at,
        last_game_at: totals.last_game_at,
        share,
        results,
    };
}

// The usual turnout for this kind of night: the average number who came to
// the (up to) six most recent earlier nights from the same template. A
// night nobody came to (started by mistake and closed again) is not a
// night. Null for a one-off night or the first of its kind.
const CAME = `a.state != 'booked' AND NOT (a.state = 'left' AND a.left_reason = 'no-show')`;
function usualTurnout(db, session) {
    if (!session.template_id) return null;
    const turnouts = all(
        db,
        `SELECT s.id, COUNT(DISTINCT a.player_id) AS n
         FROM sessions s JOIN attendance a ON a.session_id = s.id AND ${CAME}
         WHERE s.template_id = ? AND s.id != ? AND s.status = 'closed' AND (s.date < ? OR (s.date = ? AND s.id < ?))
         GROUP BY s.id
         ORDER BY s.date DESC, s.id DESC LIMIT 6`,
        [session.template_id, session.id, session.date, session.date, session.id]
    ).map((r) => r.n);
    if (!turnouts.length) return null;
    return { average: Math.round(turnouts.reduce((a, b) => a + b, 0) / turnouts.length), nights: turnouts.length };
}

function nightSummary(db, sessionId) {
    const session = get(db, 'SELECT id, template_id, date, label, notes, status, mode, format, record_results FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return null;
    const tally = sessionTally(db, sessionId);
    const club = get(db, 'SELECT square_enabled FROM club_settings WHERE id = 1') || {};

    // Visitors / new members: the tick on the check-in box, on any of the
    // player's rows tonight, for someone who did arrive.
    const arrivedIds = new Set(tally.players.map((p) => p.player_id));
    const visitors = all(
        db,
        `SELECT DISTINCT p.id, p.first_name, p.last_name FROM attendance a JOIN players p ON p.id = a.player_id
         WHERE a.session_id = ? AND (a.first_time = 1 OR a.new_member = 1)
         ORDER BY p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`,
        [sessionId]
    ).filter((p) => arrivedIds.has(p.id)).map(fullName);

    const firstCheckIn = get(db, `SELECT MIN(checked_in_at) AS t FROM attendance WHERE session_id = ? AND state != 'booked'`, [sessionId]);

    return {
        session,
        players: {
            came: tally.counts.arrived,
            usual: usualTurnout(db, session),
            visitors,
            left_early: tally.left_early,
            injuries: tally.injuries,
            removed: tally.removed,
            booked_did_not_come: tally.not_arrived,
            first_check_in_at: firstCheckIn ? firstCheckIn.t : null,
        },
        play: session.mode === 'social' ? null : playSummary(db, session, tally.players),
        money: club.square_enabled ? paymentBreakdown(db, sessionId) : null,
    };
}

module.exports = { nightSummary };
