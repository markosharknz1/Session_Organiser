// Isolated tests for the auto-generate algorithm against a throwaway
// in-memory database - no shared state with the real dev/seed db, so these
// are safe to run any time. Run with: node lib/autoGenerate.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { generateRound, seededShuffle } = require('./autoGenerate');

let SQL;
let passed = 0;
let failed = 0;

async function freshDb() {
    if (!SQL) SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
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
        console.log(`        ${err.message}`);
    }
}

// --- Fixture helpers ---
const SESSION_ID = 1;

function addCourt(db, courtId, courtNumber) {
    db.run('INSERT INTO courts (id, court_number, is_active) VALUES (?, ?, 1)', [courtId, courtNumber]);
    db.run('INSERT INTO session_courts (session_id, court_id, in_use) VALUES (?, ?, 1)', [SESSION_ID, courtId]);
}

function addPlayer(db, id, skill, gender = 'M') {
    db.run(
        `INSERT INTO players (id, first_name, last_name, skill_level, gender, membership_status) VALUES (?, ?, ?, ?, ?, 'active')`,
        [id, `P${id}`, 'Test', skill, gender]
    );
    db.run(`INSERT INTO attendance (session_id, player_id, state) VALUES (?, ?, 'here_today')`, [SESSION_ID, id]);
}

function addPastGame(db, gameId, courtId, roundNumber, sides) {
    // sides: [[player_id, side], ...]
    db.run(
        `INSERT INTO games (id, session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'doubles', 'auto', 'completed')`,
        [gameId, SESSION_ID, courtId, roundNumber]
    );
    for (const [playerId, side] of sides) {
        db.run(
            `INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`,
            [gameId, playerId, side]
        );
    }
}

function addStagedGame(db, gameId, courtId, roundNumber, sides) {
    // sides: [[player_id, side], ...] - status 'staged', for the same-round
    // partial-build scenario (staging doesn't move attendance.state).
    db.run(
        `INSERT INTO games (id, session_id, court_id, round_number, format, mode, status) VALUES (?, ?, ?, ?, 'doubles', 'manual', 'staged')`,
        [gameId, SESSION_ID, courtId, roundNumber]
    );
    for (const [playerId, side] of sides) {
        db.run(
            `INSERT INTO game_players (game_id, player_id, side, skill_level_at_time) VALUES (?, ?, ?, 'C')`,
            [gameId, playerId, side]
        );
    }
}

function addPairingRule(db, a, b, ruleType) {
    db.run(`INSERT INTO pairing_rules (player_a_id, player_b_id, rule_type, scope) VALUES (?, ?, ?, 'permanent')`, [a, b, ruleType]);
}

function addCompat(db, a, b, allowed) {
    db.run(`INSERT INTO skill_compatibility (skill_a, skill_b, allowed) VALUES (?, ?, ?)`, [a, b, allowed ? 1 : 0]);
    if (a !== b) db.run(`INSERT INTO skill_compatibility (skill_a, skill_b, allowed) VALUES (?, ?, ?)`, [b, a, allowed ? 1 : 0]);
}

function playersInPlan(plan) {
    return plan.flatMap((g) => g.players.map((p) => p.player_id));
}

async function main() {
    console.log('\n=== Spec-named edge cases ===');

    await test('fewer players than one court needs -> generates nothing', async (db) => {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        for (let p = 1; p <= 3; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.deepStrictEqual(plan, []);
    });

    await test('exactly one full court worth, leftovers excluded', async (db) => {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        for (let p = 1; p <= 5; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 1);
        assert.strictEqual(plan[0].players.length, 4);
        const used = new Set(playersInPlan(plan));
        assert.strictEqual(used.size, 4, 'exactly 4 of the 5 players should be used, one left over');
    });

    await test('odd number of players fills as many full courts as possible', async (db) => {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        for (let p = 1; p <= 15; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 3); // floor(15/4) = 3
        const used = playersInPlan(plan);
        assert.strictEqual(used.length, 12);
        assert.strictEqual(new Set(used).size, 12, 'no player should be double-booked');
    });

    await test('all players at the same skill level does not crash and fills courts', async (db) => {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        for (let p = 1; p <= 8; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        for (const g of plan) {
            assert.strictEqual(g.players.filter((p) => p.side === 1).length, 2);
            assert.strictEqual(g.players.filter((p) => p.side === 2).length, 2);
        }
    });

    await test('no free courts -> generates nothing even with plenty of players', async (db) => {
        addCourt(db, 1, 1);
        for (let p = 1; p <= 8; p++) addPlayer(db, p, 'C');
        // court 1 already has a game this round
        addPastGame(db, 900, 1, 1, [[1, 1], [2, 1], [3, 2], [4, 2]]);
        const plan = generateRound(db, SESSION_ID, 1);
        assert.deepStrictEqual(plan, []);
    });

    await test('players already staged into another court this round are excluded from the pool', async (db) => {
        // Regression: staging doesn't change attendance.state, so a naive
        // pool query (state = 'here_today' only) would happily reuse players
        // already staged elsewhere in this round when filling remaining
        // empty courts - this must never double-book them.
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        for (let p = 1; p <= 8; p++) addPlayer(db, p, 'C');
        // Players 1-4 already staged (not played) on court 1 for round 1.
        addStagedGame(db, 901, 1, 1, [[1, 1], [2, 1], [3, 2], [4, 2]]);
        const plan = generateRound(db, SESSION_ID, 1);
        // Only court 2 is free; only players 5-8 remain eligible.
        assert.strictEqual(plan.length, 1);
        assert.strictEqual(plan[0].court_id, 2);
        const used = new Set(playersInPlan(plan));
        for (const p of [1, 2, 3, 4]) assert.ok(!used.has(p), `player ${p} is already staged this round and must not be reused`);
        for (const p of [5, 6, 7, 8]) assert.ok(used.has(p), `player ${p} should be available to fill the remaining court`);
    });

    console.log('\n=== Priority rule 1: avoid pairing (hard) ===');

    await test('avoid-paired players are never placed on the same team', async (db) => {
        addCourt(db, 1, 1);
        addPlayer(db, 1, 'C');
        addPlayer(db, 2, 'C');
        addPlayer(db, 3, 'C');
        addPlayer(db, 4, 'C');
        addPairingRule(db, 1, 2, 'avoid');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 1);
        const side1 = plan[0].players.filter((p) => p.side === 1).map((p) => p.player_id);
        const side2 = plan[0].players.filter((p) => p.side === 2).map((p) => p.player_id);
        const sameTeam = (side1.includes(1) && side1.includes(2)) || (side2.includes(1) && side2.includes(2));
        assert.strictEqual(sameTeam, false, 'players 1 and 2 must not be partnered');
    });

    await test('avoid-triangle across one bucket gets repaired via a swap with another bucket', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        // 8 players, skill-sorted into two buckets of 4: [1,2,3,4] and [5,6,7,8]
        for (let p = 1; p <= 8; p++) addPlayer(db, p, 'C');
        // 1,2,3 all mutually avoid each other - any split of a bucket containing all three has a hard violation
        addPairingRule(db, 1, 2, 'avoid');
        addPairingRule(db, 1, 3, 'avoid');
        addPairingRule(db, 2, 3, 'avoid');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        for (const g of plan) {
            const side1 = g.players.filter((p) => p.side === 1).map((p) => p.player_id);
            const side2 = g.players.filter((p) => p.side === 2).map((p) => p.player_id);
            for (const [a, b] of [[1, 2], [1, 3], [2, 3]]) {
                const sameTeam = (side1.includes(a) && side1.includes(b)) || (side2.includes(a) && side2.includes(b));
                assert.strictEqual(sameTeam, false, `avoid pair ${a}-${b} must not end up partnered after repair`);
            }
        }
    });

    console.log('\n=== Priority rule 2: sat-out-last-round (hard priority for selection) ===');

    await test('players who sat out last round are selected ahead of those who played', async (db) => {
        addCourt(db, 1, 1); // only room for 4 players
        for (let p = 1; p <= 8; p++) addPlayer(db, p, 'C');
        // players 1-4 played round 1; players 5-8 did not (sat out)
        addPastGame(db, 900, 1, 1, [[1, 1], [2, 1], [3, 2], [4, 2]]);
        const plan = generateRound(db, SESSION_ID, 2);
        assert.strictEqual(plan.length, 1);
        const used = new Set(playersInPlan(plan));
        for (const p of [5, 6, 7, 8]) assert.ok(used.has(p), `player ${p} sat out last round and should be prioritized`);
        for (const p of [1, 2, 3, 4]) assert.ok(!used.has(p), `player ${p} played last round and should not displace a sat-out player`);
    });

    await test('stage-ahead: players still marked "playing" (round 1 hasn\'t ended yet) remain eligible for round 2, and sat-out players still get priority', async (db) => {
        // Reproduces a real bug hit at a real club night: staging the next
        // round while the current one is still live used to only see
        // 'here_today' players, so a nearly-full roster (everyone mid-match)
        // read as "not enough players" even though everyone would be free
        // again well before the staged round actually started.
        addCourt(db, 1, 1);
        addCourt(db, 2, 2); // room for 2 courts (8 players)
        for (let p = 1; p <= 10; p++) addPlayer(db, p, 'C');
        // Round 1 (still in progress): players 1-6 are on court right now.
        addPastGame(db, 900, 1, 1, [[1, 1], [2, 1], [3, 2], [4, 2]]);
        addPastGame(db, 901, 2, 1, [[5, 1], [6, 1]]);
        for (const id of [1, 2, 3, 4, 5, 6]) {
            db.run(`UPDATE attendance SET state = 'playing' WHERE session_id = ? AND player_id = ?`, [SESSION_ID, id]);
        }
        // Players 7-10 sat out round 1 (still 'here_today').

        const plan = generateRound(db, SESSION_ID, 2);
        assert.strictEqual(plan.length, 2, 'both courts should fill even though most of the pool is still marked "playing"');
        const used = new Set(playersInPlan(plan));
        for (const p of [7, 8, 9, 10]) assert.ok(used.has(p), `player ${p} sat out round 1 and must be prioritized into round 2`);
        assert.strictEqual(used.size, 8, 'exactly 8 of the 10 available players should be used (2 full doubles courts)');
    });

    console.log('\n=== Priority rule 3: prefer pairing (soft) ===');

    await test('prefer-paired players are partnered when nothing else conflicts', async (db) => {
        addCourt(db, 1, 1);
        addPlayer(db, 1, 'C');
        addPlayer(db, 2, 'C');
        addPlayer(db, 3, 'C');
        addPlayer(db, 4, 'C');
        addPairingRule(db, 1, 2, 'prefer');
        const plan = generateRound(db, SESSION_ID, 1);
        const side1 = plan[0].players.filter((p) => p.side === 1).map((p) => p.player_id);
        const side2 = plan[0].players.filter((p) => p.side === 2).map((p) => p.player_id);
        const sameTeam = (side1.includes(1) && side1.includes(2)) || (side2.includes(1) && side2.includes(2));
        assert.strictEqual(sameTeam, true, 'preferred pair should be partnered when there is no conflicting constraint');
    });

    console.log('\n=== Priority rule 4: recent pairing avoidance (soft) ===');

    await test('recently-partnered players are not repartnered when an alternative split exists', async (db) => {
        addCourt(db, 1, 1);
        addPlayer(db, 1, 'C');
        addPlayer(db, 2, 'C');
        addPlayer(db, 3, 'C');
        addPlayer(db, 4, 'C');
        // round 1: 1&2 partnered against two players (5,6) who aren't in tonight's round-2
        // pool at all - so the only "recent" pair among {1,2,3,4} is 1-2 itself, not
        // every combination, which is what makes an alternative split actually better.
        addPastGame(db, 900, 1, 1, [[1, 1], [2, 1], [5, 2], [6, 2]]);
        const plan = generateRound(db, SESSION_ID, 2);
        const side1 = plan[0].players.filter((p) => p.side === 1).map((p) => p.player_id);
        const side2 = plan[0].players.filter((p) => p.side === 2).map((p) => p.player_id);
        const onePartneredWithTwo = (side1.includes(1) && side1.includes(2)) || (side2.includes(1) && side2.includes(2));
        assert.strictEqual(onePartneredWithTwo, false, '1 and 2 just played together and should be split up when an alternative exists');
    });

    console.log('\n=== Priority rule 5: skill_compatibility matrix ===');

    await test('an incompatible skill combination is avoided when a compatible split exists', async (db) => {
        addCourt(db, 1, 1);
        addPlayer(db, 1, 'A');
        addPlayer(db, 2, 'A');
        addPlayer(db, 3, 'E');
        addPlayer(db, 4, 'B');
        // A-E explicitly disallowed; everything else allowed by default (permissive fallback)
        addCompat(db, 'A', 'E', false);
        addCompat(db, 'A', 'A', true);
        addCompat(db, 'A', 'B', true);
        addCompat(db, 'B', 'E', true);
        const plan = generateRound(db, SESSION_ID, 1);
        const side1 = plan[0].players.filter((p) => p.side === 1).map((p) => p.player_id);
        const side2 = plan[0].players.filter((p) => p.side === 2).map((p) => p.player_id);
        const aAndEPartnered = (side1.includes(1) && side1.includes(3)) || (side2.includes(1) && side2.includes(3));
        assert.strictEqual(aAndEPartnered, false, 'players 1 (A) and 3 (E) should not be forced into an explicitly disallowed partnership when avoidable');
    });

    console.log('\n=== Priority rule 6b: gender-aware pairing ===');

    function courtGenderTier(game, genderById) {
        const side1 = game.players.filter((p) => p.side === 1).map((p) => genderById[p.player_id]);
        const side2 = game.players.filter((p) => p.side === 2).map((p) => genderById[p.player_id]);
        const same = (pair) => pair[0] === pair[1];
        const mixed = (pair) => pair[0] !== pair[1];
        if (mixed(side1) && mixed(side2)) return 1;
        if (same(side1) && same(side2)) return side1[0] === side2[0] ? 1 : 3;
        return 2;
    }

    function courtGenderType(game, genderById) {
        const genders = game.players.map((p) => genderById[p.player_id]);
        const women = genders.filter((g) => g === 'F').length;
        if (women === 4) return 'ladies';
        if (women === 0) return "men's";
        return 'mixed-or-other';
    }

    await test('balanced pool (4 men, 4 women) - every court reaches tier 1 (mixed pairs or same-gender)', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        addPlayer(db, 1, 'C', 'M');
        addPlayer(db, 2, 'C', 'M');
        addPlayer(db, 3, 'C', 'M');
        addPlayer(db, 4, 'C', 'M');
        addPlayer(db, 5, 'C', 'F');
        addPlayer(db, 6, 'C', 'F');
        addPlayer(db, 7, 'C', 'F');
        addPlayer(db, 8, 'C', 'F');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        const genderById = { 1: 'M', 2: 'M', 3: 'M', 4: 'M', 5: 'F', 6: 'F', 7: 'F', 8: 'F' };
        for (const game of plan) {
            assert.strictEqual(courtGenderTier(game, genderById), 1, 'a perfectly balanced 4M/4F pool should always reach tier 1');
        }
    });

    await test('male-heavy pool (7 men, 1 woman) - degrades gracefully, never an invalid court', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        for (let p = 1; p <= 7; p++) addPlayer(db, p, 'C', 'M');
        addPlayer(db, 8, 'C', 'F');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        const genderById = { 1: 'M', 2: 'M', 3: 'M', 4: 'M', 5: 'M', 6: 'M', 7: 'M', 8: 'F' };
        const tiers = plan.map((g) => courtGenderTier(g, genderById)).sort();
        assert.deepStrictEqual(tiers, [1, 2], 'with only one woman in the pool, one court is a same-gender tier 1 court and the other is an unavoidable 3-1 tier 2 - never tier 3, never invalid');
        for (const g of plan) assert.strictEqual(g.players.length, 4);
    });

    await test('female-heavy pool (7 women, 1 man) - mirrors the male-heavy case', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        for (let p = 1; p <= 7; p++) addPlayer(db, p, 'C', 'F');
        addPlayer(db, 8, 'C', 'M');
        const plan = generateRound(db, SESSION_ID, 1);
        const genderById = { 1: 'F', 2: 'F', 3: 'F', 4: 'F', 5: 'F', 6: 'F', 7: 'F', 8: 'M' };
        const tiers = plan.map((g) => courtGenderTier(g, genderById)).sort();
        assert.deepStrictEqual(tiers, [1, 2]);
    });

    await test('women scattered thin across a male-heavy pool (18 men, 6 women, 6 courts) still reaches tier 1 everywhere', async (db) => {
        // Reproduces a real bad outcome at a real club night: with women
        // outnumbered 3-to-1 and scattered ~one-per-bucket by a gender-blind
        // skill sort, the old post-hoc single-swap repair could only fix one
        // opposite-skewed *pair* of buckets - it left 4 of 6 courts as a 3-1
        // split even though a better arrangement was available (6 of 6 at
        // tier 1 instead of 2 of 6). With only 6 women, forming one ladies'
        // doubles (4) plus one mixed doubles (2+2) is the only way to use
        // them all without a leftover - see the even-mix test below for a
        // pool with enough women to actually balance ladies' vs mixed.
        for (let c = 1; c <= 6; c++) addCourt(db, c, c);
        for (let p = 1; p <= 18; p++) addPlayer(db, p, 'C', 'M');
        for (let p = 19; p <= 24; p++) addPlayer(db, p, 'C', 'F');
        const genderById = Object.fromEntries(
            Array.from({ length: 24 }, (_, i) => i + 1).map((id) => [id, id <= 18 ? 'M' : 'F'])
        );
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 6);
        const tiers = plan.map((g) => courtGenderTier(g, genderById));
        assert.ok(tiers.every((t) => t === 1), `every court should reach tier 1 - got tiers ${tiers.join(',')}`);
        const types = plan.map((g) => courtGenderType(g, genderById));
        assert.strictEqual(types.filter((t) => t === 'ladies').length, 1, 'the 6 women should form exactly one ladies\' doubles court');
        assert.strictEqual(types.filter((t) => t === 'mixed-or-other').length, 1, 'and exactly one mixed doubles court with the 2 remaining women');
        assert.strictEqual(types.filter((t) => t === "men's").length, 4, 'leaving 4 all-male courts from the remaining men');
    });

    await test('with plenty of both genders, ladies\' doubles and mixed doubles come out roughly even rather than always favoring one', async (db) => {
        for (let c = 1; c <= 6; c++) addCourt(db, c, c);
        for (let p = 1; p <= 12; p++) addPlayer(db, p, 'C', 'M');
        for (let p = 13; p <= 24; p++) addPlayer(db, p, 'C', 'F');
        const genderById = Object.fromEntries(
            Array.from({ length: 24 }, (_, i) => i + 1).map((id) => [id, id <= 12 ? 'M' : 'F'])
        );
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 6);
        const tiers = plan.map((g) => courtGenderTier(g, genderById));
        assert.ok(tiers.every((t) => t === 1), `every court should reach tier 1 - got tiers ${tiers.join(',')}`);
        const types = plan.map((g) => courtGenderType(g, genderById));
        const ladiesCount = types.filter((t) => t === 'ladies').length;
        const mixedCount = types.filter((t) => t === 'mixed-or-other').length;
        assert.ok(ladiesCount > 0 && mixedCount > 0, `expected both ladies' and mixed courts to appear, got types ${types.join(',')}`);
        assert.ok(Math.abs(ladiesCount - mixedCount) <= 1, `ladies' (${ladiesCount}) and mixed (${mixedCount}) counts should be roughly even, not skewed to one type`);
    });

    await test('skill-compatibility restrictions still produce valid, non-crashing courts alongside gender tiering', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        addPlayer(db, 1, 'A', 'M');
        addPlayer(db, 2, 'A', 'F');
        addPlayer(db, 3, 'E', 'M');
        addPlayer(db, 4, 'E', 'F');
        addPlayer(db, 5, 'A', 'M');
        addPlayer(db, 6, 'A', 'F');
        addPlayer(db, 7, 'E', 'M');
        addPlayer(db, 8, 'E', 'F');
        addCompat(db, 'A', 'E', false); // A and E can never be matched, partner or opponent
        addCompat(db, 'A', 'A', true);
        addCompat(db, 'E', 'E', true);
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        for (const g of plan) {
            assert.strictEqual(g.players.length, 4, 'every generated court must be a complete, valid 4-player doubles game');
            const ids = g.players.map((p) => p.player_id);
            assert.strictEqual(new Set(ids).size, 4, 'no duplicate player across a court');
        }
    });

    await test('gender_aware_pairing = 0 disables the swap - matches pure skill-based bucketing', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        db.run('INSERT INTO club_settings (id, gender_aware_pairing) VALUES (1, 0)');
        addPlayer(db, 1, 'C', 'M');
        addPlayer(db, 2, 'C', 'M');
        addPlayer(db, 3, 'C', 'M');
        addPlayer(db, 4, 'C', 'F');
        addPlayer(db, 5, 'C', 'M');
        addPlayer(db, 6, 'C', 'F');
        addPlayer(db, 7, 'C', 'F');
        addPlayer(db, 8, 'C', 'F');

        // All 8 are the same skill, so bucketing is purely the per-round
        // shuffled tiebreak order (see the "court mixing" follow-on -
        // the tiebreak used to be raw player_id, now it's a seeded per-round
        // shuffle) - predict it the same way generateRound() computes it
        // rather than assuming a fixed id-ascending order.
        const roundSeed = SESSION_ID * 1000 + 1;
        const tiebreakOrder = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], roundSeed);
        const predictedBuckets = [new Set(tiebreakOrder.slice(0, 4)), new Set(tiebreakOrder.slice(4, 8))];
        const predictedBucketWithPlayer4 = predictedBuckets.find((b) => b.has(4));

        const plan = generateRound(db, SESSION_ID, 1);
        const gameWithPlayer4 = plan.find((g) => playersInPlan([g]).includes(4));
        const actualBucketWithPlayer4 = new Set(playersInPlan([gameWithPlayer4]));

        assert.deepStrictEqual(
            [...actualBucketWithPlayer4].sort((a, b) => a - b),
            [...predictedBucketWithPlayer4].sort((a, b) => a - b),
            'with the setting off, player 4 should stay in whatever bucket the skill/tiebreak sort naturally placed them in - no cross-bucket gender swap should happen'
        );
    });

    await test('gender_aware_pairing = 1 (explicit) performs the same swap as the default-on behaviour', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        db.run('INSERT INTO club_settings (id, gender_aware_pairing) VALUES (1, 1)');
        addPlayer(db, 1, 'C', 'M');
        addPlayer(db, 2, 'C', 'M');
        addPlayer(db, 3, 'C', 'M');
        addPlayer(db, 4, 'C', 'F');
        addPlayer(db, 5, 'C', 'M');
        addPlayer(db, 6, 'C', 'F');
        addPlayer(db, 7, 'C', 'F');
        addPlayer(db, 8, 'C', 'F');
        const plan = generateRound(db, SESSION_ID, 1);
        const genderById = { 1: 'M', 2: 'M', 3: 'M', 4: 'F', 5: 'M', 6: 'F', 7: 'F', 8: 'F' };
        for (const game of plan) {
            assert.strictEqual(courtGenderTier(game, genderById), 1, 'the fixable 3-1/1-3 split should be repaired into two tier 1 courts when the setting is on');
        }
    });

    console.log('\n=== Round-to-round variety (court + pairing mixing) ===');

    await test('court assignment varies round to round for an unchanged pool', async (db) => {
        for (let c = 1; c <= 4; c++) addCourt(db, c, c);
        for (let p = 1; p <= 16; p++) addPlayer(db, p, 'C');
        const plan1 = generateRound(db, SESSION_ID, 1);
        const plan2 = generateRound(db, SESSION_ID, 2);
        const courtOf = (plan, playerId) => plan.find((g) => playersInPlan([g]).includes(playerId))?.court_id;
        const samePlayers = Array.from({ length: 16 }, (_, i) => i + 1);
        const sameCourtCount = samePlayers.filter((id) => courtOf(plan1, id) === courtOf(plan2, id)).length;
        assert.ok(sameCourtCount < 16, 'at least some players should land on a different court between rounds for an identical pool - court assignment should not be pinned to skill rank every round');
    });

    await test('who plays with whom varies round to round for an unchanged pool', async (db) => {
        for (let c = 1; c <= 4; c++) addCourt(db, c, c);
        for (let p = 1; p <= 16; p++) addPlayer(db, p, 'C');
        // No round 1 result is actually persisted here, so rule 4 (recent
        // pairing avoidance) has nothing recorded to work from - any
        // difference between these two plans comes from the round-seeded
        // bucketing shuffle alone, isolating exactly what this test covers.
        const plan1 = generateRound(db, SESSION_ID, 1);
        const plan2 = generateRound(db, SESSION_ID, 2);
        const courtMatesOf = (plan, playerId) => new Set(playersInPlan(plan.filter((g) => playersInPlan([g]).includes(playerId))));
        const group1 = [...courtMatesOf(plan1, 1)].sort((a, b) => a - b);
        const group2 = [...courtMatesOf(plan2, 1)].sort((a, b) => a - b);
        assert.notDeepStrictEqual(group1, group2, 'player 1 should not be grouped with the exact same court-mates in consecutive rounds for a pool this size - bucketing should mix across the pool, not always form the same pods');
    });

    // The two tests above use all-male fixtures (addPlayer's gender default),
    // which never exercises formBuckets' gender-aware branch at all (an
    // all-one-gender pool has women.length===0, so it falls straight through
    // to the plain skill-order chunking path) - even though gender-aware
    // pairing is club_settings' real default. A stable, gender-mixed roster
    // spanning more than one skill tier is exactly the scenario that shipped
    // broken: skill-sort alone always pulled the same lowest-skill subset of
    // women into the first bucket every round, no matter how many rounds
    // passed, since nothing about *selection* ever changed for an unchanging
    // pool - only pairing *within* that fixed group ever varied.
    console.log('\n=== Round-to-round variety: gender-aware bucket composition (mixed skill) ===');

    await test('bucket MEMBERSHIP (not just partner pairing) rotates round to round when women span multiple skill tiers', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        // 8 women across 4 skill tiers, 2 per tier - skill-sort alone always
        // puts the same 2 tiers (A,A,B,B) in the first bucket every round;
        // only a bucket-membership rotation can vary this for a pool this
        // stable, since every player is selected every round (no cut).
        addPlayer(db, 1, 'A', 'F');
        addPlayer(db, 2, 'A', 'F');
        addPlayer(db, 3, 'B', 'F');
        addPlayer(db, 4, 'B', 'F');
        addPlayer(db, 5, 'C', 'F');
        addPlayer(db, 6, 'C', 'F');
        addPlayer(db, 7, 'D', 'F');
        addPlayer(db, 8, 'D', 'F');

        const bucketSetsForPlayer1 = [];
        for (let round = 1; round <= 8; round++) {
            const plan = generateRound(db, SESSION_ID, round);
            const game = plan.find((g) => playersInPlan([g]).includes(1));
            bucketSetsForPlayer1.push(playersInPlan([game]).sort((a, b) => a - b).join(','));
        }
        const distinctBucketSets = new Set(bucketSetsForPlayer1);
        assert.ok(
            distinctBucketSets.size > 1,
            `player 1's bucket-mates should vary across rounds for a pool spanning multiple skill tiers, but every round produced the same group: ${bucketSetsForPlayer1[0]}`
        );
    });

    await test('bucket composition rotation still produces valid gender tiers and skill-adjacent groupings', async (db) => {
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        addPlayer(db, 1, 'A', 'F');
        addPlayer(db, 2, 'A', 'F');
        addPlayer(db, 3, 'B', 'F');
        addPlayer(db, 4, 'B', 'F');
        addPlayer(db, 5, 'C', 'F');
        addPlayer(db, 6, 'C', 'F');
        addPlayer(db, 7, 'D', 'F');
        addPlayer(db, 8, 'D', 'F');
        const genderById = { 1: 'F', 2: 'F', 3: 'F', 4: 'F', 5: 'F', 6: 'F', 7: 'F', 8: 'F' };
        for (let round = 1; round <= 8; round++) {
            const plan = generateRound(db, SESSION_ID, round);
            assert.strictEqual(plan.length, 2, `round ${round} should stage both courts`);
            for (const game of plan) {
                assert.strictEqual(courtGenderTier(game, genderById), 1, `round ${round}: an all-women bucket should still read as tier 1 (same-gender court)`);
            }
        }
    });

    console.log('\n=== Selection: gender balance across the round-to-round split ===');

    // Reproduces a real night: 56 players on 7 courts = two 28-player halves
    // taking alternate rounds. The women sit mostly in the lower grades, so
    // a plain "top 28 by skill" first cut put 6 women in one half and 12 in
    // the other - and sat-out priority then locked that in all night.
    function buildFiftySix(db) {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        const skills = ['A', 'B', 'C', 'D', 'E'];
        const genderById = {};
        for (let p = 1; p <= 56; p++) {
            // 18 women: ids 39-56, all D/E grade (the skew that triggered it)
            const isWoman = p >= 39;
            const skill = isWoman ? (p % 2 ? 'D' : 'E') : skills[p % 5];
            addPlayer(db, p, skill, isWoman ? 'F' : 'M');
            genderById[p] = isWoman ? 'F' : 'M';
        }
        return genderById;
    }
    const womenIn = (plan, genderById) => playersInPlan(plan).filter((id) => genderById[id] === 'F').length;

    await test('56 players / 7 courts: round 1 takes the pool\'s share of women (9 of 18), not whatever the skill cut yields', async (db) => {
        const genderById = buildFiftySix(db);
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 7);
        assert.strictEqual(womenIn(plan, genderById), 9, 'half the women should play round 1');
    });

    await test('56 players / 7 courts: the other half (round 2) is the complement and also carries 9 women', async (db) => {
        const genderById = buildFiftySix(db);
        const round1 = generateRound(db, SESSION_ID, 1);
        round1.forEach((g, i) => addPastGame(db, 900 + i, g.court_id, 1, g.players.map((p) => [p.player_id, p.side])));
        const round2 = generateRound(db, SESSION_ID, 2);
        assert.strictEqual(round2.length, 7);
        const r1 = new Set(playersInPlan(round1));
        for (const id of playersInPlan(round2)) assert.ok(!r1.has(id), `player ${id} played round 1 and should sit out round 2`);
        assert.strictEqual(womenIn(round2, genderById), 9, 'the sat-out half should carry the other 9 women');
    });

    await test('sat-out priority still beats gender balance: 4 sat-out men fill the only court ahead of 4 women who just played', async (db) => {
        addCourt(db, 1, 1);
        for (let p = 1; p <= 4; p++) addPlayer(db, p, 'C', 'F');
        for (let p = 5; p <= 8; p++) addPlayer(db, p, 'C', 'M');
        addPastGame(db, 900, 1, 1, [[1, 1], [2, 1], [3, 2], [4, 2]]);
        const plan = generateRound(db, SESSION_ID, 2);
        assert.deepStrictEqual(playersInPlan(plan).sort((a, b) => a - b), [5, 6, 7, 8]);
    });

    await test('a partial cut through the rest tier still tops women up toward the pool ratio', async (db) => {
        // 12 players (6 women), room for 8: 4 women should play, not the
        // 2 that a pure skill order would give (women are all lower grade).
        addCourt(db, 1, 1);
        addCourt(db, 2, 2);
        const genderById = {};
        for (let p = 1; p <= 6; p++) { addPlayer(db, p, 'A', 'M'); genderById[p] = 'M'; }
        for (let p = 7; p <= 12; p++) { addPlayer(db, p, 'D', 'F'); genderById[p] = 'F'; }
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        assert.strictEqual(womenIn(plan, genderById), 4);
    });

    console.log('\n=== Fair rotation over a night (rule 2, games played) ===');

    // A real night: 50 players, 7 courts (28 play, 22 sit out each round).
    // 4 A-graders, then B/C/D/E; a third of the pool women.
    function buildFifty(db) {
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        const grades = ['A', 'A', 'A', 'A', ...Array(10).fill('B'), ...Array(20).fill('C'), ...Array(12).fill('D'), 'E', 'E', 'E', 'E'];
        grades.forEach((g, i) => addPlayer(db, i + 1, g, (i + 1) % 3 === 0 ? 'F' : 'M'));
    }
    function playRounds(db, count) {
        const rounds = [];
        for (let r = 1; r <= count; r++) {
            const plan = generateRound(db, SESSION_ID, r);
            plan.forEach((g, i) => addPastGame(db, r * 100 + i, g.court_id, r, g.players.map((p) => [p.player_id, p.side])));
            rounds.push(plan);
        }
        return rounds;
    }
    const courtKeys = (plan) => plan.map((g) => g.players.map((p) => p.player_id).sort((a, b) => a - b).join('-'));

    await test('50 players / 7 courts: the leftover slots rotate - nobody is ever more than one game ahead of anyone else', async (db) => {
        // Before the fix the leftover 6 slots after the sat-out tier went to
        // the top of the skill order every round: the four A-graders played
        // 8 of 8 rounds while 42 players got 4.
        buildFifty(db);
        const rounds = playRounds(db, 8);
        const played = {};
        for (const plan of rounds) for (const id of playersInPlan(plan)) played[id] = (played[id] || 0) + 1;
        const counts = [];
        for (let id = 1; id <= 50; id++) counts.push(played[id] || 0);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `games played ranged ${Math.min(...counts)}-${Math.max(...counts)}`);
        for (const a of [1, 2, 3, 4]) assert.ok(played[a] <= 5, `A-grader ${a} played ${played[a]} of 8 rounds`);
    });

    await test('50 players / 7 courts: the four A-graders are not put on one court together in consecutive rounds', async (db) => {
        buildFifty(db);
        const rounds = playRounds(db, 8);
        let prev = false;
        for (const [i, plan] of rounds.entries()) {
            const together = courtKeys(plan).includes('1-2-3-4');
            assert.ok(!(together && prev), `all four A-graders on one court in rounds ${i} and ${i + 1}`);
            prev = together;
        }
    });

    await test('a court that just played together is broken up next round, even when skill order would rebuild it', async (db) => {
        // 8 players, 2 courts: 4 A-graders and 4 B-graders. Skill-tight
        // bucketing rebuilds the same two courts every round; only the
        // swap pass (repairRecentGroups) mixes them.
        addCourt(db, 1, 1); addCourt(db, 2, 2);
        for (let p = 1; p <= 4; p++) addPlayer(db, p, 'A');
        for (let p = 5; p <= 8; p++) addPlayer(db, p, 'B');
        const rounds = playRounds(db, 5);
        assert.ok(courtKeys(rounds[0]).includes('1-2-3-4'), 'round 1 should still be skill-tight: the A-graders together');
        for (let r = 1; r < rounds.length; r++) {
            const prevKeys = new Set(courtKeys(rounds[r - 1]));
            for (const k of courtKeys(rounds[r])) assert.ok(!prevKeys.has(k), `round ${r + 1} repeats round ${r}'s court ${k}`);
        }
    });

    await test('the breakup swap never overrides an avoid-pair or sat-out priority', async (db) => {
        addCourt(db, 1, 1); addCourt(db, 2, 2);
        for (let p = 1; p <= 4; p++) addPlayer(db, p, 'A');
        for (let p = 5; p <= 8; p++) addPlayer(db, p, 'B');
        addPlayer(db, 9, 'A'); addPlayer(db, 10, 'A'); addPlayer(db, 11, 'B'); addPlayer(db, 12, 'B');
        addPairingRule(db, 1, 5, 'avoid');
        const rounds = playRounds(db, 6);
        for (let r = 1; r < rounds.length; r++) {
            const prevIds = new Set(playersInPlan(rounds[r - 1]));
            const satOut = [];
            for (let id = 1; id <= 12; id++) if (!prevIds.has(id)) satOut.push(id);
            const used = new Set(playersInPlan(rounds[r]));
            for (const id of satOut) assert.ok(used.has(id), `round ${r + 1}: player ${id} sat out round ${r} and must play`);
            for (const g of rounds[r]) {
                const side = (id) => g.players.find((p) => p.player_id === id)?.side;
                assert.ok(!(side(1) && side(1) === side(5)), `round ${r + 1}: avoid-pair 1 & 5 partnered`);
            }
        }
    });

    console.log('\n=== Singles sessions (e.g. squash) ===');

    function singlesSession(db) {
        db.run(`INSERT INTO sessions (id, date, label, status, mode, format, current_phase) VALUES (?, '2026-07-01', 'Squash', 'open', 'auto', 'singles', 'idle')`, [SESSION_ID]);
    }

    await test('a singles session fills each court with exactly 2 players, one a side', async (db) => {
        singlesSession(db);
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        for (let p = 1; p <= 9; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 4, 'floor(9/2) = 4 courts');
        for (const g of plan) {
            assert.strictEqual(g.format, 'singles');
            assert.deepStrictEqual(g.players.map((p) => p.side).sort(), [1, 2]);
        }
        assert.strictEqual(new Set(playersInPlan(plan)).size, 8, 'no player on two courts');
    });

    await test('singles opponents come from the same grade when the numbers allow', async (db) => {
        singlesSession(db);
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        const skills = { 1: 'A', 2: 'A', 3: 'B', 4: 'B', 5: 'C', 6: 'C', 7: 'D', 8: 'D' };
        for (const [id, skill] of Object.entries(skills)) addPlayer(db, Number(id), skill);
        const plan = generateRound(db, SESSION_ID, 1);
        for (const g of plan) {
            const [a, b] = g.players.map((p) => skills[p.player_id]);
            assert.strictEqual(a, b, `court ${g.court_id}: ${a} vs ${b} should be the same grade`);
        }
    });

    await test('singles: an avoid-pair never meets, even when they are the only two in a grade', async (db) => {
        singlesSession(db);
        for (let c = 1; c <= 7; c++) addCourt(db, c, c);
        addPlayer(db, 1, 'A'); addPlayer(db, 2, 'A');
        addPlayer(db, 3, 'B'); addPlayer(db, 4, 'B');
        addPairingRule(db, 1, 2, 'avoid');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 2);
        for (const g of plan) {
            const ids = g.players.map((p) => p.player_id).sort();
            assert.notDeepStrictEqual(ids, [1, 2], 'players 1 and 2 must not be put on the same court');
        }
    });

    await test('singles: a rematch from last round is avoided when another pairing exists', async (db) => {
        singlesSession(db);
        addCourt(db, 1, 1); addCourt(db, 2, 2);
        for (let p = 1; p <= 4; p++) addPlayer(db, p, 'C');
        const round1 = generateRound(db, SESSION_ID, 1);
        round1.forEach((g, i) => addPastGame(db, 900 + i, g.court_id, 1, g.players.map((p) => [p.player_id, p.side])));
        const round2 = generateRound(db, SESSION_ID, 2);
        const key = (g) => g.players.map((p) => p.player_id).sort((a, b) => a - b).join('-');
        const r1 = new Set(round1.map(key));
        for (const g of round2) assert.ok(!r1.has(key(g)), `round 2 repeats round 1's matchup ${key(g)}`);
    });

    await test('a doubles session (the default) is unaffected: still 4 a court', async (db) => {
        db.run(`INSERT INTO sessions (id, date, label, status, mode, current_phase) VALUES (?, '2026-07-01', 'Doubles', 'open', 'auto', 'idle')`, [SESSION_ID]);
        addCourt(db, 1, 1);
        for (let p = 1; p <= 4; p++) addPlayer(db, p, 'C');
        const plan = generateRound(db, SESSION_ID, 1);
        assert.strictEqual(plan.length, 1);
        assert.strictEqual(plan[0].format, 'doubles');
        assert.strictEqual(plan[0].players.length, 4);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
