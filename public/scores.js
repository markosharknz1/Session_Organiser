// Score boxes beside the Won buttons (Rounds page and History). Two small
// inputs per game; once both are filled and differ, the result is saved
// with the winner that follows from them. The Won buttons keep working on
// their own for nights that only want the winner.

// The two boxes for a game, pre-filled from its recorded result.
function scoreRowHtml(g) {
    const r = g.result || {};
    const val = (v) => (v === null || v === undefined ? '' : v);
    return `
        <div class="score-row">
            <span class="score-label">Score</span>
            <input type="number" class="score-in" min="0" max="999" inputmode="numeric" data-score-game="${g.id}" data-side="1" value="${val(r.side1_score)}" aria-label="Side 1 score">
            <span class="score-label">-</span>
            <input type="number" class="score-in" min="0" max="999" inputmode="numeric" data-score-game="${g.id}" data-side="2" value="${val(r.side2_score)}" aria-label="Side 2 score">
        </div>`;
}

// What to send for a game after one of its score boxes changed, or null
// when nothing should be saved yet:
//  - both filled and different: scores + the winner they imply
//  - both empty: keep whatever winner is recorded, drop the scores
//  - one filled, or equal: wait (equal scores are flagged in red)
function scoreBodyFor(root, gameId) {
    const box = (side) => root.querySelector(`input[data-score-game="${gameId}"][data-side="${side}"]`);
    const b1 = box(1);
    const b2 = box(2);
    if (!b1 || !b2) return null;
    const s1 = b1.value.trim() === '' ? null : Number(b1.value);
    const s2 = b2.value.trim() === '' ? null : Number(b2.value);
    const equal = s1 !== null && s2 !== null && s1 === s2;
    b1.classList.toggle('invalid', equal);
    b2.classList.toggle('invalid', equal);
    if (equal) return null;
    if (s1 !== null && s2 !== null) return { winner_side: s1 > s2 ? 1 : 2, side1_score: s1, side2_score: s2 };
    if (s1 === null && s2 === null) {
        const won = root.querySelector(`button.result-btn.won[data-result-game="${gameId}"]`);
        if (!won) return null; // nothing recorded, nothing to clear
        return { winner_side: Number(won.dataset.side) };
    }
    return null;
}
