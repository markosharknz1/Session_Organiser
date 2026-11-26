// The end-of-night summary as plain sentences - one wording for the
// "Session finished" box (sessionSummaryModal.js), History, and the emailed
// summary (lib/sessionSummaryEmail.js). Takes what lib/nightSummary.js
// returns; no HTML here, callers escape and lay it out. Loaded as a plain
// script in the browser and required by Node (see the export at the foot).

function nightPlural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

function nightNamed(label, names) {
    return `${label} (${names.length}): ${names.join(', ')}.`;
}

// "2026-06-02 08:55:10" (the database's UTC stamp) -> "6:55 pm" on this
// computer's clock. Null if there is nothing sensible to show.
function nightClock(utcStamp) {
    if (!utcStamp) return null;
    const d = new Date(`${String(utcStamp).replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return null;
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

function nightDollars(cents) {
    const d = (cents || 0) / 100;
    return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

// { players: [sentence, ...], play: [sentence, ...] | null }
function nightSummaryLines(summary) {
    const p = summary.players;
    const players = [];
    let came = `${nightPlural(p.came, 'player')} came`;
    if (p.usual) came += ` - the usual for this session is about ${p.usual.average} (the average of the last ${p.usual.nights === 1 ? 'night' : `${p.usual.nights} nights`})`;
    players.push(`${came}.`);
    if (p.visitors.length) players.push(nightNamed('Visitors and new members', p.visitors));
    if (p.left_early.length) players.push(nightNamed('Left early', p.left_early));
    if (p.injuries.length) players.push(nightNamed('Injuries', p.injuries.map((i) => (i.note ? `${i.name} - ${i.note}` : i.name))));
    if (p.booked_did_not_come.length) players.push(nightNamed('Booked but did not come', p.booked_did_not_come));
    if (p.removed.length) players.push(nightNamed('Taken off the list after arriving', p.removed));

    let play = null;
    if (summary.play) {
        const g = summary.play;
        play = [`${nightPlural(g.rounds, 'round')} and ${nightPlural(g.games, 'game')}, on ${nightPlural(g.courts, 'court')}.`];
        const first = nightClock(g.first_game_at);
        const last = nightClock(g.last_game_at);
        if (first && last && g.games > 1) play.push(`The first game went on court at ${first}, the last at ${last}.`);
        if (g.share) {
            const s = g.share;
            const who = `the ${nightPlural(s.players, 'player')} who stayed to the end`;
            if (s.fewest === s.most) {
                play.push(`Of ${who}, everyone played ${nightPlural(s.most, 'game')}.`);
            } else {
                play.push(`Of ${who}, each played between ${s.fewest} and ${nightPlural(s.most, 'game')} (${s.average} on average).`);
                if (s.fewest_players.length && s.fewest_players.length <= 8) {
                    play.push(`Fewest games, ${s.fewest}: ${s.fewest_players.join(', ')}.`);
                }
            }
        }
        if (g.results) play.push(`Results entered for ${g.results.recorded} of ${nightPlural(g.results.of, 'game')}.`);
    }
    return { players, play };
}

if (typeof module !== 'undefined') {
    module.exports = { nightSummaryLines, nightClock, nightDollars, nightPlural };
}
