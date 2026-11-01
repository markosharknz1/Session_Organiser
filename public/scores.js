// Score boxes beside the Won buttons (Rounds page and History). A court's
// match is one timed round; the players may get through one game or
// several, so there is a pair of boxes per game plus an empty pair for the
// next one. Once a game's two scores are in, the result is saved with the
// winner the scores imply (more games won, then more points). If that is
// level, the Won buttons decide - and they keep working on their own for
// nights that only want the winner.
//
// The session's scoring preset (public/scoring.js) names the row (G1 or
// S1 for tennis sets) and gives the score a game is played to, so typing
// just the loser's score fills in the winner's (18 -> 21-18). Threes
// (three in a box) has a row per pair of players instead of per side.

const SCORE_MAX = 999;

function scoreUnitLetter(scoring) {
    return (scoring && scoring.unit === 'Set') ? 'S' : 'G';
}

function scoreBox(gameId, extra, side, value, label) {
    return `<input type="number" class="score-in" min="0" max="${SCORE_MAX}" inputmode="numeric" data-score-game="${gameId}" ${extra} data-side="${side}" value="${value}" aria-label="${label}">`;
}

// Sided (doubles / singles): a pair of boxes per game plus a spare.
function sidedScoreRowsHtml(g, scoring) {
    const scores = (g.result && g.result.scores) || [];
    const rows = [...scores, ['', '']];
    const u = scoreUnitLetter(scoring);
    const unit = scoring && scoring.unit ? scoring.unit : 'Game';
    return `
        <div class="score-rows">
            ${rows.map(([a, b], i) => `
            <div class="score-row ${i === scores.length ? 'spare' : ''}">
                <span class="score-label" title="${unit} ${i + 1} of this match">${u}${i + 1}</span>
                ${scoreBox(g.id, `data-game-no="${i + 1}"`, 1, a, `${unit} ${i + 1}, side 1 score`)}
                <span class="score-label">-</span>
                ${scoreBox(g.id, `data-game-no="${i + 1}"`, 2, b, `${unit} ${i + 1}, side 2 score`)}
            </div>`).join('')}
        </div>`;
}

// Threes: the three pairs in the box, each with a pair of boxes; another
// row per pair appears once that pair's first game is in.
function threesScoreRowsHtml(g, scoring) {
    const players = g.players.map((p) => ({ id: p.player_id, name: `${p.first_name} ${p.last_name}` }));
    const pairs = [];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) pairs.push([players[i], players[j]]);
    const scores = (g.result && g.result.scores) || [];
    const unit = scoring && scoring.unit ? scoring.unit : 'Game';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rowsHtml = [];
    for (const [a, b] of pairs) {
        const played = scores.filter((s) => (s.a === a.id && s.b === b.id) || (s.a === b.id && s.b === a.id))
            .map((s) => (s.a === a.id ? [s.score_a, s.score_b] : [s.score_b, s.score_a]));
        const rows = [...played, ['', '']];
        rows.forEach(([sa, sb], i) => {
            rowsHtml.push(`
            <div class="score-row threes ${i === played.length ? 'spare' : ''}">
                <span class="score-label pair" title="${unit} ${i + 1} between ${esc(a.name)} and ${esc(b.name)}">${esc(a.name.split(' ')[0])} v ${esc(b.name.split(' ')[0])}${played.length ? ` ${i + 1}` : ''}</span>
                ${scoreBox(g.id, `data-pair="${a.id}-${b.id}" data-game-no="${i + 1}"`, 1, sa, `${esc(a.name)} score`)}
                <span class="score-label">-</span>
                ${scoreBox(g.id, `data-pair="${a.id}-${b.id}" data-game-no="${i + 1}"`, 2, sb, `${esc(b.name)} score`)}
            </div>`);
        });
    }
    return `<div class="score-rows">${rowsHtml.join('')}</div>`;
}

function scoreRowHtml(g, scoring) {
    if (scoring && scoring.boxes === false) return ''; // "Winner only": just the Won buttons
    return g.format === 'threes' ? threesScoreRowsHtml(g, scoring) : sidedScoreRowsHtml(g, scoring);
}

// Who the typed scores say won: more games, then more points, else null.
function impliedWinnerOf(scores) {
    let g1 = 0; let g2 = 0; let p1 = 0; let p2 = 0;
    for (const [a, b] of scores) {
        if (a > b) g1++; else if (b > a) g2++;
        p1 += a; p2 += b;
    }
    if (g1 !== g2) return g1 > g2 ? 1 : 2;
    if (p1 !== p2) return p1 > p2 ? 1 : 2;
    return null;
}

function impliedThreesWinnerOf(scores, playerIds) {
    if (!scores.length) return null;
    const games = new Map(playerIds.map((id) => [id, 0]));
    const diff = new Map(playerIds.map((id) => [id, 0]));
    for (const g of scores) {
        if (g.score_a > g.score_b) games.set(g.a, games.get(g.a) + 1);
        else if (g.score_b > g.score_a) games.set(g.b, games.get(g.b) + 1);
        diff.set(g.a, diff.get(g.a) + g.score_a - g.score_b);
        diff.set(g.b, diff.get(g.b) + g.score_b - g.score_a);
    }
    const ranked = playerIds.slice().sort((x, y) => games.get(y) - games.get(x) || diff.get(y) - diff.get(x));
    const [first, second] = ranked;
    if (games.get(first) === games.get(second) && diff.get(first) === diff.get(second)) return null;
    return first;
}

// Only the loser's score typed and the preset knows the target (21 for
// badminton): the other box gets the target. Called for the row that
// just changed; returns true when it filled something in.
function autoFillPartner(changedBox, root, scoring) {
    const target = scoring && scoring.target;
    if (!target) return false;
    const gameId = changedBox.dataset.scoreGame;
    const pair = changedBox.dataset.pair ? `[data-pair="${changedBox.dataset.pair}"]` : '';
    const other = root.querySelector(`input[data-score-game="${gameId}"]${pair}[data-game-no="${changedBox.dataset.gameNo}"][data-side="${changedBox.dataset.side === '1' ? 2 : 1}"]`);
    if (!other || other.value.trim() !== '' || changedBox.value.trim() === '') return false;
    const typed = Number(changedBox.value);
    if (!(typed < target)) return false;
    other.value = String(target);
    return true;
}

// Groups a game's boxes into complete and half-filled rows.
function readBoxes(root, gameId) {
    const rows = new Map(); // key -> { boxes by side, pair }
    for (const b of root.querySelectorAll(`input[data-score-game="${gameId}"]`)) {
        const key = `${b.dataset.pair || ''}#${b.dataset.gameNo}`;
        if (!rows.has(key)) rows.set(key, { pair: b.dataset.pair || null, no: Number(b.dataset.gameNo) });
        rows.get(key)[b.dataset.side] = b.value.trim();
    }
    const complete = []; let waiting = false;
    for (const r of [...rows.values()].sort((x, y) => x.no - y.no)) {
        if (r[1] === '' && r[2] === '') continue;
        if (r[1] === '' || r[2] === '') { waiting = true; continue; }
        complete.push(r);
    }
    return { complete, waiting };
}

function toScores(rows) {
    return rows.map((r) => (r.pair
        ? { a: Number(r.pair.split('-')[0]), b: Number(r.pair.split('-')[1]), score_a: Number(r[1]), score_b: Number(r[2]) }
        : [Number(r[1]), Number(r[2])]));
}

// What to send for a game after one of its score boxes changed, or null
// when nothing should be saved yet:
//  - every game with both boxes filled is a score; a half-filled game waits
//  - scores that decide it: scores + the implied winner
//  - scores that are level: scores + whichever Won button is pressed, else
//    wait (boxes flagged red until a Won button is pressed)
//  - no scores at all: keep the pressed winner (drops old scores), else nothing
function scoreBodyFor(root, gameId, playerIds = null) {
    const boxes = [...root.querySelectorAll(`input[data-score-game="${gameId}"]`)];
    if (!boxes.length) return null;
    const { complete, waiting } = readBoxes(root, gameId);
    const scores = toScores(complete);
    const threes = boxes.some((b) => b.dataset.pair);
    const pressed = root.querySelector(`button.result-btn.won[data-result-game="${gameId}"]`);
    const pressedWinner = pressed ? (threes ? Number(pressed.dataset.winnerPlayer) : Number(pressed.dataset.side)) : null;
    const implied = scores.length ? (threes ? impliedThreesWinnerOf(scores, playerIds || []) : impliedWinnerOf(scores)) : null;
    const level = scores.length > 0 && implied === null && !pressedWinner;
    boxes.forEach((b) => b.classList.toggle('invalid', level));
    if (waiting || level) return null;
    const winner = implied || pressedWinner;
    if (scores.length) return threes ? { winner_player_id: winner, scores } : { winner_side: winner, scores };
    if (!pressedWinner) return null;
    return threes ? { winner_player_id: pressedWinner, scores: [] } : { winner_side: pressedWinner, scores: [] };
}

// The complete scores typed for a game (half-filled rows left out) - what
// a Won button sends along so pressing it never loses typed scores.
function scoresFromBoxes(root, gameId) {
    return toScores(readBoxes(root, gameId).complete);
}

// "21-18, 19-21" (side 1 first) for plain display.
function scoresText(result, ownSide = 1) {
    const scores = (result && result.scores) || [];
    return scores.map(([a, b]) => (ownSide === 1 ? `${a}-${b}` : `${b}-${a}`)).join(', ');
}

// Threes: "Ann v Bob 11-7, Ann v Cy 9-11, Bob v Cy 11-5"; with ownId, that
// player's games only, own score first: "v Bob 11-7, v Cy 9-11".
function threesScoresText(result, nameOf, ownId = null) {
    const scores = (result && result.scores) || [];
    return scores
        .filter((g) => ownId === null || g.a === ownId || g.b === ownId)
        .map((g) => {
            if (ownId !== null) {
                const other = g.a === ownId ? g.b : g.a;
                const mine = g.a === ownId ? g.score_a : g.score_b;
                const theirs = g.a === ownId ? g.score_b : g.score_a;
                return `v ${nameOf(other)} ${mine}-${theirs}`;
            }
            return `${nameOf(g.a)} v ${nameOf(g.b)} ${g.score_a}-${g.score_b}`;
        })
        .join(', ');
}
