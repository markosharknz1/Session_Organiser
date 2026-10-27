// The committee report: over a date range, how many sessions were held,
// who came, who was new, whether the new people came back, and how often
// each player played. Counts only - no dates per player - so it reads as
// a summary, and it comes out as a CSV too.
//
// "Attended" = checked in and not a mistake (a no-show / "checked in by
// mistake" row is never counted, a booking that never arrived neither).
// "New" = their first attendance on record (ever, not just in the range)
// falls inside the range. "Retention" looks at those new players and
// counts how many sessions each went on to attend, up to the end of the
// range (so a report for a quarter asks "of the people who first came
// this quarter, how many came back within it").

const ATTENDED = `a.state != 'booked' AND NOT (a.state = 'left' AND a.left_reason = 'no-show')`;

function all(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

// Retention buckets for "how many sessions did a new player attend".
const RETENTION_BUCKETS = [
    { key: 'once', label: '1 session only', min: 1, max: 1 },
    { key: 'two_three', label: '2-3 sessions', min: 2, max: 3 },
    { key: 'four_five', label: '4-5 sessions', min: 4, max: 5 },
    { key: 'six_plus', label: '6 or more', min: 6, max: Infinity },
];

function committeeReport(db, from, to) {
    const params = [];
    let range = '';
    if (from) { range += ' AND s.date >= ?'; params.push(from); }
    if (to) { range += ' AND s.date <= ?'; params.push(to); }

    const sessions = all(db, `SELECT s.id, s.date, s.label FROM sessions s WHERE 1=1${range} ORDER BY s.date, s.id`, params);
    const sessionIds = sessions.map((s) => s.id);
    const inRange = sessionIds.length ? `IN (${sessionIds.map(() => '?').join(',')})` : 'IN (NULL)';

    // Per player, inside the range: sessions attended and matches played.
    const players = all(db, `
        SELECT p.id, p.first_name, p.last_name, p.skill_level, p.membership_status, p.gender,
               (SELECT COUNT(DISTINCT a.session_id) FROM attendance a
                 WHERE a.player_id = p.id AND a.session_id ${inRange} AND ${ATTENDED}) AS sessions,
               (SELECT COUNT(*) FROM game_players gp JOIN games g ON g.id = gp.game_id
                 WHERE gp.player_id = p.id AND g.session_id ${inRange} AND g.status IN ('active','completed')) AS matches,
               (SELECT SUM(CASE WHEN r.winner_side = gp.side THEN 1 ELSE 0 END) FROM game_players gp
                 JOIN games g ON g.id = gp.game_id JOIN game_results r ON r.game_id = g.id
                 WHERE gp.player_id = p.id AND g.session_id ${inRange}) AS wins,
               (SELECT SUM(CASE WHEN r.winner_side != gp.side THEN 1 ELSE 0 END) FROM game_players gp
                 JOIN games g ON g.id = gp.game_id JOIN game_results r ON r.game_id = g.id
                 WHERE gp.player_id = p.id AND g.session_id ${inRange}) AS losses,
               (SELECT MIN(s2.date) FROM attendance a JOIN sessions s2 ON s2.id = a.session_id
                 WHERE a.player_id = p.id AND ${ATTENDED}) AS first_seen
        FROM players p
        ORDER BY p.last_name, p.first_name`,
        [...sessionIds, ...sessionIds, ...sessionIds, ...sessionIds]
    ).filter((p) => p.sessions > 0);

    const isNew = (p) => !!p.first_seen && (!from || p.first_seen >= from) && (!to || p.first_seen <= to);
    for (const p of players) {
        p.is_new = isNew(p);
        p.wins = p.wins || 0;
        p.losses = p.losses || 0;
    }

    const attendances = players.reduce((n, p) => n + p.sessions, 0);
    const byStatus = { active: 0, lapsed: 0, guest: 0 };
    for (const p of players) byStatus[p.membership_status] = (byStatus[p.membership_status] || 0) + 1;

    const newPlayers = players.filter((p) => p.is_new);
    const retention = RETENTION_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        players: newPlayers.filter((p) => p.sessions >= b.min && p.sessions <= b.max).length,
    }));
    const returned = newPlayers.filter((p) => p.sessions >= 2).length;

    return {
        from: from || null,
        to: to || null,
        sessions_held: sessions.length,
        attendances,
        unique_players: players.length,
        average_per_session: sessions.length ? Math.round((attendances / sessions.length) * 10) / 10 : 0,
        by_membership: byStatus,
        new_players: newPlayers.length,
        returned_after_first: returned,
        retention_rate: newPlayers.length ? Math.round((returned / newPlayers.length) * 100) : null,
        retention,
        players: players.sort((a, b) => b.sessions - a.sessions || b.matches - a.matches || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name)),
    };
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per player who attended or played in the range, headed by the
// summary lines so the file stands on its own.
function committeeCsv(report) {
    const lines = [];
    const row = (...cells) => lines.push(cells.map(csvCell).join(','));
    row('Game Scheduler committee report');
    row('From', report.from || 'start');
    row('To', report.to || 'now');
    row('Sessions held', report.sessions_held);
    row('Attendances', report.attendances);
    row('Unique players', report.unique_players);
    row('Average per session', report.average_per_session);
    row('New players', report.new_players);
    row('New players who came back', report.returned_after_first, report.retention_rate === null ? '' : `${report.retention_rate}%`);
    for (const b of report.retention) row(`New players - ${b.label}`, b.players);
    row();
    row('Last name', 'First name', 'Grade', 'Membership', 'Gender', 'New in range', 'First seen', 'Sessions attended', 'Matches played', 'Won', 'Lost');
    for (const p of report.players) {
        row(p.last_name, p.first_name, p.skill_level, p.membership_status, p.gender || '', p.is_new ? 'Yes' : 'No', p.first_seen || '', p.sessions, p.matches, p.wins, p.losses);
    }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { committeeReport, committeeCsv, RETENTION_BUCKETS };
