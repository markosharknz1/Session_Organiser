// Lapsed players: regulars who have stopped coming. A ready-made "we miss
// you" call sheet for the committee - who used to turn up, when they were
// last in, and how to reach them.
//
// This is about ATTENDANCE, worked out from the sessions people came to.
// It has nothing to do with the membership status field on a player's
// record (which also has a value called "lapsed" - that one is whatever
// the club typed in).
//
// A player is on the list when all three hold:
//   - they came to at least `minSessions` sessions ever (a regular, not a
//     one-off visitor),
//   - their last session was `weeks` weeks ago or more,
//   - and, unless `withinMonths` is 0, that last session was within the
//     last `withinMonths` months (someone who left three years ago is not
//     who the committee is ringing this week).
//
// Pure and read-only, like the other reports; unit-tested against a
// throwaway database (lapsedPlayers.test.js).
const { all } = require('../db/index');

// was physically there: not a booking that never arrived
const ATTENDED = `a.state != 'booked' AND NOT (a.state = 'left' AND a.left_reason = 'no-show')`;

const DEFAULTS = { weeks: 4, minSessions: 3, withinMonths: 12 };

function wholeNumber(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

// YYYY-MM-DD arithmetic in UTC, so it never slips a day on a daylight
// saving change.
function addDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
    return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

function lapsedPlayers(db, asOf, options = {}) {
    const weeks = wholeNumber(options.weeks, DEFAULTS.weeks, 1, 520);
    const minSessions = wholeNumber(options.minSessions, DEFAULTS.minSessions, 1, 1000);
    const withinMonths = wholeNumber(options.withinMonths, DEFAULTS.withinMonths, 0, 600);
    const lastOnOrBefore = addDays(asOf, -weeks * 7);
    const lastOnOrAfter = withinMonths ? addDays(asOf, -Math.round(withinMonths * 30.44)) : null;

    const rows = all(db, `
        SELECT p.id, p.first_name, p.last_name, p.skill_level, p.membership_status, p.phone, p.email,
               COUNT(DISTINCT s.id) AS sessions,
               MIN(s.date) AS first_came,
               MAX(s.date) AS last_came
        FROM players p
        JOIN attendance a ON a.player_id = p.id AND ${ATTENDED}
        JOIN sessions s ON s.id = a.session_id AND s.date <= ?
        GROUP BY p.id
        HAVING COUNT(DISTINCT s.id) >= ? AND MAX(s.date) <= ?
        ORDER BY p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`,
        [asOf, minSessions, lastOnOrBefore]
    ).filter((p) => !lastOnOrAfter || p.last_came >= lastOnOrAfter);

    // How regular they were just before they stopped: sessions in the
    // twelve weeks up to and including their last one. "9 in their last 12
    // weeks" is a regular who vanished; "1" is someone who was already
    // drifting.
    const players = rows.map((p) => {
        const windowStart = addDays(p.last_came, -(12 * 7) + 1);
        const recent = all(
            db,
            `SELECT COUNT(DISTINCT s.id) AS n FROM attendance a JOIN sessions s ON s.id = a.session_id
             WHERE a.player_id = ? AND ${ATTENDED} AND s.date >= ? AND s.date <= ?`,
            [p.id, windowStart, p.last_came]
        )[0].n;
        return {
            ...p,
            weeks_away: Math.floor(daysBetween(p.last_came, asOf) / 7),
            sessions_last_12_weeks: recent,
        };
    });

    return { as_of: asOf, weeks, min_sessions: minSessions, within_months: withinMonths, players };
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function lapsedCsv(report) {
    const lines = [];
    const row = (...cells) => lines.push(cells.map(csvCell).join(','));
    row('Game Scheduler lapsed players');
    row('As of', report.as_of);
    row('Not seen for (weeks or more)', report.weeks);
    row('Came at least (sessions)', report.min_sessions);
    row('Last came within (months)', report.within_months || 'any time');
    row('Players', report.players.length);
    row();
    row('First name', 'Last name', 'Grade', 'Membership', 'Last came', 'Weeks away', 'Sessions ever', 'Sessions in their last 12 weeks', 'First came', 'Phone', 'Email');
    for (const p of report.players) {
        row(p.first_name, p.last_name, p.skill_level, p.membership_status, p.last_came, p.weeks_away, p.sessions, p.sessions_last_12_weeks, p.first_came, p.phone || '', p.email || '');
    }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { lapsedPlayers, lapsedCsv, LAPSED_DEFAULTS: DEFAULTS };
