// Auto-generate algorithm: builds one round's worth of games from the
// here_today pool - doubles (4 a court) or, for a singles session such as
// squash, one-on-one (2 a court; see formSinglesGames) - following the
// spec's priority order:
//   1. avoid pairing rules       - hard, never violated (partner-level)
//   2. sat-out-last-round        - hard priority for who gets selected to play;
//      after that, fewest games played tonight goes first (see loadGamesPlayed)
//   3. prefer pairing rules      - soft, applied where possible
//   4. recent pairing avoidance  - soft, partner AND opponent history
//   5. skill_compatibility       - soft-but-weighted matrix check
//   6. skill spread + gender tier - minimize skill spread and prefer a mixed
//      pair or same-gender court over a 3-1 gender split or segregated
//      sides; both lowest priority, gated by club_settings.gender_aware_pairing
//
// Pure and read-only: takes a db handle + session/round, returns a proposed
// list of court assignments. Never writes to the database itself - callers
// (lib/roundLifecycle.js) decide whether/how to persist the plan. This split
// is what makes it possible to unit-test against a throwaway in-memory db
// (see autoGenerate.test.js) instead of the real one.
const { all, get } = require('../db/index');

const DEFAULT_LOOKBACK_ROUNDS = 4; // "recent" pairing window; not yet club-editable (open spec question)
const SKILL_RANK = { A: 0, B: 1, C: 2, D: 3, E: 4 };

function pairKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// Deterministic seeded PRNG (not Math.random()) - a given session+round
// always reproduces the exact same plan, which the auto-generate preview
// and the test suite both depend on, but the seed itself changes every
// round so results vary round to round instead of being pinned forever.
function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function seededShuffle(array, seed) {
    const rand = seededRandom(seed);
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function loadPairRuleSet(db, ruleType) {
    // pairing_rules has no session_id column in the current schema, so
    // session_only-scoped rules can't be filtered to a specific session -
    // every row of the requested rule_type is treated as active. Flagged as
    // a known gap alongside the spec's other open pairing-rule questions.
    const rows = all(db, 'SELECT player_a_id, player_b_id FROM pairing_rules WHERE rule_type = ?', [ruleType]);
    return new Set(rows.map((r) => pairKey(r.player_a_id, r.player_b_id)));
}

function loadCompatibility(db) {
    const rows = all(db, 'SELECT skill_a, skill_b, allowed FROM skill_compatibility');
    const map = new Map();
    for (const r of rows) map.set(`${r.skill_a}-${r.skill_b}`, !!r.allowed);
    return (a, b) => {
        if (map.has(`${a}-${b}`)) return map.get(`${a}-${b}`);
        if (map.has(`${b}-${a}`)) return map.get(`${b}-${a}`);
        return true; // no explicit rule -> permissive default
    };
}

function loadSatOutLastRound(db, sessionId, roundNumber, poolIds) {
    if (roundNumber <= 1) return new Set(); // no "last round" to compare against
    const playedLast = all(
        db,
        `SELECT DISTINCT gp.player_id FROM games g JOIN game_players gp ON gp.game_id = g.id
         WHERE g.session_id = ? AND g.round_number = ?`,
        [sessionId, roundNumber - 1]
    ).map((r) => r.player_id);
    const playedSet = new Set(playedLast);
    return new Set(poolIds.filter((id) => !playedSet.has(id)));
}

// Games each player has had so far tonight (rounds before this one).
// Decides who fills the slots left after the sat-out tier: fewest games
// first. Without this the leftover slots went to the top of the skill
// order every single round - at a real 50-player, 7-court night the four
// A-graders played every round of the evening (and, being the top skill
// tier, kept landing on one court together) while everyone else waited
// for every second round.
function loadGamesPlayed(db, sessionId, roundNumber) {
    const rows = all(
        db,
        `SELECT gp.player_id, COUNT(*) AS n FROM games g JOIN game_players gp ON gp.game_id = g.id
         WHERE g.session_id = ? AND g.round_number < ? GROUP BY gp.player_id`,
        [sessionId, roundNumber]
    );
    return new Map(rows.map((r) => [r.player_id, r.n]));
}

// Pairs who shared a court in the lookback window, as a Map of pair key ->
// weight: 2 for the round just played, 1 for older rounds. The weight is
// what keeps "same court as last round" the worst outcome even once a
// small pool has cycled through every pairing (8 players over 4 rounds and
// every pair is "recent" - unweighted, that's no signal at all).
function loadRecentPairs(db, sessionId, roundNumber, lookback) {
    const fromRound = Math.max(1, roundNumber - lookback);
    const rows = all(
        db,
        `SELECT g.id AS game_id, g.round_number, gp.player_id FROM games g JOIN game_players gp ON gp.game_id = g.id
         WHERE g.session_id = ? AND g.round_number >= ? AND g.round_number < ?`,
        [sessionId, fromRound, roundNumber]
    );
    const byGame = new Map();
    for (const r of rows) {
        if (!byGame.has(r.game_id)) byGame.set(r.game_id, { round: r.round_number, players: [] });
        byGame.get(r.game_id).players.push(r.player_id);
    }
    const recent = new Map();
    for (const { round, players } of byGame.values()) {
        const weight = round === roundNumber - 1 ? 2 : 1;
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const key = pairKey(players[i], players[j]);
                recent.set(key, Math.max(recent.get(key) || 0, weight));
            }
        }
    }
    return recent;
}

// Breaks up a court whose four players were all together recently. Bucket
// membership is formed by skill (with pair rotation), so a stable top
// tier - say the club's only four A-graders - can be re-bucketed together
// round after round; the recent-pairing rule alone can only rotate the
// partner split inside that fixed group. This is a greedy single-swap
// hill-climb between buckets using the same score the final split uses
// (recent partners/opponents, prefer-pairs, compatibility, gender tier)
// plus a penalty on each bucket's skill spread, so a swap only happens
// when what it saves in repeat matchups outweighs the grades it mixes -
// one repeat pair on a court doesn't justify a swap, a whole repeated
// court does.
const SPREAD_PENALTY = 12;
function bucketCost(bucket, avoidSet, preferSet, recentSet, isCompatible, genderAware) {
    const ranks = bucket.map((p) => SKILL_RANK[p.skill_level]);
    const spread = Math.max(...ranks) - Math.min(...ranks);
    return bestSplit(bucket, avoidSet, preferSet, recentSet, isCompatible, genderAware).score + spread * SPREAD_PENALTY;
}

function repairRecentGroups(buckets, avoidSet, preferSet, recentSet, isCompatible, genderAware) {
    const cost = (b) => bucketCost(b, avoidSet, preferSet, recentSet, isCompatible, genderAware);
    const costs = buckets.map(cost);
    for (let pass = 0; pass < 4; pass++) {
        let improved = false;
        for (let i = 0; i < buckets.length; i++) {
            for (let j = i + 1; j < buckets.length; j++) {
                let best = null;
                for (let bi = 0; bi < buckets[i].length; bi++) {
                    for (let bj = 0; bj < buckets[j].length; bj++) {
                        const newI = buckets[i].slice();
                        const newJ = buckets[j].slice();
                        [newI[bi], newJ[bj]] = [newJ[bj], newI[bi]];
                        const total = cost(newI) + cost(newJ);
                        if (total < costs[i] + costs[j] - 0.001 && (!best || total < best.total)) best = { newI, newJ, total };
                    }
                }
                if (best) {
                    buckets[i] = best.newI;
                    buckets[j] = best.newJ;
                    costs[i] = cost(best.newI);
                    costs[j] = cost(best.newJ);
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
}

// --- Gender-aware pairing (rule 6, gated by club_settings.gender_aware_pairing) ---
// A player's gender only participates when it's exactly 'M' or 'F' - anything
// else (null, unset) opts that player, and any bucket/split touching them,
// out of gender scoring entirely rather than guessing.
function knownGender(player) {
    return player.gender === 'M' || player.gender === 'F' ? player.gender : null;
}

// Best gender tier a specific 2v2 split can score: 1 = mixed pairs (one man +
// one woman on each side) or a same-gender court (all 4 the same); 3 =
// segregated sides (one side all-men, the other all-women) despite the court
// itself being 2 men/2 women; 2 = a 3-1 split - every split of a 3-1 bucket
// scores the same tier, since one side is unavoidably mixed 1-1 regardless of
// which player goes where.
function genderTier(team1, team2) {
    const g1 = [knownGender(team1[0]), knownGender(team1[1])];
    const g2 = [knownGender(team2[0]), knownGender(team2[1])];
    if (g1.includes(null) || g2.includes(null)) return null; // unknown gender - opt out

    const same = (pair) => pair[0] === pair[1];
    const mixed = (pair) => pair[0] !== pair[1];
    if (mixed(g1) && mixed(g2)) return 1;
    if (same(g1) && same(g2)) return g1[0] === g2[0] ? 1 : 3; // all-one-gender court vs. segregated sides
    return 2;
}

const GENDER_TIER_PENALTY = { 1: 0, 2: 30, 3: 60 };

// Scores one way of splitting a 4-player bucket into two teams of 2.
// Lower is better. hardViolation flags an avoid-pair placed as partners.
function scoreSplit(team1, team2, avoidSet, preferSet, recentSet, isCompatible, genderAware) {
    let score = 0;
    let hardViolation = false;

    for (const [x, y] of [team1, team2]) {
        const key = pairKey(x.player_id, y.player_id);
        if (avoidSet.has(key)) {
            hardViolation = true;
            score += 100000;
        }
        if (preferSet.has(key)) score -= 50;
        if (recentSet.has(key)) score += 20 * recentSet.get(key); // recent partners (x2 if last round)
        if (!isCompatible(x.skill_level, y.skill_level)) score += 5000;
    }
    for (const x of team1) {
        for (const y of team2) {
            const key = pairKey(x.player_id, y.player_id);
            if (recentSet.has(key)) score += 10 * recentSet.get(key); // recent opponents (x2 if last round)
            if (!isCompatible(x.skill_level, y.skill_level)) score += 2000;
        }
    }
    const avg = (team) => (SKILL_RANK[team[0].skill_level] + SKILL_RANK[team[1].skill_level]) / 2;
    score += Math.abs(avg(team1) - avg(team2)) * 5;
    if (genderAware) {
        const tier = genderTier(team1, team2);
        if (tier !== null) score += GENDER_TIER_PENALTY[tier];
    }
    return { score, hardViolation };
}

// The 3 ways to split 4 players [a,b,c,d] into two unordered teams of 2.
function splitOptions([a, b, c, d]) {
    return [
        { team1: [a, b], team2: [c, d] },
        { team1: [a, c], team2: [b, d] },
        { team1: [a, d], team2: [b, c] },
    ];
}

function bestSplit(bucket, avoidSet, preferSet, recentSet, isCompatible, genderAware) {
    let best = null;
    for (const opt of splitOptions(bucket)) {
        const { score, hardViolation } = scoreSplit(opt.team1, opt.team2, avoidSet, preferSet, recentSet, isCompatible, genderAware);
        if (!best || (best.hardViolation && !hardViolation) || (best.hardViolation === hardViolation && score < best.score)) {
            best = { ...opt, score, hardViolation };
        }
    }
    return best;
}

// If every split of a bucket still has a hard avoid-violation (only possible
// with 3+ mutually-avoiding players in one bucket of 4 - rare), try a single
// swap with another bucket to break up the conflict.
function repairHardViolations(buckets, avoidSet, preferSet, recentSet, isCompatible, genderAware) {
    const results = buckets.map((b) => bestSplit(b, avoidSet, preferSet, recentSet, isCompatible, genderAware));
    for (let i = 0; i < buckets.length; i++) {
        if (!results[i].hardViolation) continue;
        let fixed = false;
        for (let j = 0; j < buckets.length && !fixed; j++) {
            if (i === j) continue;
            for (let bi = 0; bi < buckets[i].length && !fixed; bi++) {
                for (let bj = 0; bj < buckets[j].length && !fixed; bj++) {
                    const newI = buckets[i].slice();
                    const newJ = buckets[j].slice();
                    [newI[bi], newJ[bj]] = [newJ[bj], newI[bi]];
                    const splitI = bestSplit(newI, avoidSet, preferSet, recentSet, isCompatible, genderAware);
                    const splitJ = bestSplit(newJ, avoidSet, preferSet, recentSet, isCompatible, genderAware);
                    if (!splitI.hardViolation && !splitJ.hardViolation) {
                        buckets[i] = newI;
                        buckets[j] = newJ;
                        results[i] = splitI;
                        results[j] = splitJ;
                        fixed = true;
                    }
                }
            }
        }
        if (!fixed) {
            console.warn(`[autoGenerate] could not resolve an avoid-pair conflict in a group of 4 - leaving as best-effort`);
        }
    }
    return results;
}

// Which gender tier a *bucket's composition* can possibly reach, before any
// split is chosen - 4-0/0-4/2-2 can reach tier 1 (see genderTier above); 3-1
// can only ever reach tier 2, no matter how it's split.
function bucketGenderCeiling(bucket) {
    const genders = bucket.map(knownGender);
    if (genders.includes(null)) return null; // unknown gender present - opt out
    const men = genders.filter((g) => g === 'M').length;
    return men === 4 || men === 0 || men === 2 ? 1 : 2;
}

// Forms buckets of 4 from the (already skill/priority-sorted) selected
// group. Gender-aware bucketing alternates between an all-women bucket
// (ladies' doubles) and a 2-women-2-men bucket (mixed doubles) as long as
// both remain possible, aiming for a roughly even split between the two
// rather than always defaulting to one (e.g. always maximizing mixed
// courts and never offering ladies' doubles even when there's easily
// enough women for both). Falls back to whichever type is still possible
// once the other runs out - e.g. out of men mid-way through just keeps
// forming ladies' doubles from the rest of the women. Everyone left over
// (extra men, unknown-gender players, a too-small leftover group of women)
// fills out the remaining buckets in plain skill order, same as the
// non-aware path. This intentionally forms buckets gender-first: a *post
// hoc* single-swap patch between opposite-skewed bucket pairs (an earlier
// approach) could only fix one pair at a time, so it did nothing when the
// minority gender ended up scattered roughly one-per-bucket across the
// whole pool - a real, bad outcome hit at a real club night, not just a
// theoretical one.
// A small 32-bit integer hash (the "triple32" mix) to decorrelate seeds
// that differ only slightly - consecutive rounds' roundSeed values differ
// by just 1, and the shared LCG in seededRandom's first couple of outputs
// are strongly correlated for nearby seeds on a short array (4-6 pairs).
// Left unmixed, rotateBucketOrder below only ever swapped the outermost
// pair round to round instead of genuinely varying which pairs group
// together - caught by this file's own bucket-rotation test, not a
// hypothetical concern.
function hashSeed(seed) {
    let x = seed >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
}

// Groups an already skill-sorted list into skill-adjacent PAIRS, then
// round-seeds which pairs end up adjacent to each other. This is what lets
// bucket MEMBERSHIP itself rotate round to round for a stable roster -
// shuffling individual players directly would risk pairing a top grade
// with a bottom grade; shuffling already-adjacent pairs keeps every bucket
// skill-tight (serves rule 6) while still rotating who ends up bucketed
// together. Without this, formBuckets below would always pull the exact
// same lowest-skill 4 women (or men) into the first bucket every single
// round whenever the pool spans more than one skill tier - only the
// partner split *within* that fixed group would ever change, not who was
// in it. Real complaint from real use (a stable mixed-gender roster saw
// identical courts night after night), not just theoretical.
function rotateBucketOrder(sortedBySkill, seed) {
    const pairs = [];
    for (let i = 0; i < sortedBySkill.length; i += 2) pairs.push(sortedBySkill.slice(i, i + 2));
    return seededShuffle(pairs, hashSeed(seed)).flat();
}

function formBuckets(skillSorted, genderAware, roundSeed) {
    if (!genderAware) {
        const buckets = [];
        for (let i = 0; i < skillSorted.length; i += 4) buckets.push(skillSorted.slice(i, i + 4));
        return buckets;
    }

    const women = rotateBucketOrder(skillSorted.filter((p) => p.gender === 'F'), roundSeed * 11 + 5);
    const men = rotateBucketOrder(skillSorted.filter((p) => p.gender === 'M'), roundSeed * 13 + 7);

    const buckets = [];
    const usedIds = new Set();
    let wi = 0;
    let mi = 0;
    let preferLadies = true;
    for (;;) {
        const womenLeft = women.length - wi;
        const menLeft = men.length - mi;
        const canLadies = womenLeft >= 4;
        const canMixed = womenLeft >= 2 && menLeft >= 2;
        if (!canLadies && !canMixed) break;

        const doLadies = canLadies && canMixed ? preferLadies : canLadies;
        const group = doLadies
            ? women.slice(wi, wi + 4)
            : [...women.slice(wi, wi + 2), ...men.slice(mi, mi + 2)];
        buckets.push(group);
        for (const p of group) usedIds.add(p.player_id);
        if (doLadies) wi += 4; else { wi += 2; mi += 2; }
        preferLadies = !doLadies; // alternate which type gets tried first next time
    }

    // Everyone not used above - remaining men, unknown-gender players, and
    // any leftover women too few to complete a group - buckets in plain
    // skill order, same as the non-aware path. This is where an
    // unavoidable 3-1 bucket comes from, if the pool's ratio makes one
    // unavoidable.
    const remaining = skillSorted.filter((p) => !usedIds.has(p.player_id));
    for (let i = 0; i < remaining.length; i += 4) buckets.push(remaining.slice(i, i + 4));

    return buckets;
}

// Best-effort, single-swap defensive cleanup (same idiom as
// repairHardViolations) for anything formBuckets couldn't resolve by
// construction - e.g. two still-imbalanced buckets that both ended up in
// the leftover pool above. A bucket stuck at ceiling 2 (3-1) can only be
// fixed by trading a majority-gender player with a bucket skewed the
// *other* way (3M1F paired with 1M3F - swapping one of each turns both into
// 2M2F). If every ceiling-2 bucket skews the same direction, there's no fix
// available and they're left as the pool allows. Runs before
// repairHardViolations, since avoid-pairs are the higher-priority rule and
// may reshuffle buckets further - gender tier is the lowest priority and
// yields to that if the two ever conflict.
function repairGenderTiers(buckets) {
    const fixed = new Set();
    for (let i = 0; i < buckets.length; i++) {
        if (fixed.has(i) || bucketGenderCeiling(buckets[i]) !== 2) continue;
        const menI = buckets[i].filter((p) => knownGender(p) === 'M').length;
        const minorityI = menI > 2 ? 'F' : 'M'; // the lone gender in this 3-1 bucket
        for (let j = 0; j < buckets.length; j++) {
            if (j === i || fixed.has(j) || bucketGenderCeiling(buckets[j]) !== 2) continue;
            const menJ = buckets[j].filter((p) => knownGender(p) === 'M').length;
            const minorityJ = menJ > 2 ? 'F' : 'M';
            if (minorityI === minorityJ) continue; // same skew - a swap can't help either

            const majorityI = minorityI === 'F' ? 'M' : 'F';
            const idxI = buckets[i].findIndex((p) => knownGender(p) === majorityI);
            const idxJ = buckets[j].findIndex((p) => knownGender(p) === minorityI);
            [buckets[i][idxI], buckets[j][idxJ]] = [buckets[j][idxJ], buckets[i][idxI]];
            fixed.add(i);
            fixed.add(j);
            break;
        }
    }
}

// Returns [{ court_id, format: 'doubles', players: [{player_id, side}, ...] }, ...]
// or [] if there aren't enough present players (or free courts) for even one
// full doubles court - callers must treat [] as "could not generate", not as
// "generated zero games on purpose".
// Picks who plays this round when the pool is bigger than the courts. The
// sat-out tier is taken first in full (rule 2, hard priority); the cut
// happens inside whichever tier only partly fits. Within that cut tier the
// pick is stratified by gender so the selected group carries the pool's
// own women/men ratio, not whatever the skill order happens to produce.
//
// Why: a real night - 56 players, 7 courts, so two 28-player halves taking
// alternate rounds - came out with 6 women in one half and 12 in the other,
// because the first round simply took the top 28 by skill and the women
// happened to sit lower in the grades. Sat-out priority then locked those
// two halves in for the rest of the night, so the 12-women half played
// mixed doubles round after round (one man played three mixed games in a
// row) while the other half barely could. Balancing the initial cut makes
// both halves ~9 women, and the same logic keeps a messier roster (say 50
// players) drifting toward balance rather than away from it.
//
// Each tier arrives skill-sorted; within a gender the first N are taken, so
// the existing skill-first tiebreak is preserved inside each gender group.
function selectForRound(satOutTier, restTier, neededPlayers) {
    const isWoman = (p) => p.gender === 'F';
    const pool = [...satOutTier, ...restTier];
    const targetWomen = pool.length ? Math.round(neededPlayers * pool.filter(isWoman).length / pool.length) : 0;
    const selected = [];
    for (const tier of [satOutTier, restTier]) {
        const need = neededPlayers - selected.length;
        if (need <= 0) break;
        if (tier.length <= need) {
            selected.push(...tier);
            continue;
        }
        const women = tier.filter(isWoman);
        const men = tier.filter((p) => !isWoman(p));
        const womenSoFar = selected.filter(isWoman).length;
        let takeWomen = Math.max(0, Math.min(women.length, targetWomen - womenSoFar));
        let takeMen = need - takeWomen;
        if (takeMen > men.length) {
            takeMen = men.length;
            takeWomen = need - takeMen;
        }
        selected.push(...women.slice(0, takeWomen), ...men.slice(0, takeMen));
    }
    return selected;
}

// Singles: each court is one player against one. Opponents are drawn from
// the same grade wherever the numbers allow (shuffled within each grade,
// with a different seed each round, so the same two people don't keep
// meeting), then a swap pass between courts clears any avoid-pair, a
// rematch from the recent-rounds window, or an incompatible grade
// combination - taking whichever swap lowers the total the most. Gender
// tiers don't apply: there are no partners to pair up.
function formSinglesGames(skillSorted, avoidSet, recentSet, isCompatible, roundSeed) {
    const byGrade = new Map();
    for (const p of skillSorted) {
        if (!byGrade.has(p.skill_level)) byGrade.set(p.skill_level, []);
        byGrade.get(p.skill_level).push(p);
    }
    const ordered = [];
    for (const [grade, group] of [...byGrade.entries()].sort((a, b) => SKILL_RANK[a[0]] - SKILL_RANK[b[0]])) {
        ordered.push(...seededShuffle(group, hashSeed(roundSeed * 17 + SKILL_RANK[grade])));
    }
    const games = [];
    for (let i = 0; i + 1 < ordered.length; i += 2) games.push([ordered[i], ordered[i + 1]]);

    const badness = ([a, b]) => {
        const key = pairKey(a.player_id, b.player_id);
        if (avoidSet.has(key)) return 100;
        let score = 0;
        if (!isCompatible(a.skill_level, b.skill_level)) score += 10;
        if (recentSet.has(key)) score += 1;
        return score;
    };

    for (let pass = 0; pass < 3; pass++) {
        let improved = false;
        for (let i = 0; i < games.length; i++) {
            if (badness(games[i]) === 0) continue;
            let best = null;
            for (let j = 0; j < games.length; j++) {
                if (i === j) continue;
                for (const [gi, gj] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
                    const ni = games[i].slice();
                    const nj = games[j].slice();
                    [ni[gi], nj[gj]] = [nj[gj], ni[gi]];
                    const gain = badness(games[i]) + badness(games[j]) - badness(ni) - badness(nj);
                    if (gain > 0 && (!best || gain > best.gain)) best = { j, ni, nj, gain };
                }
            }
            if (best) {
                games[i] = best.ni;
                games[best.j] = best.nj;
                improved = true;
            }
        }
        if (!improved) break;
    }
    return games;
}

function generateRound(db, sessionId, roundNumber, options = {}) {
    const lookback = options.lookbackRounds ?? DEFAULT_LOOKBACK_ROUNDS;
    const settingsRow = get(db, 'SELECT gender_aware_pairing FROM club_settings WHERE id = 1');
    const genderAware = settingsRow ? !!settingsRow.gender_aware_pairing : true;
    const sessionRow = get(db, 'SELECT format FROM sessions WHERE id = ?', [sessionId]);
    const singles = !!sessionRow && sessionRow.format === 'singles';
    const perCourt = singles ? 2 : 4;

    // Excludes players already assigned to a staged/active game in this round -
    // staging doesn't change attendance.state (by design, so staff can stage
    // ahead without pulling anyone out of the pool early), so a player can be
    // 'here_today' and still be spoken for by a court staged moments ago
    // (e.g. by "fill remaining courts" running after a partial manual build).
    //
    // Includes 'playing' as well as 'here_today': this function is also used
    // to stage a round *ahead* of the one currently on court (the "Auto-
    // generate round" button while the live round hasn't ended yet), and
    // everyone currently 'playing' will be back to 'here_today' well before
    // this round actually starts. Excluding them made auto-generate fail
    // with "not enough players" even with a full roster checked in, as long
    // as most of them happened to be mid-match at that exact moment - a real
    // bug hit at a real club night, not just a theoretical one.
    const pool = all(
        db,
        `SELECT p.id AS player_id, p.skill_level, p.gender
         FROM attendance a JOIN players p ON p.id = a.player_id
         WHERE a.session_id = ? AND a.state IN ('here_today', 'playing')
           AND a.player_id NOT IN (
               SELECT gp.player_id FROM game_players gp JOIN games g ON g.id = gp.game_id
               WHERE g.session_id = ? AND g.round_number = ? AND g.status IN ('staged', 'active')
           )`,
        [sessionId, sessionId, roundNumber]
    );

    const allCourts = all(db, `SELECT court_id FROM session_courts WHERE session_id = ? AND in_use = 1`, [sessionId]).map((r) => r.court_id);
    const usedCourts = new Set(all(db, `SELECT court_id FROM games WHERE session_id = ? AND round_number = ?`, [sessionId, roundNumber]).map((r) => r.court_id));
    const freeCourts = allCourts.filter((id) => !usedCourts.has(id)).sort((a, b) => a - b);

    const courtsToFill = Math.min(Math.floor(pool.length / perCourt), freeCourts.length);
    if (courtsToFill === 0) return [];

    const satOut = loadSatOutLastRound(db, sessionId, roundNumber, pool.map((p) => p.player_id));
    const gamesPlayed = loadGamesPlayed(db, sessionId, roundNumber);
    const avoidSet = loadPairRuleSet(db, 'avoid');
    const preferSet = loadPairRuleSet(db, 'prefer');
    const recentSet = loadRecentPairs(db, sessionId, roundNumber, lookback);
    const isCompatible = loadCompatibility(db);

    // Rule 2: sat-out players get hard priority for the limited slots.
    const satOutPlayers = pool.filter((p) => satOut.has(p.player_id));
    const restPlayers = pool.filter((p) => !satOut.has(p.player_id));
    // Tiebreak within each priority tier (spec doesn't specify one) - sort
    // by skill so buckets come out skill-sorted for free. The tiebreak
    // itself is a per-round shuffle, not raw player_id: a fixed ID order
    // meant the same skill tier produced the exact same 4-person pod every
    // single round (recent-pairing avoidance could only rotate the 3 splits
    // *inside* that fixed pod, never actually mix someone in from outside
    // it) - a real complaint from real use, not just a theoretical one.
    const roundSeed = sessionId * 1000 + roundNumber;
    const tiebreakOrder = seededShuffle(pool.map((p) => p.player_id), roundSeed);
    const tiebreakRank = new Map(tiebreakOrder.map((id, idx) => [id, idx]));
    const bySkill = (arr) => arr.slice().sort((x, y) => SKILL_RANK[x.skill_level] - SKILL_RANK[y.skill_level] || tiebreakRank.get(x.player_id) - tiebreakRank.get(y.player_id));

    // Inside a tier that only partly fits, fewest games tonight goes first
    // (then the per-round shuffle) - NOT skill order, which handed the
    // leftover slots to the same top-graded players every round.
    const byFairness = (arr) => arr.slice().sort((x, y) => (gamesPlayed.get(x.player_id) || 0) - (gamesPlayed.get(y.player_id) || 0) || tiebreakRank.get(x.player_id) - tiebreakRank.get(y.player_id));

    const neededPlayers = courtsToFill * perCourt;
    const selected = selectForRound(byFairness(satOutPlayers), byFairness(restPlayers), neededPlayers);
    // Sort the selected group purely by skill so buckets-of-4 are close in
    // grade (serves rules 5/6) - selection priority already happened above.
    const skillSorted = bySkill(selected);

    if (singles) {
        const games = formSinglesGames(skillSorted, avoidSet, recentSet, isCompatible, roundSeed);
        const singlesCourts = seededShuffle(freeCourts, roundSeed * 7 + 3).slice(0, courtsToFill);
        return singlesCourts.map((courtId, i) => ({
            court_id: courtId,
            format: 'singles',
            players: [
                { player_id: games[i][0].player_id, side: 1 },
                { player_id: games[i][1].player_id, side: 2 },
            ],
        }));
    }

    const buckets = formBuckets(skillSorted, genderAware, roundSeed);

    if (genderAware) repairGenderTiers(buckets);
    repairRecentGroups(buckets, avoidSet, preferSet, recentSet, isCompatible, genderAware);
    const splits = repairHardViolations(buckets, avoidSet, preferSet, recentSet, isCompatible, genderAware);

    // Which physical court a bucket lands on is shuffled too (a different
    // seed than the player tiebreak above, so the two don't move in lock
    // step) - otherwise court_id ascending order meant the lowest skill
    // tier landed on the lowest-numbered court every round, so a player
    // noticed always being sent to "their" court even as partners rotated.
    const courtAssignment = seededShuffle(freeCourts, roundSeed * 7 + 3).slice(0, courtsToFill);

    return courtAssignment.map((courtId, i) => {
        const { team1, team2 } = splits[i];
        return {
            court_id: courtId,
            format: 'doubles',
            players: [
                { player_id: team1[0].player_id, side: 1 },
                { player_id: team1[1].player_id, side: 1 },
                { player_id: team2[0].player_id, side: 2 },
                { player_id: team2[1].player_id, side: 2 },
            ],
        };
    });
}

module.exports = { generateRound, pairKey, DEFAULT_LOOKBACK_ROUNDS, seededShuffle };
