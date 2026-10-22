// Score boxes beside the Won buttons (Rounds page and History). A court's
// match is one timed round; the players may get through one game or
// several, so there is a pair of boxes per game plus an empty pair for the
// next one. Once a game's two scores are in, the result is saved with the
// winner the scores imply (more games won, then more points). If that is
// level, the Won buttons decide - and they keep working on their own for
// nights that only want the winner.

const SCORE_MAX = 999;

function scoreRowHtml(g) {
    const scores = (g.result && g.result.scores) || [];
    const rows = [...scores, ['', '']]; // one spare pair for the next game
    const box = (side, i, v) => `<input type="number" class="score-in" min="0" max="${SCORE_MAX}" inputmode="numeric" data-score-game="${g.id}" data-game-no="${i + 1}" data-side="${side}" value="${v}" aria-label="Game ${i + 1}, side ${side} score">`;
    return `
        <div class="score-rows">
            ${rows.map(([a, b], i) => `
            <div class="score-row ${i === scores.length ? 'spare' : ''}">
                <span class="score-label" title="Game ${i + 1} of this match">G${i + 1}</span>
                ${box(1, i, a)}
                <span class="score-label">-</span>
                ${box(2, i, b)}
            </div>`).join('')}
        </div>`;
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

// What to send for a game after one of its score boxes changed, or null
// when nothing should be saved yet:
//  - every game with both boxes filled is a score; a half-filled game waits
//  - scores that decide it: scores + the implied winner
//  - scores that are level: scores + whichever Won button is pressed, else
//    wait (boxes flagged red until a Won button is pressed)
//  - no scores at all: keep the pressed winner (drops old scores), else nothing
function scoreBodyFor(root, gameId) {
    const boxes = [...root.querySelectorAll(`input[data-score-game="${gameId}"]`)];
    if (!boxes.length) return null;
    const byGame = new Map();
    for (const b of boxes) {
        const no = Number(b.dataset.gameNo);
        if (!byGame.has(no)) byGame.set(no, {});
        byGame.get(no)[b.dataset.side] = b;
    }
    const scores = [];
    let waiting = false;
    for (const no of [...byGame.keys()].sort((a, b) => a - b)) {
        const { 1: b1, 2: b2 } = byGame.get(no);
        const v1 = b1.value.trim(); const v2 = b2.value.trim();
        if (v1 === '' && v2 === '') continue;
        if (v1 === '' || v2 === '') { waiting = true; continue; }
        scores.push([Number(v1), Number(v2)]);
    }
    const pressed = root.querySelector(`button.result-btn.won[data-result-game="${gameId}"]`);
    const pressedSide = pressed ? Number(pressed.dataset.side) : null;
    const level = scores.length > 0 && impliedWinnerOf(scores) === null && !pressedSide;
    boxes.forEach((b) => b.classList.toggle('invalid', level));
    if (waiting || level) return null;
    if (scores.length) return { winner_side: impliedWinnerOf(scores) || pressedSide, scores };
    return pressedSide ? { winner_side: pressedSide, scores: [] } : null;
}

// The complete score pairs typed for a game (half-filled pairs left out) -
// what a Won button sends along so pressing it never loses typed scores.
function scoresFromBoxes(root, gameId) {
    const byGame = new Map();
    for (const b of root.querySelectorAll(`input[data-score-game="${gameId}"]`)) {
        const no = Number(b.dataset.gameNo);
        if (!byGame.has(no)) byGame.set(no, {});
        byGame.get(no)[b.dataset.side] = b.value.trim();
    }
    return [...byGame.keys()].sort((a, b) => a - b)
        .map((no) => byGame.get(no))
        .filter((g) => g[1] !== '' && g[2] !== '')
        .map((g) => [Number(g[1]), Number(g[2])]);
}

// "21-18, 19-21" (side 1 first) for plain display.
function scoresText(result, ownSide = 1) {
    const scores = (result && result.scores) || [];
    return scores.map(([a, b]) => (ownSide === 1 ? `${a}-${b}` : `${b}-${a}`)).join(', ');
}
