// Tally report (History > Email a report) against a throwaway in-memory
// database. Run: node lib/tallyReport.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { sessionTally, monthTally, renderSessionTally, renderMonthTally, formatDate } = require('./tallyReport');

let SQL;
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        if (!SQL) SQL = await initSqlJs();
        const db = new SQL.Database();
        db.run(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
        seed(db);
        await fn(db);
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

// Two October sessions and one in November.
//   Session 1 (2026-10-06): Ann pre-booked + arrived (Member $5 cash);
//     Bob walked in (Non-Member $10 card), left injured; Cy walked in
//     (Member $5 cash), left early; Di pre-booked and never arrived (still
//     'booked'); Ed's booking was cancelled (no-show); Flo was removed and
//     checked back in (two rows - counted once), Member $5 card.
//   Session 2 (2026-10-13): Ann walked in (Member $5 cash); Gus walked in,
//     no payment recorded.
//   Session 3 (2026-11-03): Bob (Non-Member $10 cash).
function seed(db) {
    const names = [[1, 'Ann', 'Archer', 'B'], [2, 'Bob', 'Baker', 'C'], [3, 'Cy', 'Cole', 'C'], [4, 'Di', 'Dunn', 'A'], [5, 'Ed', 'East', 'D'], [6, 'Flo', 'Ford', 'B'], [7, 'Gus', 'Gray', 'E']];
    for (const [id, f, l, s] of names) db.run(`INSERT INTO players (id, first_name, last_name, skill_level, membership_status) VALUES (?, ?, ?, ?, 'active')`, [id, f, l, s]);
    db.run(`INSERT INTO payment_categories (id, name, is_active) VALUES (1, 'Member', 1), (2, 'Non-Member', 1)`);
    db.run(`INSERT INTO sessions (id, date, label, status, mode, current_phase, notes) VALUES (1, '2026-10-06', 'Tuesday night', 'closed', 'manual', 'idle', 'Sold 2 shirts'), (2, '2026-10-13', 'Tuesday night', 'closed', 'manual', 'idle', NULL), (3, '2026-11-03', 'Tuesday night', 'closed', 'manual', 'idle', NULL)`);
    const att = (session, player, state, opts = {}) => db.run(
        `INSERT INTO attendance (session_id, player_id, state, left_reason, leave_note, was_booked, payment_category_id, payment_amount_cents, payment_method, payment_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [session, player, state, opts.reason || null, opts.leaveNote || null, opts.booked ? 1 : 0, opts.cat || null, opts.cents ?? null, opts.method || null, opts.note || null]
    );
    att(1, 1, 'here_today', { booked: true, cat: 1, cents: 500, method: 'Cash' });
    att(1, 2, 'left', { reason: 'injured', leaveNote: 'rolled ankle on court 3, ice applied', cat: 2, cents: 1000, method: 'Card' });
    att(1, 3, 'left', { reason: 'departed', cat: 1, cents: 500, method: 'Cash' });
    att(1, 4, 'booked', { booked: true });
    att(1, 5, 'left', { reason: 'no-show', booked: true });
    att(1, 6, 'left', { reason: 'removed', cat: 1, cents: 500, method: 'Card' });
    att(1, 6, 'here_today', { cat: 1, cents: 500, method: 'Card', note: 'paid at the bar' });
    att(1, 7, 'left', { reason: 'no-show' }); // Gus: checked in by mistake and undone - counts nowhere
    att(2, 1, 'here_today', { cat: 1, cents: 500, method: 'Cash' });
    att(2, 7, 'here_today');
    att(3, 2, 'here_today', { cat: 2, cents: 1000, method: 'Cash' });
}

async function main() {
    await test('session tally: attendance counts separate pre-booked, walk-ins and no-shows', async (db) => {
        const t = sessionTally(db, 1);
        assert.deepStrictEqual(t.counts, { arrived: 4, prebooked: 3, prebooked_arrived: 1, prebooked_not_arrived: 2, walk_ins: 3, left_injured: 1, left_early: 1, removed: 0 });
        assert.deepStrictEqual(t.left_injured, ['Bob Baker']);
        assert.deepStrictEqual(t.injuries, [{ name: 'Bob Baker', note: 'rolled ankle on court 3, ice applied' }]);
        assert.deepStrictEqual(t.left_early, ['Cy Cole']);
        assert.deepStrictEqual(t.not_arrived, ['Di Dunn', 'Ed East']);
    });

    await test('session tally: a player removed and checked back in is counted once, by their latest row', async (db) => {
        const t = sessionTally(db, 1);
        const flo = t.players.filter((p) => p.name === 'Flo Ford');
        assert.strictEqual(flo.length, 1);
        assert.strictEqual(flo[0].status, '');
        assert.strictEqual(flo[0].note, 'paid at the bar');
        assert.strictEqual(t.counts.removed, 0);
    });

    await test('session tally: payments by category and by method add up, and people who left still count', async (db) => {
        const t = sessionTally(db, 1);
        assert.deepStrictEqual(t.payments.by_category, [{ category: 'Member', count: 3, amount_cents: 1500 }, { category: 'Non-Member', count: 1, amount_cents: 1000 }]);
        assert.deepStrictEqual(t.payments.by_method, [{ method: 'Card', count: 2, amount_cents: 1500 }, { method: 'Cash', count: 2, amount_cents: 1000 }]);
        assert.strictEqual(t.payments.total_cents, 2500);
    });

    await test('session tally: the player list is everyone who attended, in surname order, with booking and payment', async (db) => {
        const t = sessionTally(db, 1);
        assert.deepStrictEqual(t.players.map((p) => p.name), ['Ann Archer', 'Bob Baker', 'Cy Cole', 'Flo Ford']);
        assert.deepStrictEqual(t.players.map((p) => p.prebooked), [true, false, false, false]);
        assert.strictEqual(t.players[1].status, 'Left injured: rolled ankle on court 3, ice applied');
        assert.strictEqual(t.players[2].status, 'Left early');
    });

    await test('session tally: someone with no payment recorded shows as such and adds nothing to the takings', async (db) => {
        const t = sessionTally(db, 2);
        assert.deepStrictEqual(t.payments.by_category.map((c) => c.category), ['Member', 'No payment recorded']);
        assert.strictEqual(t.payments.total_cents, 500);
        assert.strictEqual(t.players.find((p) => p.name === 'Gus Gray').amount_cents, null);
    });

    await test('session tally: unknown session is null', async (db) => {
        assert.strictEqual(sessionTally(db, 999), null);
    });

    await test('rendered session email has the tables, the names and the notes - in HTML and plain text', async (db) => {
        const r = renderSessionTally(sessionTally(db, 1), { clubName: 'Riverside Club', dateFormat: 'DMY' });
        assert.strictEqual(r.subject, 'Riverside Club - session tally - Tuesday night - 06/10/2026');
        for (const body of [r.htmlBody, r.textBody]) {
            assert.ok(body.includes('Pre-booked and arrived'), 'attendance table');
            assert.ok(body.includes('Bob Baker (rolled ankle on court 3, ice applied)'), 'injured player named, with the note');
            assert.ok(body.includes('Di Dunn, Ed East'), 'no-shows named');
            assert.ok(body.includes('Sold 2 shirts'), 'session notes');
            assert.ok(body.includes('$25'), 'total takings');
        }
        assert.ok(!/<script/i.test(r.htmlBody));
    });

    await test('names and notes are escaped in the HTML', async (db) => {
        db.run(`UPDATE players SET last_name = '<b>Archer</b>' WHERE id = 1`);
        db.run(`UPDATE sessions SET notes = 'a < b & c' WHERE id = 1`);
        const r = renderSessionTally(sessionTally(db, 1));
        assert.ok(r.htmlBody.includes('&lt;b&gt;Archer&lt;/b&gt;'));
        assert.ok(!r.htmlBody.includes('<b>Archer</b>'));
        assert.ok(r.htmlBody.includes('a &lt; b &amp; c'));
    });

    await test('month tally: one row per session, totals, payments, incidents and a player list for the month', async (db) => {
        const m = monthTally(db, '2026-10');
        assert.strictEqual(m.title, 'October 2026');
        assert.deepStrictEqual(m.sessions.map((s) => [s.date, s.arrived, s.prebooked_arrived, s.walk_ins, s.prebooked_not_arrived, s.total_cents]), [['2026-10-06', 4, 1, 3, 2, 2500], ['2026-10-13', 2, 0, 2, 0, 500]]);
        assert.strictEqual(m.totals.arrived, 6);
        assert.strictEqual(m.totals.total_cents, 3000);
        assert.strictEqual(m.unique_players, 5);
        assert.deepStrictEqual(m.players.find((p) => p.name === 'Ann Archer'), { player_id: 1, first_name: 'Ann', last_name: 'Archer', name: 'Ann Archer', skill_level: 'B', sessions: 2, paid_cents: 1000 });
        assert.deepStrictEqual(m.left_injured, [{ date: '2026-10-06', label: 'Tuesday night', name: 'Bob Baker', note: 'rolled ankle on court 3, ice applied' }]);
        assert.strictEqual(m.payments.by_category.find((c) => c.category === 'Member').amount_cents, 2000);
    });

    await test('month tally: only that month; a month with no sessions or a bad month is null', async (db) => {
        assert.strictEqual(monthTally(db, '2026-11').sessions.length, 1);
        assert.strictEqual(monthTally(db, '2026-12'), null);
        assert.strictEqual(monthTally(db, '2026-13'), null);
        assert.strictEqual(monthTally(db, 'October'), null);
    });

    await test('rendered month email', async (db) => {
        const r = renderMonthTally(monthTally(db, '2026-10'), { clubName: 'Riverside Club', dateFormat: 'DMY' });
        assert.strictEqual(r.subject, 'Riverside Club - monthly tally - October 2026');
        for (const body of [r.htmlBody, r.textBody]) {
            assert.ok(body.includes('13/10/2026'));
            assert.ok(body.includes('2 sessions'));
            assert.ok(body.includes('Bob Baker (06/10/2026 - rolled ankle on court 3, ice applied)'));
            assert.ok(body.includes('5 different players'));
            assert.ok(body.includes('$30'));
        }
    });

    await test('formatDate follows the club setting', async () => {
        assert.strictEqual(formatDate('2026-10-06', 'DMY'), '06/10/2026');
        assert.strictEqual(formatDate('2026-10-06', 'MDY'), '10/06/2026');
        assert.strictEqual(formatDate('2026-10-06', 'YMD'), '2026-10-06');
        assert.strictEqual(formatDate('2026-10-06'), '2026-10-06');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
