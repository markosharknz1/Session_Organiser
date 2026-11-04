// Scoring systems - how a sport counts, for the score boxes beside the Won
// buttons. A preset says what one row of boxes is (a game, or a set of
// games for tennis) and the score a game is normally played to, which lets
// the boxes fill in the winner's score when only the loser's is typed
// (type 18 -> 21-18). Nothing here changes who wins: that is still more
// games/sets won, then more points, then the Won button. "Winner only"
// has no boxes at all - just the Won buttons.
//
// Loads as a plain <script> in the browser and via require() in Node
// (routes validate the key with it), hence the dual-export footer.

const SCORING_PRESETS = {
    badminton: { label: 'Badminton - games to 21', unit: 'Game', target: 21 },
    squash: { label: 'Squash - games to 11 (point a rally)', unit: 'Game', target: 11 },
    squash9: { label: 'Squash - games to 9 (hand-in hand-out)', unit: 'Game', target: 9 },
    racquetball: { label: 'Racquetball - games to 15', unit: 'Game', target: 15 },
    tabletennis: { label: 'Table tennis - games to 11', unit: 'Game', target: 11 },
    pickleball: { label: 'Pickleball - games to 11', unit: 'Game', target: 11 },
    tennis: { label: 'Tennis - sets (games in each set, to 6)', unit: 'Set', target: 6 },
    points: { label: 'Points only - no set score (timed play)', unit: 'Game', target: null },
    none: { label: 'Winner only - no score boxes', unit: 'Game', target: null, boxes: false },
};
const DEFAULT_SCORING = 'badminton';

function scoringFor(key) {
    return SCORING_PRESETS[key] || SCORING_PRESETS[DEFAULT_SCORING];
}

// With clubDefault (a preset key), the list starts with "Club default -
// <that sport>" (value "club") and an unrecognised selection picks it;
// without, an unrecognised selection falls back to badminton.
function scoringOptionsHtml(selected, clubDefault) {
    const inherit = clubDefault !== undefined && clubDefault !== null;
    const current = SCORING_PRESETS[selected] ? selected : (inherit ? 'club' : DEFAULT_SCORING);
    const head = inherit
        ? `<option value="club" ${current === 'club' ? 'selected' : ''}>Club default - ${scoringFor(clubDefault).label}</option>`
        : '';
    return head + Object.entries(SCORING_PRESETS)
        .map(([key, p]) => `<option value="${key}" ${key === current ? 'selected' : ''}>${p.label}</option>`)
        .join('');
}

if (typeof module !== 'undefined') {
    module.exports = { SCORING_PRESETS, DEFAULT_SCORING, scoringFor, scoringOptionsHtml };
}
