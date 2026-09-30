// Read-only kiosk display for a TV at the venue. No controls - players
// glance at it for current matches, the countdown, and the waiting list.
// State updates arrive over SSE; the countdown ticks locally every second
// between updates so the timer never looks stale.

let displayData = null;
let countdownHandle = null;
let lastPhase = null;
let lastPhaseEndsAt = null;

function $(sel) { return document.querySelector(sel); }

async function api(path) {
    const res = await fetch(path);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
}

function parseUtc(dtStr) {
    // Server stores 'YYYY-MM-DD HH:MM:SS' in UTC (SQLite datetime('now')).
    return new Date(`${dtStr.replace(' ', 'T')}Z`).getTime();
}

function playerName(p) {
    return `${p.first_name} ${p.last_name}`;
}

async function refresh() {
    let session;
    try {
        session = await api('/api/sessions/open');
    } catch (err) {
        showIdle();
        return;
    }
    try {
        displayData = await api(`/api/sessions/${session.id}/display`);
        render();
    } catch (err) {
        console.error(err);
    }
}

function showIdle() {
    displayData = null;
    lastPhase = null;
    $('#idle-screen').style.display = 'block';
    $('#live-screen').style.display = 'none';
}

function render() {
    const d = displayData;
    $('#idle-screen').style.display = 'none';
    $('#live-screen').style.display = 'flex';

    // The round just ended (a pause is a freeze, not an end; a stale round
    // the scheduler is only now expiring doesn't count - see horn.js's
    // roundJustEnded) - sound the horn. Only on a transition seen live,
    // never on first load mid-round.
    const phase = d.session.current_phase;
    if (lastPhase === 'game' && phase !== 'game' && phase !== 'paused' && roundJustEnded(lastPhaseEndsAt)) playHorn();
    lastPhase = phase;
    lastPhaseEndsAt = d.session.phase_ends_at;

    renderPhase();
    renderCourts();
    renderWaiting();
}

const WARNING_ZONE_SECONDS = 120; // "2 minutes left" threshold during a match

function renderPhase() {
    const phase = displayData.session.current_phase;
    const label = $('#phase-label');
    label.className = `phase-label ${phase}`;
    if (phase === 'game') label.textContent = 'Round ends in';
    else if (phase === 'break') label.textContent = 'Next round in';
    else if (phase === 'paused') label.textContent = 'Paused';
    else if (phase === 'awaiting_lineup') label.textContent = 'Waiting for next lineup';
    else label.textContent = 'Session starting soon';
    tickCountdown();
}

function formatMMSS(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function tickClock() {
    const el = $('#wall-clock');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function tickCountdown() {
    const el = $('#countdown');
    const banner = $('#warning-banner');
    const nextLine = $('#next-match-line');
    const session = displayData?.session;
    const phase = session?.current_phase;
    const endsAt = session?.phase_ends_at;

    if (phase === 'paused') {
        // The timer is genuinely frozen (phase_ends_at is null while
        // paused) - show the time that was left when paused, static rather
        // than blank, so players don't mistake a paused screen for a
        // crashed one. A clear "Paused" banner explains why nothing's moving.
        el.textContent = formatMMSS(Math.max(0, Math.round((session.paused_remaining_ms ?? 0) / 1000)));
        el.className = 'urgent';
        banner.style.display = 'block';
        banner.textContent = 'Paused - please wait';
        nextLine.style.display = 'none';
        return;
    }

    if (!displayData || !endsAt || (phase !== 'game' && phase !== 'break')) {
        el.textContent = '';
        el.className = '';
        banner.style.display = 'none';
        nextLine.style.display = 'none';
        return;
    }

    const remainingMs = parseUtc(endsAt) - Date.now();
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    el.textContent = formatMMSS(remainingSeconds);

    if (phase === 'game') {
        // Last 2 minutes of a match: flag it clearly and show when the NEXT
        // match will actually start (remaining time + the break after it),
        // not just when this one ends.
        const inWarningZone = remainingSeconds <= WARNING_ZONE_SECONDS;
        el.className = inWarningZone ? 'urgent' : '';
        banner.style.display = inWarningZone ? 'block' : 'none';
        banner.textContent = remainingSeconds > 0 ? '2 minutes left - finish up!' : "Time! Come off court.";
        if (inWarningZone) {
            const breakSeconds = (session.break_minutes ?? 3) * 60;
            nextLine.style.display = 'block';
            nextLine.innerHTML = `Next match starts in <strong>${formatMMSS(remainingSeconds + breakSeconds)}</strong>`;
        } else {
            nextLine.style.display = 'none';
        }
    } else {
        // Break: this IS the "get off the court" countdown - make the last
        // 15 seconds impossible to miss.
        banner.style.display = 'none';
        nextLine.style.display = 'none';
        if (remainingSeconds <= 15) el.className = 'clear-now';
        else if (remainingSeconds <= 60) el.className = 'urgent';
        else el.className = '';
    }
}

function renderCourts() {
    const d = displayData;
    const gamesByCourt = new Map(d.active_games.map((g) => [g.court_id, g]));
    const nextByCourt = new Map((d.next_round_games || []).map((g) => [g.court_id, g]));
    $('#courts').innerHTML = d.courts.map((c) => {
        const game = gamesByCourt.get(c.court_id);
        const upNext = !game ? nextByCourt.get(c.court_id) : null;
        const shown = game || upNext;
        if (!shown) {
            return `<div class="court free"><span>Court ${c.court_number} - free</span></div>`;
        }
        const side = (n) => shown.players
            .filter((p) => p.side === n)
            .map((p) => `<div class="player-name">${playerName(p)}</div>`)
            .join('');
        return `
            <div class="court ${upNext ? 'up-next' : ''}">
                <h2>Court ${c.court_number}${upNext ? ' <span class="up-next-badge">Up next</span>' : ''}</h2>
                <div class="team">${side(1)}</div>
                ${shown.format === 'threes' ? '' : `<div class="team">${side(2)}</div>`}
            </div>
        `;
    }).join('');
}

function renderWaiting() {
    const d = displayData;
    $('#waiting-count').textContent = `(${d.waiting.length})`;
    $('#waiting-list').innerHTML = d.waiting.length
        ? d.waiting.map((w) => `<div class="waiting-player">${w.first_name}</div>`).join('')
        : '<div class="waiting-player">Everyone is on court</div>';
}

subscribeToEvents((msg) => {
    // Any state change that could affect what's on screen -> refetch the one
    // aggregate payload. Cheap on a LAN and keeps the logic trivial.
    if (['session', 'game', 'attendance', 'club_settings'].includes(msg.type)) {
        refresh();
    }
});

countdownHandle = setInterval(() => {
    tickClock();
    tickCountdown();
}, 1000);
tickClock();

wireHornUnlockPill($('#sound-pill'));
startDisplayHornHeartbeat();

refresh();
// No club_name element on this page by design (see PROGRESS.md), but the
// tab/window still gets the right favicon.
api('/api/club-settings').then(applyBranding).catch(() => {});
