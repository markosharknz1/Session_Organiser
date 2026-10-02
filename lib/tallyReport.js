// The tally report emailed from the History page: one session, or a whole
// month. Deliberately simple tables - what was paid, who left injured or
// early, how many were pre-booked against how many just turned up, and the
// list of who was there.
//
// Pure and read-only (takes a db handle, returns plain data, then renders
// it), so it is unit-tested against a throwaway in-memory database - see
// tallyReport.test.js.
const { all, get } = require('../db/index');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dollars(cents) {
    const d = (cents ?? 0) / 100;
    return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The club's chosen display order (Settings > Club details > Date format).
function formatDate(iso, dateFormat) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    if (dateFormat === 'DMY') return `${m[3]}/${m[2]}/${m[1]}`;
    if (dateFormat === 'MDY') return `${m[2]}/${m[3]}/${m[1]}`;
    return iso;
}

const byName = (a, b) => a.last_name.localeCompare(b.last_name, undefined, { sensitivity: 'base' })
    || a.first_name.localeCompare(b.first_name, undefined, { sensitivity: 'base' });
const fullName = (p) => `${p.first_name} ${p.last_name}`;

// One entry per player for the session: their most recent attendance row
// (a player removed and checked in again has more than one), with
// was_booked carried over from any of their rows.
function playersOfSession(db, sessionId) {
    const rows = all(
        db,
        `SELECT a.id, a.player_id, a.state, a.left_reason, a.was_booked,
                a.payment_category_id, a.payment_amount_cents, a.payment_method, a.payment_note,
                p.first_name, p.last_name, p.skill_level, pc.name AS category
         FROM attendance a
         JOIN players p ON p.id = a.player_id
         LEFT JOIN payment_categories pc ON pc.id = a.payment_category_id
         WHERE a.session_id = ? ORDER BY a.id`,
        [sessionId]
    );
    const latest = new Map();
    for (const r of rows) {
        const prev = latest.get(r.player_id);
        latest.set(r.player_id, { ...r, was_booked: (prev && prev.was_booked) || r.was_booked ? 1 : 0 });
    }
    return [...latest.values()].sort(byName);
}

// arrived: was physically there at some point. A row still 'booked', or a
// cancelled booking ('left' / 'no-show'), never arrived.
function arrived(r) {
    return r.state !== 'booked' && !(r.state === 'left' && r.left_reason === 'no-show');
}

function sessionTally(db, sessionId) {
    const session = get(db, 'SELECT id, date, label, mode, format, status, notes FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return null;
    const everyone = playersOfSession(db, sessionId);
    const here = everyone.filter(arrived);
    // Pre-booked and never turned up. (A 'no-show' entry that was never a
    // booking is a check-in made by mistake and undone - it counts nowhere.)
    const notArrived = everyone.filter((r) => !arrived(r) && r.was_booked);
    const leftAs = (reason) => here.filter((r) => r.state === 'left' && r.left_reason === reason);

    const byCategory = new Map();
    const byMethod = new Map();
    let total = 0;
    for (const r of here) {
        const cents = r.payment_amount_cents || 0;
        const cat = r.payment_category_id ? r.category : 'No payment recorded';
        const c = byCategory.get(cat) || { category: cat, count: 0, amount_cents: 0 };
        c.count += 1; c.amount_cents += cents; byCategory.set(cat, c);
        if (r.payment_category_id) {
            const method = r.payment_method || 'Not stated';
            const m = byMethod.get(method) || { method, count: 0, amount_cents: 0 };
            m.count += 1; m.amount_cents += cents; byMethod.set(method, m);
            total += cents;
        }
    }
    const prebookedArrived = here.filter((r) => r.was_booked).length;

    return {
        session,
        counts: {
            arrived: here.length,
            prebooked: prebookedArrived + notArrived.length,
            prebooked_arrived: prebookedArrived,
            prebooked_not_arrived: notArrived.length,
            walk_ins: here.length - prebookedArrived,
            left_injured: leftAs('injured').length,
            left_early: leftAs('departed').length,
            removed: leftAs('removed').length,
        },
        payments: {
            by_category: [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category)),
            by_method: [...byMethod.values()].sort((a, b) => a.method.localeCompare(b.method)),
            total_cents: total,
        },
        left_injured: leftAs('injured').map(fullName),
        left_early: leftAs('departed').map(fullName),
        removed: leftAs('removed').map(fullName),
        not_arrived: notArrived.map(fullName),
        players: here.map((r) => ({
            player_id: r.player_id,
            first_name: r.first_name,
            last_name: r.last_name,
            name: fullName(r),
            skill_level: r.skill_level,
            prebooked: !!r.was_booked,
            category: r.payment_category_id ? r.category : null,
            amount_cents: r.payment_category_id ? (r.payment_amount_cents || 0) : null,
            method: r.payment_method || null,
            note: r.payment_note || null,
            status: r.state === 'left' ? ({ injured: 'Left injured', departed: 'Left early', removed: 'Removed' }[r.left_reason] || 'Left') : '',
        })),
    };
}

// ym: 'YYYY-MM'. Null if the month has no sessions.
function monthTally(db, ym) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '')) return null;
    const sessions = all(db, `SELECT id FROM sessions WHERE date LIKE ? ORDER BY date, id`, [`${ym}-%`]);
    if (sessions.length === 0) return null;
    const tallies = sessions.map((s) => sessionTally(db, s.id));

    const totals = { arrived: 0, prebooked: 0, prebooked_arrived: 0, prebooked_not_arrived: 0, walk_ins: 0, left_injured: 0, left_early: 0, removed: 0, total_cents: 0 };
    const byCategory = new Map();
    const byMethod = new Map();
    const players = new Map();
    const injuries = [];
    const leftEarly = [];
    for (const t of tallies) {
        for (const k of ['arrived', 'prebooked', 'prebooked_arrived', 'prebooked_not_arrived', 'walk_ins', 'left_injured', 'left_early', 'removed']) totals[k] += t.counts[k];
        totals.total_cents += t.payments.total_cents;
        for (const c of t.payments.by_category) {
            const e = byCategory.get(c.category) || { category: c.category, count: 0, amount_cents: 0 };
            e.count += c.count; e.amount_cents += c.amount_cents; byCategory.set(c.category, e);
        }
        for (const m of t.payments.by_method) {
            const e = byMethod.get(m.method) || { method: m.method, count: 0, amount_cents: 0 };
            e.count += m.count; e.amount_cents += m.amount_cents; byMethod.set(m.method, e);
        }
        for (const p of t.players) {
            const e = players.get(p.player_id) || { player_id: p.player_id, first_name: p.first_name, last_name: p.last_name, name: p.name, skill_level: p.skill_level, sessions: 0, paid_cents: 0 };
            e.sessions += 1; e.paid_cents += p.amount_cents || 0; players.set(p.player_id, e);
        }
        for (const name of t.left_injured) injuries.push({ date: t.session.date, label: t.session.label, name });
        for (const name of t.left_early) leftEarly.push({ date: t.session.date, label: t.session.label, name });
    }
    const [year, month] = ym.split('-').map(Number);
    return {
        ym,
        title: `${MONTH_NAMES[month - 1]} ${year}`,
        sessions: tallies.map((t) => ({ id: t.session.id, date: t.session.date, label: t.session.label, ...t.counts, total_cents: t.payments.total_cents })),
        totals,
        payments: {
            by_category: [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category)),
            by_method: [...byMethod.values()].sort((a, b) => a.method.localeCompare(b.method)),
            total_cents: totals.total_cents,
        },
        left_injured: injuries,
        left_early: leftEarly,
        unique_players: players.size,
        players: [...players.values()].sort(byName),
    };
}

// --- Rendering -----------------------------------------------------------------
const TABLE = 'border-collapse:collapse;margin:0 0 18px;font-size:14px;';
const TH = 'text-align:left;padding:6px 12px;border-bottom:2px solid #1f2937;';
const THR = 'text-align:right;padding:6px 12px;border-bottom:2px solid #1f2937;';
const TD = 'padding:5px 12px;border-bottom:1px solid #e5e7eb;';
const TDR = 'padding:5px 12px;border-bottom:1px solid #e5e7eb;text-align:right;';
const H3 = 'margin:20px 0 8px;font-size:16px;';

function table(headers, rows, footer) {
    const head = headers.map((h) => `<th style="${h.right ? THR : TH}">${esc(h.text)}</th>`).join('');
    const body = rows.map((cells) => `<tr>${cells.map((c, i) => `<td style="${headers[i].right ? TDR : TD}">${esc(c)}</td>`).join('')}</tr>`).join('');
    const foot = footer ? `<tr>${footer.map((c, i) => `<td style="${headers[i].right ? TDR : TD}font-weight:bold;">${esc(c)}</td>`).join('')}</tr>` : '';
    return `<table cellspacing="0" style="${TABLE}"><thead><tr>${head}</tr></thead><tbody>${body}${foot}</tbody></table>`;
}

function textTable(headers, rows, footer) {
    const allRows = [headers.map((h) => h.text), ...rows, ...(footer ? [footer] : [])].map((r) => r.map((c) => String(c ?? '')));
    const widths = headers.map((_, i) => Math.max(...allRows.map((r) => r[i].length)));
    return allRows.map((r) => r.map((c, i) => (headers[i].right ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

function paymentSections(payments) {
    const catH = [{ text: 'Payment' }, { text: 'Players', right: true }, { text: 'Amount', right: true }];
    const catRows = payments.by_category.map((c) => [c.category, c.count, dollars(c.amount_cents)]);
    const catFoot = ['Total', payments.by_category.reduce((n, c) => n + c.count, 0), dollars(payments.total_cents)];
    const methH = [{ text: 'Paid by' }, { text: 'Players', right: true }, { text: 'Amount', right: true }];
    const methRows = payments.by_method.map((m) => [m.method, m.count, dollars(m.amount_cents)]);
    const none = payments.by_category.length === 0;
    return {
        html: none ? '<p>No payments recorded.</p>' : table(catH, catRows, catFoot) + (methRows.length ? table(methH, methRows) : ''),
        text: none ? 'No payments recorded.' : `${textTable(catH, catRows, catFoot)}${methRows.length ? `\n\n${textTable(methH, methRows)}` : ''}`,
    };
}

function nameList(names) { return names.length ? names.join(', ') : 'None'; }

function renderSessionTally(t, { clubName = 'Game Scheduler', dateFormat = 'YMD' } = {}) {
    const date = formatDate(t.session.date, dateFormat);
    const title = `${t.session.label || 'Session'} - ${date}`;
    const c = t.counts;
    const pay = paymentSections(t.payments);

    const sumH = [{ text: 'Attendance' }, { text: 'Players', right: true }];
    const sumRows = [
        ['Players who attended', c.arrived],
        ['Pre-booked and arrived', c.prebooked_arrived],
        ['Arrived on the day (not pre-booked)', c.walk_ins],
        ['Pre-booked but did not arrive', c.prebooked_not_arrived],
        ['Left injured', c.left_injured],
        ['Left early', c.left_early],
    ];
    if (c.removed) sumRows.push(['Removed from the list by staff', c.removed]);

    const plH = [{ text: 'Player' }, { text: 'Grade' }, { text: 'Booked' }, { text: 'Payment' }, { text: 'Amount', right: true }, { text: 'Paid by' }, { text: 'Note' }];
    const plRows = t.players.map((p) => [p.name, p.skill_level || '', p.prebooked ? 'Pre-booked' : 'On the day', p.category || '-', p.amount_cents === null ? '-' : dollars(p.amount_cents), p.method || '-', [p.status, p.note].filter(Boolean).join(' - ')]);

    const subject = `${clubName} - session tally - ${title}`;
    const htmlBody = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
<h2 style="margin:0 0 4px;">${esc(clubName)}</h2>
<p style="margin:0 0 16px;color:#4b5563;">Session tally - ${esc(title)}</p>
<h3 style="${H3}">Payments</h3>
${pay.html}
<h3 style="${H3}">Attendance</h3>
${table(sumH, sumRows)}
<p style="margin:0 0 6px;"><strong>Left injured:</strong> ${esc(nameList(t.left_injured))}</p>
<p style="margin:0 0 6px;"><strong>Left early:</strong> ${esc(nameList(t.left_early))}</p>
${t.not_arrived.length ? `<p style="margin:0 0 6px;"><strong>Pre-booked but did not arrive:</strong> ${esc(nameList(t.not_arrived))}</p>` : ''}
${t.session.notes ? `<p style="margin:10px 0 6px;"><strong>Session notes:</strong><br>${esc(t.session.notes).replace(/\n/g, '<br>')}</p>` : ''}
<h3 style="${H3}">Players (${t.players.length})</h3>
${t.players.length ? table(plH, plRows) : '<p>No players attended.</p>'}
</div>`;
    const textBody = [
        `${clubName}`, `Session tally - ${title}`, '',
        'PAYMENTS', pay.text, '',
        'ATTENDANCE', textTable(sumH, sumRows), '',
        `Left injured: ${nameList(t.left_injured)}`,
        `Left early: ${nameList(t.left_early)}`,
        ...(t.not_arrived.length ? [`Pre-booked but did not arrive: ${nameList(t.not_arrived)}`] : []),
        ...(t.session.notes ? ['', `Session notes: ${t.session.notes}`] : []),
        '', `PLAYERS (${t.players.length})`, t.players.length ? textTable(plH, plRows) : 'No players attended.', '',
    ].join('\n');
    return { subject, htmlBody, textBody };
}

function renderMonthTally(m, { clubName = 'Game Scheduler', dateFormat = 'YMD' } = {}) {
    const pay = paymentSections(m.payments);
    const sH = [{ text: 'Date' }, { text: 'Session' }, { text: 'Attended', right: true }, { text: 'Pre-booked', right: true }, { text: 'On the day', right: true }, { text: 'No-shows', right: true }, { text: 'Injured', right: true }, { text: 'Left early', right: true }, { text: 'Takings', right: true }];
    const sRows = m.sessions.map((s) => [formatDate(s.date, dateFormat), s.label || 'Session', s.arrived, s.prebooked_arrived, s.walk_ins, s.prebooked_not_arrived, s.left_injured, s.left_early, dollars(s.total_cents)]);
    const tt = m.totals;
    const sFoot = ['Total', `${m.sessions.length} session${m.sessions.length === 1 ? '' : 's'}`, tt.arrived, tt.prebooked_arrived, tt.walk_ins, tt.prebooked_not_arrived, tt.left_injured, tt.left_early, dollars(tt.total_cents)];
    const pH = [{ text: 'Player' }, { text: 'Grade' }, { text: 'Sessions', right: true }, { text: 'Paid', right: true }];
    const pRows = m.players.map((p) => [p.name, p.skill_level || '', p.sessions, dollars(p.paid_cents)]);
    const incident = (list) => (list.length ? list.map((i) => `${i.name} (${formatDate(i.date, dateFormat)})`).join(', ') : 'None');

    const subject = `${clubName} - monthly tally - ${m.title}`;
    const htmlBody = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
<h2 style="margin:0 0 4px;">${esc(clubName)}</h2>
<p style="margin:0 0 16px;color:#4b5563;">Monthly tally - ${esc(m.title)}</p>
<h3 style="${H3}">Sessions</h3>
${table(sH, sRows, sFoot)}
<h3 style="${H3}">Payments for the month</h3>
${pay.html}
<p style="margin:0 0 6px;"><strong>Left injured:</strong> ${esc(incident(m.left_injured))}</p>
<p style="margin:0 0 6px;"><strong>Left early:</strong> ${esc(incident(m.left_early))}</p>
<h3 style="${H3}">Players (${m.unique_players} different players)</h3>
${table(pH, pRows)}
</div>`;
    const textBody = [
        `${clubName}`, `Monthly tally - ${m.title}`, '',
        'SESSIONS', textTable(sH, sRows, sFoot), '',
        'PAYMENTS FOR THE MONTH', pay.text, '',
        `Left injured: ${incident(m.left_injured)}`,
        `Left early: ${incident(m.left_early)}`, '',
        `PLAYERS (${m.unique_players} different players)`, textTable(pH, pRows), '',
    ].join('\n');
    return { subject, htmlBody, textBody };
}

module.exports = { sessionTally, monthTally, renderSessionTally, renderMonthTally, formatDate };
