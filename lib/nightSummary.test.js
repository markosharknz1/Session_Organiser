// The end-of-night summary and the lapsed-players list against a throwaway
// in-memory database. Run: node lib/nightSummary.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { nightSummary } = require('./nightSummary');
const { lapsedPlayers, lapsedCsv } = require('./lapsedPlayers');

let SQL;
let passed = 0;
let failed = 0;

async function freshDb() {
    if (!SQL) SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    db.run('INSERT INTO club_settings (id, square_enabled) VALUES (1, 1)');
    db.run(`INSERT INTO payment_categories (id, name) VALUES (1, 'Member'), (2, 'Non-Member')`);
    db.run(`INSERT INTO session_templates (id, label, day_of_week, start_time, end_time, default_mode) VALUES (1, 'Tuesday night', 'Tue', '19:30', '21:30', 'manual')`);
    for (let c = 1; c <= 3; c++) db.run('INSERT INTO courts (id, court_number, is_active) VALUES (?, ?, 1)', [c, c]);
    return db;
}

async function test(name, fn) {
    try {
        const db = await freshDb();
        await fn(db);
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.stack || err.message}`);
    }
}

function session(db, id, date, extra = {}) {
    const s = { template_id: 1, status: 'closed', mode: 'manual', record_results: 0, ...extra };
    db.run(`INSERT INTO sessions (id, template_id, date, label, status, mode, current_phase, record_results) VALUES (?, ?, ?, 'Tuesday night', ?, ?, 'idle', ?)`,
        [id, s.template_id, date, s.status, s.mode, s.record_results]);
}
function player(db, id, first, last, extra = {}) {
    db.run(`INSERT INTO players (id, first_name, last_name, skill_level, gender, membership_status, phone, email) VALUES (?, ?, ?, 'C', 'M', ?, ?, ?)`,
        [id, first, last, extra.status || 'active', extra.phone || null, extra.email || null]);
}
function attend(db, sessionId, playerId, extra = {}) {
    const a = { state: 'here_today', left_reason: null, leave_note: null, was_booked: 0, first_time: 0, new_member: 0, category: null, cents: null, method: null, ...extra };
    db.run(
        `INSERT INTO attendance (session_id, player_id, state, left_reason, leave_note, was_booked, first_time, new_member, payment_category_id, payment_amount_cents, payment_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, playerId, a.state, a.left_reason, a.leave_note, a.was_booked, a.first_time, a.new_member, a.category, a.cents, a.method]
    );
}
let gameId = 0;
function game(db, sessionId, round, court, players, { status = 'completed', winner = null } = {}) {
    gameId++;
    db.run(`INSERT INTO games (id, session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'doubles', 'manual', ?)`, [gameId, sessionId, court, round, status]);
    players.forEach((p, i) => db.run(`INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`, [gameId, p, i < 2 ? 1 : 2]));
    if (winner) db.run('INSERT INTO game_results (game_id, winner_side) VALUES (?, ?)', [gameId, winner]);
    return gameId;
}

// Tuesday 2 June: eight people on the list. Six stay to the end; Gus goes
// home early; Hal hurts his ankle; Ivy booked and never came; Jo was
// checked in by mistake and taken straight off again.
function clubNight(db, id = 10, date = '2026-06-02', extra = {}) {
    session(db, id, date, extra);
    const names = [[1, 'Ann', 'Ash'], [2, 'Bob', 'Birch'], [3, 'Cy', 'Cedar'], [4, 'Dee', 'Dogwood'], [5, 'Eve', 'Elm'], [6, 'Flo', 'Fir'], [7, 'Gus', 'Gum'], [8, 'Hal', 'Hazel'], [9, 'Ivy', 'Iroko'], [11, 'Jo', 'Juniper']];
    for (const [pid, first, last] of names) {
        if (!db.exec(`SELECT 1 FROM players WHERE id = ${pid}`).length) player(db, pid, first, last);
    }
    attend(db, id, 1, { category: 1, cents: 800, method: 'Cash' });
    attend(db, id, 2, { category: 1, cents: 800, method: 'Card' });
    attend(db, id, 3, { category: 2, cents: 1200, method: 'Cash', first_time: 1, new_member: 1 });
    attend(db, id, 4, { category: 1, cents: 800, method: 'Cash' });
    attend(db, id, 5, { category: 1, cents: 800, method: 'Cash' });
    attend(db, id, 6, { category: 1, cents: 800, method: 'Card' });
    attend(db, id, 7, { state: 'left', left_reason: 'departed', category: 1, cents: 800, method: 'Cash' });
    attend(db, id, 8, { state: 'left', left_reason: 'injured', leave_note: 'rolled ankle', category: 1, cents: 800, method: 'Cash' });
    attend(db, id, 9, { state: 'booked', was_booked: 1 });
    attend(db, id, 11, { state: 'left', left_reason: 'no-show' });
}

async function main() {
    console.log('=== End-of-night summary ===');

    await test('who came: arrivals only, with visitors, early leavers, injuries and no-shows named', async (db) => {
        clubNight(db);
        const s = nightSummary(db, 10);
        assert.strictEqual(s.players.came, 8, 'the booking that never arrived and the mistaken check-in are not counted');
        assert.deepStrictEqual(s.players.visitors, ['Cy Cedar']);
        assert.deepStrictEqual(s.players.left_early, ['Gus Gum']);
        assert.deepStrictEqual(s.players.injuries, [{ name: 'Hal Hazel', note: 'rolled ankle' }]);
        assert.deepStrictEqual(s.players.booked_did_not_come, ['Ivy Iroko']);
        assert.strictEqual(s.session.label, 'Tuesday night');
    });

    await test('there is nothing about money owed anywhere in the summary', async (db) => {
        clubNight(db);
        const text = JSON.stringify(nightSummary(db, 10)).toLowerCase();
        for (const word of ['owing', 'owed', 'unpaid', 'iou', 'debt']) assert.ok(!text.includes(word), `"${word}" appears in the summary`);
    });

    await test('the play: rounds, games, courts, and how evenly the games were shared among those who stayed', async (db) => {
        clubNight(db);
        game(db, 10, 1, 1, [1, 2, 3, 4]);
        game(db, 10, 1, 2, [5, 6, 7, 8]);
        game(db, 10, 2, 1, [1, 2, 5, 6]);
        game(db, 10, 3, 1, [1, 2, 3, 4], { status: 'active' }); // still on court when the night was finished
        game(db, 10, 4, 1, [3, 4, 5, 6], { status: 'staged' }); // never played
        const p = nightSummary(db, 10).play;
        assert.strictEqual(p.rounds, 3);
        assert.strictEqual(p.games, 4, 'the staged court does not count; the one still on court does');
        assert.strictEqual(p.courts, 2);
        // stayed to the end: Ann 3, Bob 3, Cy 2, Dee 2, Eve 2, Flo 2 (Gus and Hal left)
        assert.strictEqual(p.share.players, 6);
        assert.strictEqual(p.share.fewest, 2);
        assert.strictEqual(p.share.most, 3);
        assert.strictEqual(p.share.average, 2.3);
        assert.deepStrictEqual(p.share.fewest_players, ['Cy Cedar', 'Dee Dogwood', 'Eve Elm', 'Flo Fir'], 'in first-name order; the two who left are not named');
        assert.strictEqual(p.results, null, 'results were not being recorded tonight');
    });

    await test('when everyone had the same number of games nobody is singled out', async (db) => {
        clubNight(db);
        game(db, 10, 1, 1, [1, 2, 3, 4]);
        game(db, 10, 2, 1, [5, 6, 1, 2]);
        game(db, 10, 3, 1, [3, 4, 5, 6]);
        const share = nightSummary(db, 10).play.share;
        assert.strictEqual(share.fewest, 2);
        assert.strictEqual(share.most, 2);
        assert.deepStrictEqual(share.fewest_players, []);
    });

    await test('results entered, out of games played, on a night that records them', async (db) => {
        clubNight(db, 10, '2026-06-02', { record_results: 1 });
        game(db, 10, 1, 1, [1, 2, 3, 4], { winner: 1 });
        game(db, 10, 1, 2, [5, 6, 7, 8]);
        game(db, 10, 2, 1, [1, 2, 5, 6], { winner: 2 });
        assert.deepStrictEqual(nightSummary(db, 10).play.results, { recorded: 2, of: 3 });
    });

    await test('a social night, or a night with no games, has no play section', async (db) => {
        clubNight(db, 10, '2026-06-02', { mode: 'social' });
        assert.strictEqual(nightSummary(db, 10).play, null);
        clubNight(db, 12, '2026-06-09');
        assert.strictEqual(nightSummary(db, 12).play, null, 'manual night, nothing ever went on court');
    });

    await test('takings come with the summary when payment tracking is on, and not at all when it is off', async (db) => {
        clubNight(db);
        const money = nightSummary(db, 10).money;
        assert.strictEqual(money.total_funds_cents, 6800);
        const member = money.payment_breakdown.find((c) => c.category === 'Member');
        assert.strictEqual(member.count, 7);
        assert.strictEqual(member.methods.find((m) => m.method === 'Card').count, 2);
        db.run('UPDATE club_settings SET square_enabled = 0 WHERE id = 1');
        assert.strictEqual(nightSummary(db, 10).money, null);
    });

    await test('the usual turnout is the average of earlier nights from the same template', async (db) => {
        clubNight(db, 10, '2026-06-02');
        // two earlier Tuesdays: 4 came, then 6 came
        session(db, 1, '2026-05-19');
        for (const p of [1, 2, 3, 4]) attend(db, 1, p);
        attend(db, 1, 9, { state: 'booked', was_booked: 1 }); // not an arrival
        session(db, 2, '2026-05-26');
        for (const p of [1, 2, 3, 4, 5, 6]) attend(db, 2, p);
        // a night started by mistake and closed with nobody on it is not a night
        session(db, 3, '2026-05-29');
        // a later night must not count towards an earlier night's "usual"
        session(db, 20, '2026-06-09');
        for (const p of [1, 2]) attend(db, 20, p);
        assert.deepStrictEqual(nightSummary(db, 10).players.usual, { average: 5, nights: 2 });
        assert.strictEqual(nightSummary(db, 1).players.usual, null, 'the first night of its kind has nothing to compare with');
        session(db, 30, '2026-06-10', { template_id: null });
        attend(db, 30, 1);
        assert.strictEqual(nightSummary(db, 30).players.usual, null, 'a one-off night has no usual');
    });

    await test('an unknown session is null, not an error', async (db) => {
        assert.strictEqual(nightSummary(db, 999), null);
    });

    console.log('\n=== Lapsed players ===');

    // Weekly Tuesdays from 3 March to 26 May 2026 (13 nights, ids 101-113).
    function season(db) {
        const dates = [];
        for (let i = 0; i < 13; i++) {
            const d = new Date(Date.UTC(2026, 2, 3 + i * 7)).toISOString().slice(0, 10);
            dates.push(d);
            session(db, 101 + i, d);
        }
        return dates;
    }

    await test('a regular who stopped coming is listed; one still coming, and a one-off visitor, are not', async (db) => {
        season(db);
        player(db, 1, 'Zed', 'Regular', { phone: '0400 111 222', email: 'zed@example.org' }); // came 8 weeks running, then stopped (last 21 April)
        player(db, 2, 'Amy', 'Still'); // every week to the end
        player(db, 3, 'Vic', 'Visitor'); // once, in March
        for (let i = 0; i < 8; i++) attend(db, 101 + i, 1);
        for (let i = 0; i < 13; i++) attend(db, 101 + i, 2);
        attend(db, 102, 3);
        const r = lapsedPlayers(db, '2026-06-02'); // defaults: 4 weeks, 3 sessions, within 12 months
        assert.deepStrictEqual(r.players.map((p) => p.first_name), ['Zed']);
        const zed = r.players[0];
        assert.strictEqual(zed.last_came, '2026-04-21');
        assert.strictEqual(zed.first_came, '2026-03-03');
        assert.strictEqual(zed.weeks_away, 6);
        assert.strictEqual(zed.sessions, 8);
        assert.strictEqual(zed.sessions_last_12_weeks, 8);
        assert.strictEqual(zed.phone, '0400 111 222');
        assert.strictEqual(zed.email, 'zed@example.org');
    });

    await test('listed in first-name order', async (db) => {
        season(db);
        player(db, 1, 'Zed', 'Able');
        player(db, 2, 'amy', 'Zulu'); // lower case sorts with the rest
        player(db, 3, 'Mo', 'Middle');
        for (const p of [1, 2, 3]) for (let i = 0; i < 4; i++) attend(db, 101 + i, p);
        assert.deepStrictEqual(lapsedPlayers(db, '2026-06-02').players.map((p) => p.first_name), ['amy', 'Mo', 'Zed']);
    });

    await test('bookings that never arrived and mistaken check-ins are not attendance', async (db) => {
        season(db);
        player(db, 1, 'Zed', 'Regular');
        for (let i = 0; i < 4; i++) attend(db, 101 + i, 1); // last really came 24 March
        attend(db, 112, 1, { state: 'booked', was_booked: 1 }); // booked for 19 May, never came
        attend(db, 113, 1, { state: 'left', left_reason: 'no-show' });
        const r = lapsedPlayers(db, '2026-06-02');
        assert.strictEqual(r.players.length, 1);
        assert.strictEqual(r.players[0].last_came, '2026-03-24');
        assert.strictEqual(r.players[0].sessions, 4);
    });

    await test('the three settings: weeks away, how many sessions make a regular, and how far back to look', async (db) => {
        season(db);
        player(db, 1, 'Zed', 'Regular');
        for (let i = 0; i < 8; i++) attend(db, 101 + i, 1); // last came 21 April: 6 weeks before 2 June
        const names = (opts) => lapsedPlayers(db, '2026-06-02', opts).players.map((p) => p.first_name);
        assert.deepStrictEqual(names({ weeks: 6 }), ['Zed'], 'exactly 6 weeks away counts as 6 weeks');
        assert.deepStrictEqual(names({ weeks: 7 }), []);
        assert.deepStrictEqual(names({ minSessions: 8 }), ['Zed']);
        assert.deepStrictEqual(names({ minSessions: 9 }), []);
        // long gone: on 2 June 2028 Zed's last night is over two years back
        const later = (opts) => lapsedPlayers(db, '2028-06-02', opts).players.map((p) => p.first_name);
        assert.deepStrictEqual(later({}), [], 'outside the last 12 months by default');
        assert.deepStrictEqual(later({ withinMonths: 0 }), ['Zed'], '0 = no limit on how long ago');
        assert.deepStrictEqual(later({ withinMonths: 36 }), ['Zed']);
        const r = lapsedPlayers(db, '2026-06-02', { weeks: 'x', minSessions: '', withinMonths: undefined });
        assert.deepStrictEqual([r.weeks, r.min_sessions, r.within_months], [4, 3, 12], 'nonsense falls back to the defaults');
    });

    await test('"sessions in their last 12 weeks" shows how regular they were when they stopped', async (db) => {
        season(db);
        player(db, 1, 'Drift', 'Away');
        // came a lot last year, then only twice this season before stopping
        for (let i = 0; i < 6; i++) { session(db, 50 + i, `2025-09-${String(2 + i * 4).padStart(2, '0')}`); attend(db, 50 + i, 1); }
        attend(db, 101, 1);
        attend(db, 104, 1); // 24 March 2026
        const p = lapsedPlayers(db, '2026-06-02').players[0];
        assert.strictEqual(p.sessions, 8);
        assert.strictEqual(p.sessions_last_12_weeks, 2);
    });

    await test('the CSV carries the settings and one line per player, quoted where needed', async (db) => {
        season(db);
        player(db, 1, 'Zed', 'O\'Brien, Jr', { phone: '0400 111 222' });
        for (let i = 0; i < 4; i++) attend(db, 101 + i, 1);
        const csv = lapsedCsv(lapsedPlayers(db, '2026-06-02'));
        assert.ok(csv.includes('Not seen for (weeks or more),4'));
        assert.ok(csv.includes('Players,1'));
        assert.ok(csv.includes('Zed,"O\'Brien, Jr",C,active,2026-03-24,10,4,4,2026-03-03,0400 111 222,'), csv);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
