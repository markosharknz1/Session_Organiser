// Management screen: round lifecycle controls + manual game builder
// (drag players from the pool onto a court's sides, stage/edit/unstage,
// stage rounds ahead of the one currently playing).

let openSession = null;
let sessionCourts = []; // [{court_id, court_number, label}]
let roundStatus = null; // last GET /rounds/status response
let buildRound = null;
let lastLoadedRound = null; // which round buildState currently reflects - see roundBuilder.js's mergeBuilderState
let buildState = {}; // court_id -> { staged: {gameId,format,side1,side2} | null, draft: {format,side1,side2}, editing: bool }
let attendancePool = []; // present players (here_today or playing) for this session
let playedPreviousRoundIds = new Set(); // player ids who played in buildRound-1, for the pool split

// loadBuilderForRound() can be triggered concurrently from up to 3 independent
// places in one tab - a court's own post-save reload, the SSE 'game'
// broadcast fired for EVERY client on EVERY court save anywhere, and a manual
// round-stepper click. Without this guard, whichever GET response happens to
// resolve LAST wins and gets applied to buildState, regardless of which call
// was actually issued last - a stale response landing after a fresher one
// can make mergeBuilderState think a just-saved court has nothing staged
// (its snapshot predates the save) and wipe the lineup back to empty in the
// UI, even though it's safely persisted server-side. This monotonic counter
// makes "last issued wins" instead of "last resolved wins".
let builderRequestSeq = 0;

const FORMAT_SIZES = { doubles: 4, singles: 2 };

function $(sel) { return document.querySelector(sel); }

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await res.json() : null;
    if (!res.ok) {
        const message = body?.error || body?.errors?.join(', ') || `Request failed (${res.status})`;
        throw new Error(message);
    }
    return body;
}

function showError(message) {
    const el = $('#error-banner');
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
}

function skillBadge(skill) {
    return skill ? `<span class="badge skill-${skill}">${skill}</span>` : '';
}

// "(3)" after a name on the round cards: games this player has had tonight
// (a live game counts itself; on an "Up next" card it's games so far).
function gamesCount(n) {
    return typeof n === 'number' ? ` <span class="games-count" title="Games played tonight">(${n})</span>` : '';
}

function genderBadge(gender) {
    if (!gender) return '';
    const g = gender === 'M' || gender === 'F' ? gender : 'O';
    return `<span class="badge gender-${g}">${g}</span>`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderHistoryGameRow(g) {
    const side = (n) => g.players
        .filter((p) => p.side === n)
        .map((p) => `${esc(p.first_name)} ${esc(p.last_name)}${skillBadge(p.skill_level_at_time)}`)
        .join(' & ') || '<span class="muted">-</span>';
    return `
        <div class="history-game">
            <span class="court-tag">Court ${g.court_number}</span>
            <span class="team">${side(1)}</span>
            <span class="vs">vs</span>
            <span class="team">${side(2)}</span>
            <span class="muted">${esc(g.format)}</span>
        </div>
    `;
}

// One round at a time (newest first, stepped with Previous/Next) - every
// round stacked in one scrolling window was too hard to read on the night.
let roundsModalRounds = [];
let roundsModalIndex = 0;

async function openRoundsModal() {
    try {
        const data = await api(`/api/history/sessions/${openSession.id}`);
        $('#rounds-modal-title').textContent = `Rounds played - ${data.session.label || 'Session'}`;
        roundsModalRounds = data.rounds;
        roundsModalIndex = Math.max(0, data.rounds.length - 1);
        renderRoundsModal();
        $('#rounds-modal-backdrop').style.display = 'flex';
    } catch (err) {
        showError(err.message);
    }
}

function renderRoundsModal() {
    const body = $('#rounds-modal-body');
    const nav = $('#rounds-modal-nav');
    if (roundsModalRounds.length === 0) {
        nav.style.display = 'none';
        body.innerHTML = '<p class="muted">No rounds played yet this session.</p>';
        return;
    }
    const round = roundsModalRounds[roundsModalIndex];
    nav.style.display = '';
    $('#rounds-modal-prev').disabled = roundsModalIndex === 0;
    $('#rounds-modal-next').disabled = roundsModalIndex === roundsModalRounds.length - 1;
    $('#rounds-modal-pos').textContent = `Round ${round.round_number} of ${roundsModalRounds[roundsModalRounds.length - 1].round_number}`;
    body.innerHTML = `
        <div class="round-block">
            <h3>Round ${round.round_number} <span class="muted round-started">started ${localClockTime(round.started_at)}</span></h3>
            ${round.games.map((g) => renderHistoryGameRow(g)).join('')}
        </div>
    `;
}

$('#rounds-modal-prev').addEventListener('click', () => { if (roundsModalIndex > 0) { roundsModalIndex--; renderRoundsModal(); } });
$('#rounds-modal-next').addEventListener('click', () => { if (roundsModalIndex < roundsModalRounds.length - 1) { roundsModalIndex++; renderRoundsModal(); } });

// Fairness check while building a round: who's had the fewest games tonight.
async function openGamesPlayedModal() {
    try {
        const rows = await api(`/api/history/sessions/${openSession.id}/games-per-player`);
        const body = $('#games-played-modal-body');
        body.innerHTML = rows.length
            ? `<table class="history-table"><thead><tr><th>Player</th><th>Grade</th><th class="num">Games</th></tr></thead><tbody>
                ${rows.map((r) => `
                    <tr>
                        <td>${esc(r.first_name)} ${esc(r.last_name)}${r.state === 'playing' ? ' <span class="muted">(on court)</span>' : ''}</td>
                        <td>${skillBadge(r.skill_level)}</td>
                        <td class="num"><strong>${r.games_played}</strong></td>
                    </tr>
                `).join('')}
              </tbody></table>`
            : '<p class="muted">No one checked in yet.</p>';
        $('#games-played-modal-backdrop').style.display = 'flex';
    } catch (err) {
        showError(err.message);
    }
}

$('#games-played-btn').addEventListener('click', openGamesPlayedModal);
$('#games-played-modal-close').addEventListener('click', () => { $('#games-played-modal-backdrop').style.display = 'none'; });
$('#games-played-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'games-played-modal-backdrop') $('#games-played-modal-backdrop').style.display = 'none';
});

function courtNumberFor(courtId) {
    const c = sessionCourts.find((sc) => sc.court_id === courtId);
    return c ? c.court_number : courtId;
}

// Server stores 'YYYY-MM-DD HH:MM:SS' in UTC (SQLite datetime('now')) -
// same parse as display.js. Showing the raw string here once had the
// Rounds page saying "ends 21:48:40" while the Display counted down to
// 07:18 - the same instant, one in UTC and one in local time.
function parseUtc(dtStr) {
    return new Date(`${dtStr.replace(' ', 'T')}Z`).getTime();
}

function localClockTime(dtStr) {
    return new Date(parseUtc(dtStr)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// --- Boot / session state ---
async function checkSessionState() {
    try {
        openSession = await api('/api/sessions/open');
        $('#no-session-panel').style.display = 'none';
        $('#session-meta').textContent = `${openSession.label || 'Session'} - ${formatDate(openSession.date)}`;
        $('#session-mode-select').value = openSession.mode;
        $('#session-mode-select').style.display = '';
        $('#finish-session-btn').style.display = '';
        $('#session-notes-btn').style.display = '';

        if (openSession.mode === 'social') {
            // No rounds at all in social mode - the check-in screen is the whole workflow.
            $('#social-panel').style.display = 'block';
            $('#manage-panel').style.display = 'none';
            return;
        }
        $('#social-panel').style.display = 'none';
        $('#manage-panel').style.display = 'block';
        sessionCourts = await api(`/api/sessions/${openSession.id}/courts`);
        await refreshAll();
    } catch (err) {
        if (err.message.includes('No open session')) {
            openSession = null;
            $('#no-session-panel').style.display = 'block';
            $('#social-panel').style.display = 'none';
            $('#manage-panel').style.display = 'none';
            $('#session-meta').textContent = 'No session open';
            $('#session-mode-select').style.display = 'none';
            $('#finish-session-btn').style.display = 'none';
            $('#session-notes-btn').style.display = 'none';
        } else {
            showError(err.message);
        }
    }
}

// After closing, show the night's cash-up totals so whoever's finishing up
// can reconcile the cash box before leaving - without a trip to History to
// run a date-range export just to see tonight's numbers. Non-fatal if this
// part fails (session is already closed either way).
async function showFinishedSessionSummary(sessionId) {
    try {
        await showSessionSummaryModal(sessionId);
    } catch (err) { /* non-fatal */ }
}

$('#finish-session-btn').addEventListener('click', async () => {
    if (!openSession) return;
    if (!confirm(`Finish today's session (${openSession.label || 'Session'} - ${formatDate(openSession.date)})? This closes check-in and rounds for the day - you can start a new session afterwards.`)) return;
    try {
        const sessionId = openSession.id;
        await api(`/api/sessions/${sessionId}`, {
            method: 'PUT',
            body: JSON.stringify({ status: 'closed' }),
        });
        showError('');
        await checkSessionState();
        await showFinishedSessionSummary(sessionId);
    } catch (err) {
        showError(err.message);
    }
});

$('#session-mode-select').addEventListener('change', async () => {
    if (!openSession) return;
    const newMode = $('#session-mode-select').value;
    try {
        openSession = await api(`/api/sessions/${openSession.id}`, {
            method: 'PUT',
            body: JSON.stringify({ mode: newMode }),
        });
        showError('');
        await checkSessionState();
    } catch (err) {
        $('#session-mode-select').value = openSession.mode; // revert the dropdown on failure
        showError(err.message);
    }
});

async function refreshAll() {
    await loadRoundStatus();
    await loadAttendancePool();
    await loadActiveGames();
    await loadBuilderForRound(resolveTargetRound(buildRound, roundStatus));
}

function handleServerEvent(msg) {
    if (!msg.type) return;
    if (msg.type === 'session') {
        checkSessionState().catch((err) => showError(err.message));
        return;
    }
    if (!openSession) return;
    if (msg.type === 'game' && msg.session_id === openSession.id) {
        loadRoundStatus()
            .then(() => loadActiveGames())
            .then(() => loadBuilderForRound(resolveTargetRound(buildRound, roundStatus)))
            .catch((err) => showError(err.message));
    } else if (msg.type === 'attendance' && msg.session_id === openSession.id) {
        loadAttendancePool()
            .then(() => renderBuilder())
            .catch((err) => showError(err.message));
    } else if (msg.type === 'auto_generate_failed' && msg.session_id === openSession.id) {
        showError(msg.message);
    } else if (msg.type === 'scheduler_error' && msg.session_id === openSession.id) {
        showError(`Scheduler error: ${msg.message}`);
    }
}

async function init() {
    try {
        const club = await api('/api/club-settings');
        $('#club-name').textContent = club.club_name;
        applyBranding(club);
        setDateFormat(club.date_format);
    } catch (err) {
        // non-fatal
    }
    await checkSessionState();
    subscribeToEvents(handleServerEvent);
    wireHornUnlockPill($('#sound-pill'));
    wireSessionNotesButton(() => openSession, (updated) => { openSession = updated; });
}

// --- Round status + controls ---
let lastSeenPhase = null;
let lastSeenPhaseEndsAt = null;

async function loadRoundStatus() {
    roundStatus = await api(`/api/sessions/${openSession.id}/rounds/status`);
    // A round just ended (not paused - that's a freeze, not an end, and
    // not a stale round the scheduler is only now catching up on - see
    // horn.js's roundJustEnded). The Display screen owns the horn when
    // it's open on this machine; see horn.js for the hand-off.
    const phase = roundStatus.current_phase;
    if (lastSeenPhase === 'game' && phase !== 'game' && phase !== 'paused' && roundJustEnded(lastSeenPhaseEndsAt) && !displayScreenHandlesHorn()) {
        playHorn();
    }
    lastSeenPhase = phase;
    lastSeenPhaseEndsAt = roundStatus.phase_ends_at;
    renderRoundControls();
}

// "round 3 - 12:41 left (ends 7:18 pm)" - the live remaining time is what
// staff actually glance at; the wall-clock end time is there for planning.
function phaseDetailText() {
    const label = roundStatus.current_phase === 'game' ? `round ${roundStatus.current_round}` : 'changeover';
    const endsAt = roundStatus.phase_ends_at;
    if (!endsAt) return label;
    return `${label} - ${minutesSeconds(parseUtc(endsAt) - Date.now())} left (ends ${localClockTime(endsAt)})`;
}

// Ticks the remaining time every second between server updates, exactly as
// the Display screen does - the text used to be set once per SSE event and
// then sit frozen until the next one.
setInterval(() => {
    if (!openSession || !roundStatus) return;
    if (roundStatus.current_phase !== 'game' && roundStatus.current_phase !== 'break') return;
    $('#phase-detail').textContent = phaseDetailText();
    if (roundStatus.current_phase === 'break') updateNextRoundCallout();
}, 1000);

// Phase values (and their CSS classes / API routes) stay as-is internally -
// this only controls what staff actually see.
const PHASE_LABELS = { idle: 'idle', game: 'game', break: 'changeover', awaiting_lineup: 'awaiting lineup', paused: 'paused' };

function minutesSeconds(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function renderRoundControls() {
    const badge = $('#phase-badge');
    badge.textContent = PHASE_LABELS[roundStatus.current_phase] || roundStatus.current_phase.replace('_', ' ');
    badge.className = `phase-badge ${roundStatus.current_phase}`;
    $('#mode-badge').textContent = `${roundStatus.mode} mode`;

    const detail = $('#phase-detail');
    const btn = $('#round-action-btn');
    const pauseBtn = $('#pause-resume-btn');

    if (roundStatus.current_phase === 'game') {
        detail.textContent = phaseDetailText();
        btn.style.display = '';
        btn.textContent = `End round ${roundStatus.current_round}`;
        btn.disabled = false;
        btn.onclick = () => runRoundAction(() => api(`/api/sessions/${openSession.id}/rounds/end-game`, { method: 'POST' }));
        showPauseButton('Pause round');
    } else if (roundStatus.current_phase === 'break') {
        // "Changeover" in the UI, not "break" - it's the time for players to
        // get off court and the next group on, not a rest period. The
        // underlying phase value/DB column stays 'break' - only the label
        // shown to staff/players changes.
        detail.textContent = phaseDetailText();
        btn.style.display = '';
        btn.textContent = 'End changeover';
        btn.disabled = false;
        btn.onclick = () => runRoundAction(() => api(`/api/sessions/${openSession.id}/rounds/end-break`, { method: 'POST' }));
        showPauseButton('Pause changeover');
    } else if (roundStatus.current_phase === 'paused') {
        // Injury/announcement etc - the round or changeover's timer is
        // frozen, not ended. Nothing to "end" while paused, so the main
        // action button steps aside for Resume.
        const pausedLabel = roundStatus.paused_from_phase === 'game' ? `round ${roundStatus.current_round || ''}`.trim() : 'changeover';
        detail.textContent = `${pausedLabel} paused - ${minutesSeconds(roundStatus.paused_remaining_ms)} left`;
        btn.style.display = 'none';
        pauseBtn.style.display = '';
        pauseBtn.className = 'primary';
        pauseBtn.textContent = 'Resume';
        pauseBtn.onclick = () => runRoundAction(() => api(`/api/sessions/${openSession.id}/rounds/resume`, { method: 'POST' }));
    } else {
        // idle or awaiting_lineup
        const isAuto = openSession.mode === 'auto';
        const canStart = roundStatus.staged_next_count > 0 || isAuto;
        if (roundStatus.staged_next_count > 0) {
            detail.textContent = `${roundStatus.staged_next_count} court${roundStatus.staged_next_count === 1 ? '' : 's'} staged for round ${roundStatus.next_round_number}`;
        } else if (isAuto) {
            detail.textContent = `auto mode - will auto-generate round ${roundStatus.next_round_number} from checked-in players`;
        } else {
            detail.textContent = `stage round ${roundStatus.next_round_number} below first`;
        }
        btn.style.display = '';
        btn.textContent = `Start round ${roundStatus.next_round_number}`;
        btn.disabled = !canStart;
        btn.onclick = () => runRoundAction(() => api(`/api/sessions/${openSession.id}/rounds/start-next`, { method: 'POST' }));
        pauseBtn.style.display = 'none';
    }

    updateNextRoundCallout();
}

// Auto mode pre-generates the next round a few minutes before the current
// one ends (see lib/roundLifecycle.js's PRE_GENERATE_WINDOW_MS), entirely
// out of players' sight - the external Display never shows a staged round
// until current_phase actually leaves 'game'. Without this callout,
// nothing on the Rounds page would tell staff it's ready to look at either
// - the Build Round panel below already shows/allows editing it (the
// designer always targets next_round_number, regardless of phase), staff
// just have no reason to scroll down and check while the current round's
// countdown is what's holding their attention. Only shown for exactly
// that "generated ahead, current round still live" situation - once the
// round actually ends, the normal staged-round text in the idle/awaiting-
// lineup branch above takes over.
// Shown whenever auto mode has a next round staged - during the current
// round (generated ahead) AND through the changeover (when it's minutes
// from going live and a bad skill/personality match is most worth
// fixing). The Edit button jumps to the Build Round panel, where every
// staged court has its own Edit.
function updateNextRoundCallout() {
    const callout = $('#next-round-callout');
    const showIt = roundStatus.mode === 'auto' && roundStatus.staged_next_count > 0;
    callout.style.display = showIt ? '' : 'none';
    if (!showIt) return;
    const n = roundStatus.staged_next_count;
    const courts = `${n} court${n === 1 ? '' : 's'}`;
    const round = roundStatus.next_round_number;
    let text;
    if (roundStatus.current_phase === 'game') {
        text = `Round ${round} has been auto-generated (${courts}) - check the matchups before it goes live.`;
    } else if (roundStatus.current_phase === 'break' && roundStatus.phase_ends_at) {
        text = `Round ${round} is up next (${courts}) - goes live in ${minutesSeconds(parseUtc(roundStatus.phase_ends_at) - Date.now())}.`;
    } else {
        text = `Round ${round} is up next (${courts}).`;
    }
    $('#next-round-callout-text').textContent = text;
}

$('#next-round-review-btn').addEventListener('click', () => {
    const panel = $('#build-round-panel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.remove('build-round-flash');
    // Restart the flash animation even if it's already mid-run from a
    // previous click - forces a reflow so removing/re-adding the class
    // actually retriggers the CSS animation instead of being a no-op.
    void panel.offsetWidth;
    panel.classList.add('build-round-flash');
});

function showPauseButton(label) {
    const pauseBtn = $('#pause-resume-btn');
    pauseBtn.style.display = '';
    pauseBtn.className = '';
    pauseBtn.textContent = label;
    pauseBtn.onclick = () => runRoundAction(() => api(`/api/sessions/${openSession.id}/rounds/pause`, { method: 'POST' }));
}

async function runRoundAction(fn) {
    try {
        await fn();
        await refreshAll();
    } catch (err) {
        showError(err.message);
    }
}

// --- Currently on court / up next (browsable back through past rounds too) ---
// Three possible things this panel can show: the round actually on court
// ('active'), a staged-but-not-started round during a break/before round 1
// ('staged' - "up next", so players can walk to their court the moment the
// break ends instead of waiting to be told), or a past completed round
// someone's browsing back to via the arrows.
let viewedRound = null;

function defaultViewedRound() {
    if (roundStatus.current_phase === 'game') return roundStatus.current_round;
    if (roundStatus.staged_next_count > 0) return roundStatus.next_round_number;
    return roundStatus.next_round_number - 1;
}

function statusForViewedRound() {
    if (roundStatus.current_phase === 'game' && viewedRound === roundStatus.current_round) return 'active';
    if (roundStatus.current_phase !== 'game' && viewedRound === roundStatus.next_round_number && roundStatus.staged_next_count > 0) return 'staged';
    return 'completed';
}

async function loadActiveGames() {
    const panel = $('#active-games-panel');
    const target = defaultViewedRound();
    if (target < 1) {
        panel.style.display = 'none';
        viewedRound = null;
        return;
    }
    panel.style.display = 'block';
    viewedRound = target; // jump to the latest/most relevant round whenever round status refreshes
    await renderRoundGamesPanel();
}

async function renderRoundGamesPanel() {
    const status = statusForViewedRound();
    const games = await api(`/api/sessions/${openSession.id}/games?round_number=${viewedRound}&status=${status}`);
    $('#active-round-number').textContent = viewedRound;
    $('#active-games-heading-label').textContent = status === 'active' ? 'Currently on court' : status === 'staged' ? 'Up next' : 'Round played';
    $('#active-games-panel').classList.toggle('up-next', status === 'staged');
    $('#active-round-minus').disabled = viewedRound <= 1;
    $('#active-round-plus').disabled = viewedRound >= defaultViewedRound();
    const sideLines = (g, sideNum) => g.players
        .filter((p) => p.side === sideNum)
        .map((p) => `<div class="active-game-player">${p.first_name} ${p.last_name}${skillBadge(p.skill_level_at_time)}${gamesCount(p.games_played)}</div>`)
        .join('');
    $('#active-games-grid').innerHTML = games.map((g) => `
        <div class="active-game-card">
            <h4>Court ${courtNumberFor(g.court_id)} <span class="muted">(${g.format})</span></h4>
            <div class="active-game-side">${sideLines(g, 1)}</div>
            <div class="active-game-side">${sideLines(g, 2)}</div>
        </div>
    `).join('') || `<p class="muted">${status === 'staged' ? 'Nothing staged for next round yet.' : 'No games recorded for this round.'}</p>`;
}

$('#active-round-minus').addEventListener('click', () => {
    if (viewedRound > 1) { viewedRound -= 1; renderRoundGamesPanel().catch((err) => showError(err.message)); }
});
$('#active-round-plus').addEventListener('click', () => {
    if (viewedRound < defaultViewedRound()) { viewedRound += 1; renderRoundGamesPanel().catch((err) => showError(err.message)); }
});

// --- Attendance pool ---
async function loadAttendancePool() {
    const attendance = await api(`/api/sessions/${openSession.id}/attendance`);
    attendancePool = attendance.filter((a) => a.state === 'here_today' || a.state === 'playing');
}

// --- Builder ---
async function loadBuilderForRound(round) {
    const prevRound = lastLoadedRound;
    const mySeq = ++builderRequestSeq;
    buildRound = round;
    $('#build-round-number').textContent = buildRound;
    $('#round-minus').disabled = buildRound <= roundStatus.next_round_number;

    const staged = await api(`/api/sessions/${openSession.id}/games?round_number=${buildRound}&status=staged`);
    if (mySeq !== builderRequestSeq) return; // a newer call started since - this response is stale, discard it entirely rather than merging
    buildState = mergeBuilderState(buildState, staged, sessionCourts, buildRound, prevRound, openSession.format || 'doubles');
    lastLoadedRound = buildRound;

    // Who played the immediately preceding round, so the pool can surface
    // players who sat out last round ahead of everyone else (they carry sit-out
    // priority into the next one, per the auto-generate rules) - round_number
    // here is always < next_round_number, so these games are never 'staged'.
    playedPreviousRoundIds = new Set();
    if (buildRound > 1) {
        const previousGames = await api(`/api/sessions/${openSession.id}/games?round_number=${buildRound - 1}`);
        if (mySeq !== builderRequestSeq) return; // stale here too - a newer call has since taken over
        for (const g of previousGames) {
            for (const p of g.players) playedPreviousRoundIds.add(p.player_id);
        }
    }

    renderBuilder();
}

function effectiveIdsFor(courtId) {
    const st = buildState[courtId];
    const source = st.editing || !st.staged ? st.draft : st.staged;
    return [...source.side1, ...source.side2];
}

function allUsedPlayerIds() {
    const used = new Set();
    for (const courtId of Object.keys(buildState)) {
        for (const id of effectiveIdsFor(Number(courtId))) used.add(id);
    }
    return used;
}

function playerLabel(playerId) {
    const a = attendancePool.find((p) => p.player_id === playerId);
    if (!a) return `#${playerId}`;
    return `${a.first_name} ${a.last_name}`;
}

function playerSkill(playerId) {
    const a = attendancePool.find((p) => p.player_id === playerId);
    return a ? a.skill_level : null;
}

function playerGender(playerId) {
    const a = attendancePool.find((p) => p.player_id === playerId);
    return a ? a.gender : null;
}

function byLastName(a, b) {
    return a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name);
}

function poolPlayerHtml(p, rested) {
    // "(playing now)" was redundant - the same info is already visible in
    // the "Currently on court" table above, and this player already sits
    // under the "Played last game" section heading below.
    return `
        <div class="pool-player" draggable="true" data-player-id="${p.player_id}">
            <span class="${rested ? 'rested-last-round' : ''}">${p.first_name} ${p.last_name}${skillBadge(p.skill_level)}${genderBadge(p.gender)}</span>
        </div>
    `;
}

function renderBuilder() {
    const grid = $('#courts-grid');
    grid.innerHTML = sessionCourts.map((c) => renderCourtCard(c)).join('');
    wireCourtCardEvents();

    const used = allUsedPlayerIds();
    const pool = attendancePool.filter((p) => !used.has(p.player_id));
    $('#pool-count').textContent = pool.length;

    const poolEl = $('#player-pool');
    if (pool.length === 0) {
        poolEl.innerHTML = '<p class="muted">No players available to place.</p>';
    } else if (buildRound <= 1) {
        // No previous round exists yet to split against.
        poolEl.innerHTML = pool.slice().sort(byLastName).map((p) => poolPlayerHtml(p, false)).join('');
    } else {
        // Sat-out players are listed first - they get hard priority for the
        // next round's limited slots (see lib/autoGenerate.js rule 2) - and
        // bolded, same treatment as once they're placed on a court, so
        // "who's due a game" reads consistently everywhere their name shows up.
        const readyToPlay = pool.filter((p) => !playedPreviousRoundIds.has(p.player_id)).sort(byLastName);
        const playedLastGame = pool.filter((p) => playedPreviousRoundIds.has(p.player_id)).sort(byLastName);
        poolEl.innerHTML = [
            readyToPlay.length ? `<div class="pool-section-label">Ready to play (${readyToPlay.length})</div>${readyToPlay.map((p) => poolPlayerHtml(p, true)).join('')}` : '',
            playedLastGame.length ? `<div class="pool-section-label">Played last game (${playedLastGame.length})</div>${playedLastGame.map((p) => poolPlayerHtml(p, false)).join('')}` : '',
        ].join('');
    }

    poolEl.querySelectorAll('.pool-player').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({ playerId: Number(el.dataset.playerId) }));
        });
    });
}

function renderCourtCard(court) {
    const st = buildState[court.court_id];
    const isReadOnly = st.staged && !st.editing;
    const state = isReadOnly ? st.staged : st.draft;
    const perSide = FORMAT_SIZES[state.format] / 2;

    const sideHtml = (sideNum) => {
        const ids = sideNum === 1 ? state.side1 : state.side2;
        const slots = [];
        for (let i = 0; i < perSide; i++) {
            const playerId = ids[i];
            if (playerId !== undefined) {
                // Flags anyone who sat out the previous round, same "rest
                // priority" concept as the player-pool sidebar's grouping -
                // an at-a-glance check that fair rotation actually happened.
                const restedLastRound = buildRound > 1 && !playedPreviousRoundIds.has(playerId);
                slots.push(`
                    <div class="slot filled" ${isReadOnly ? '' : `draggable="true" data-court="${court.court_id}" data-side="${sideNum}" data-player="${playerId}"`}>
                        <span class="${restedLastRound ? 'rested-last-round' : ''}">${playerLabel(playerId)}${skillBadge(playerSkill(playerId))}${genderBadge(playerGender(playerId))}</span>
                        ${isReadOnly ? '' : `<span class="remove-slot" data-court="${court.court_id}" data-side="${sideNum}" data-player="${playerId}">&times;</span>`}
                    </div>
                `);
            } else {
                slots.push('<div class="slot empty">Drop here</div>');
            }
        }
        return `
            <div class="side-box" data-court="${court.court_id}" data-side="${sideNum}">
                <div class="side-label">Side ${sideNum}</div>
                ${slots.join('')}
            </div>
        `;
    };

    const totalPlayers = state.side1.length + state.side2.length;
    const expectedSize = perSide * 2;
    const incomplete = totalPlayers > 0 && totalPlayers < expectedSize;

    let actions;
    if (isReadOnly) {
        actions = `
            <button class="small" data-action="edit" data-court="${court.court_id}">Edit</button>
            <button class="small" data-action="unstage" data-court="${court.court_id}">Unstage</button>
        `;
    } else if (st.staged) {
        actions = `
            <button class="small" data-action="cancel" data-court="${court.court_id}">Cancel</button>
            <button class="small primary" data-action="save" data-court="${court.court_id}" ${totalPlayers > 0 ? '' : 'disabled'}>Save</button>
        `;
    } else {
        actions = `
            <button class="small" data-action="clear" data-court="${court.court_id}">Clear</button>
            <button class="small primary" data-action="save" data-court="${court.court_id}" ${totalPlayers > 0 ? '' : 'disabled'}>Save</button>
        `;
    }

    return `
        <div class="court-card ${isReadOnly ? 'staged' : ''} ${incomplete ? 'incomplete' : ''}">
            <div class="court-card-header">
                <strong>Court ${court.court_number}</strong>
                ${isReadOnly
                    ? `<span class="muted">${state.format} - staged${incomplete ? ' - incomplete' : ''}</span>`
                    : `<select data-action="format" data-court="${court.court_id}" ${st.staged ? '' : ''}>
                        <option value="doubles" ${state.format === 'doubles' ? 'selected' : ''}>Doubles</option>
                        <option value="singles" ${state.format === 'singles' ? 'selected' : ''}>Singles</option>
                    </select>`
                }
            </div>
            <div class="sides">${sideHtml(1)}${sideHtml(2)}</div>
            <div class="court-actions">${actions}</div>
        </div>
    `;
}

function wireCourtCardEvents() {
    document.querySelectorAll('.slot.filled[draggable="true"]').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({
                playerId: Number(el.dataset.player),
                fromCourt: Number(el.dataset.court),
                fromSide: Number(el.dataset.side),
            }));
        });
    });

    document.querySelectorAll('.side-box').forEach((box) => {
        box.addEventListener('dragover', (e) => {
            e.preventDefault();
            box.classList.add('drag-over');
        });
        box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
        box.addEventListener('drop', (e) => {
            e.preventDefault();
            box.classList.remove('drag-over');
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            const courtId = Number(box.dataset.court);
            const side = Number(box.dataset.side);
            dropPlayer(courtId, side, data.playerId, data.fromCourt, data.fromSide);
        });
    });

    document.querySelectorAll('.remove-slot').forEach((el) => {
        el.addEventListener('click', () => {
            const courtId = Number(el.dataset.court);
            const side = Number(el.dataset.side);
            const playerId = Number(el.dataset.player);
            const st = buildState[courtId];
            const key = side === 1 ? 'side1' : 'side2';
            st.draft[key] = st.draft[key].filter((id) => id !== playerId);
            renderBuilder();
        });
    });

    document.querySelectorAll('select[data-action="format"]').forEach((sel) => {
        sel.addEventListener('change', () => {
            const courtId = Number(sel.dataset.court);
            const st = buildState[courtId];
            st.draft.format = sel.value;
            const perSide = FORMAT_SIZES[sel.value] / 2;
            st.draft.side1 = st.draft.side1.slice(0, perSide);
            st.draft.side2 = st.draft.side2.slice(0, perSide);
            renderBuilder();
        });
    });

    document.querySelectorAll('button[data-action]').forEach((btn) => {
        const courtId = Number(btn.dataset.court);
        const action = btn.dataset.action;
        btn.addEventListener('click', () => {
            if (action === 'edit') return editCourt(courtId);
            if (action === 'unstage') return unstageCourt(courtId);
            if (action === 'cancel') return cancelEditCourt(courtId);
            if (action === 'clear') return clearCourt(courtId);
            if (action === 'save') return saveCourt(courtId);
        });
    });
}

// State-only (no render) - used when a drag both removes from one spot and
// adds to another in the same gesture, so the whole move renders once.
function removePlayerFromCourtDraft(courtId, side, playerId) {
    const st = buildState[courtId];
    if (!st || (st.staged && !st.editing)) return; // read-only court, shouldn't be draggable in the first place
    const key = side === 1 ? 'side1' : 'side2';
    st.draft[key] = st.draft[key].filter((id) => id !== playerId);
}

// fromCourt/fromSide are only set when the drag started on another slot
// (as opposed to the player pool) - used to move a player between courts,
// or between sides of the same court, in one gesture. The target-capacity
// check happens BEFORE anything is removed from the source, and always
// against a version of this court's draft with the player already taken
// out of wherever they currently sit in it (covers a same-court side swap
// correctly) - so a rejected drop (target full) never loses the player from
// their original slot. Source removal from a DIFFERENT court only happens
// once the target is confirmed to have room.
function dropPlayer(courtId, side, playerId, fromCourt, fromSide) {
    const st = buildState[courtId];
    if (st.staged && !st.editing) return; // read-only until Edit is clicked
    const key = side === 1 ? 'side1' : 'side2';
    const perSide = FORMAT_SIZES[st.draft.format] / 2;

    const side1WithoutPlayer = st.draft.side1.filter((id) => id !== playerId);
    const side2WithoutPlayer = st.draft.side2.filter((id) => id !== playerId);
    const targetArr = key === 'side1' ? side1WithoutPlayer : side2WithoutPlayer;
    if (targetArr.length >= perSide) return; // target slot has no room - reject, nothing touched yet

    if (fromCourt !== undefined && fromCourt !== courtId) removePlayerFromCourtDraft(fromCourt, fromSide, playerId);
    st.draft.side1 = side1WithoutPlayer;
    st.draft.side2 = side2WithoutPlayer;
    st.draft[key] = [...targetArr, playerId];
    renderBuilder();
}

function editCourt(courtId) {
    const st = buildState[courtId];
    st.draft = { format: st.staged.format, side1: [...st.staged.side1], side2: [...st.staged.side2] };
    st.editing = true;
    renderBuilder();
}

function cancelEditCourt(courtId) {
    const st = buildState[courtId];
    st.editing = false;
    renderBuilder();
}

function clearCourt(courtId) {
    const st = buildState[courtId];
    st.draft.side1 = [];
    st.draft.side2 = [];
    renderBuilder();
}

async function unstageCourt(courtId) {
    const st = buildState[courtId];
    try {
        await api(`/api/games/${st.staged.gameId}`, { method: 'DELETE' });
        showError('');
        await loadRoundStatus();
        await loadBuilderForRound(buildRound);
    } catch (err) {
        showError(err.message);
    }
}

// Finds every OTHER court that must be saved in the SAME request as
// courtId for courtId's own save to be valid: a court whose server-side
// staged game still holds a player courtId's draft now wants, where that
// other court's own local draft has already moved them out (a drag
// between two courts both currently being edited, neither saved yet).
// Saving courtId alone in that situation used to fail outright - the
// server correctly saw the player still assigned to the OTHER court's
// unchanged game and rejected it as a double-booking, even though that
// "conflict" was only ever local, unsaved state. Iterates to a fixed
// point so a genuine swap or a longer A->B->C->A chain resolves in one
// go, not just a single adjacent pair.
function findCourtsToSaveTogether(courtId) {
    const included = new Set([courtId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const idStr of Object.keys(buildState)) {
            const id = Number(idStr);
            if (included.has(id)) continue;
            const other = buildState[id];
            if (!other.staged) continue; // nothing persisted server-side to conflict with
            const otherStagedIds = new Set([...other.staged.side1, ...other.staged.side2]);
            const otherDraftIds = new Set([...other.draft.side1, ...other.draft.side2]);
            const releasesSomethingNeeded = [...included].some((incId) => {
                const incDraftIds = [...buildState[incId].draft.side1, ...buildState[incId].draft.side2];
                return incDraftIds.some((pid) => otherStagedIds.has(pid) && !otherDraftIds.has(pid));
            });
            if (releasesSomethingNeeded) {
                included.add(id);
                changed = true;
            }
        }
    }
    included.delete(courtId);
    return [...included];
}

// round_number is needed by BOTH the single-court PUT/POST routes (which
// read it directly off this payload) and, redundantly but harmlessly, by
// each entry in a batch save (the batch route only actually reads its own
// top-level round_number - see saveCourt below).
function courtPayload(courtId) {
    const st = buildState[courtId];
    const players = [
        ...st.draft.side1.map((id) => ({ player_id: id, side: 1 })),
        ...st.draft.side2.map((id) => ({ player_id: id, side: 2 })),
    ];
    return { court_id: courtId, game_id: st.staged ? st.staged.gameId : null, round_number: buildRound, format: st.draft.format, players };
}

// Applies a saved game's server response straight to buildState/the DOM,
// immediately and unconditionally - never dependent on winning the
// loadBuilderForRound race that follows. That race (a save's own explicit
// reload vs. the SSE 'game' broadcast this very save just triggered, which
// echoes back to this same tab) is real: whichever call is issued LAST
// wins and the other is discarded (see loadBuilderForRound's
// builderRequestSeq guard) - if a save's own explicit reload loses that
// race, its promise still resolves before the winning (SSE-triggered) one
// finishes, so without this direct update the court that WAS just saved
// could sit showing stale "unsaved draft" for a beat, or - under a run of
// further saves on other courts - indefinitely. This makes "the court(s)
// you just saved show saved" true the instant the request completes.
function applySavedGame(game) {
    const side1 = game.players.filter((p) => p.side === 1).map((p) => p.player_id);
    const side2 = game.players.filter((p) => p.side === 2).map((p) => p.player_id);
    buildState[game.court_id] = {
        staged: { gameId: game.id, format: game.format, side1, side2 },
        draft: { format: game.format, side1: [...side1], side2: [...side2] },
        editing: false,
    };
}

async function saveCourt(courtId) {
    const others = findCourtsToSaveTogether(courtId);
    try {
        if (others.length > 0) {
            // A cross-court move needs the whole affected set saved together
            // in one request - see routes/games.js's PUT .../games/batch.
            const courtIds = [courtId, ...others];
            const saved = await api(`/api/sessions/${openSession.id}/games/batch`, {
                method: 'PUT',
                body: JSON.stringify({ round_number: buildRound, courts: courtIds.map(courtPayload) }),
            });
            saved.forEach(applySavedGame);
        } else {
            const st = buildState[courtId];
            const saved = st.staged
                ? await api(`/api/games/${st.staged.gameId}`, { method: 'PUT', body: JSON.stringify(courtPayload(courtId)) })
                : await api(`/api/sessions/${openSession.id}/games`, { method: 'POST', body: JSON.stringify(courtPayload(courtId)) });
            applySavedGame(saved);
        }
        renderBuilder();
        showError('');
        await loadRoundStatus();
        await loadBuilderForRound(buildRound);
    } catch (err) {
        showError(err.message);
    }
}

// --- Auto-generate ---
// Fills any courts still empty in the current build round using the
// auto-generate algorithm (same one auto mode uses at break-end). Courts
// that already have a staged game for this round are left untouched - the
// algorithm only ever proposes games for courts with no game yet this round.
async function autoGenerateBuildRound() {
    const btn = $('#auto-generate-btn');
    btn.disabled = true;
    try {
        const data = await api(`/api/sessions/${openSession.id}/auto-generate/preview?round_number=${buildRound}`);
        if (data.games.length === 0) {
            const usedIds = allUsedPlayerIds();
            const leftover = attendancePool.filter((p) => !usedIds.has(p.player_id)).length;
            const emptyCourts = sessionCourts.filter((c) => !buildState[c.court_id].staged).length;
            showError(emptyCourts === 0
                ? `Auto-generate couldn't build round ${buildRound}: every court already has something staged.`
                : leftover > 0 && leftover < 4
                    ? `Auto-generate couldn't build round ${buildRound}: only ${leftover} player${leftover === 1 ? '' : 's'} left in the pool - not enough for a full court.`
                    : `Auto-generate couldn't build round ${buildRound}: not enough players present.`);
            return;
        }
        const errors = [];
        for (const g of data.games) {
            try {
                await api(`/api/sessions/${openSession.id}/games`, {
                    method: 'POST',
                    body: JSON.stringify({ court_id: g.court_id, round_number: buildRound, format: g.format, players: g.players }),
                });
            } catch (err) {
                errors.push(err.message);
            }
        }
        await loadRoundStatus();
        await loadBuilderForRound(buildRound);

        if (errors.length) {
            showError(`Auto-generate staged ${data.games.length - errors.length} of ${data.games.length} courts - ${errors.join('; ')}`);
        } else {
            // Auto-generate only ever proposes *full* courts - if the
            // leftover pool is short of a fourth player, a court is left
            // empty with no explanation unless we say so here. This isn't a
            // bug (there's genuinely no way to auto-fill a partial court),
            // but it looked like one - "why is court 3 just sitting there?"
            const usedIds = allUsedPlayerIds();
            const leftover = attendancePool.filter((p) => !usedIds.has(p.player_id)).length;
            const emptyCourts = sessionCourts.filter((c) => !buildState[c.court_id].staged).length;
            if (emptyCourts > 0 && leftover > 0 && leftover < 4) {
                showError(`Round ${buildRound} staged with ${leftover} player${leftover === 1 ? '' : 's'} left over - not enough for a full court, so ${emptyCourts} court${emptyCourts === 1 ? '' : 's'} stayed empty. Drag them onto a court manually if you'd like to use a partial lineup.`);
            } else {
                showError('');
            }
        }
    } catch (err) {
        showError(err.message);
    } finally {
        btn.disabled = false;
    }
}

$('#auto-generate-btn').addEventListener('click', autoGenerateBuildRound);

// Drag a player off a court back onto the pool sidebar to unassign them -
// the pool itself is just "everyone minus who's placed", so removing them
// from the court draft is all that's needed; renderBuilder() picks it up.
// This container is never recreated (only its child list's innerHTML
// changes on render), so it's wired once here rather than per-render.
const poolSidebar = $('#player-pool-sidebar');
poolSidebar.addEventListener('dragover', (e) => {
    e.preventDefault();
    poolSidebar.classList.add('drag-over');
});
poolSidebar.addEventListener('dragleave', () => poolSidebar.classList.remove('drag-over'));
poolSidebar.addEventListener('drop', (e) => {
    e.preventDefault();
    poolSidebar.classList.remove('drag-over');
    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
    if (data.fromCourt === undefined) return; // dragged from the pool onto itself - nothing to do
    removePlayerFromCourtDraft(data.fromCourt, data.fromSide, data.playerId);
    renderBuilder();
});

// --- Rounds played modal ---
$('#view-rounds-btn').addEventListener('click', openRoundsModal);
$('#rounds-modal-close').addEventListener('click', () => { $('#rounds-modal-backdrop').style.display = 'none'; });
let roundsModalMouseDownTarget = null;
$('#rounds-modal-backdrop').addEventListener('mousedown', (e) => { roundsModalMouseDownTarget = e.target; });
$('#rounds-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'rounds-modal-backdrop' && roundsModalMouseDownTarget?.id === 'rounds-modal-backdrop') $('#rounds-modal-backdrop').style.display = 'none';
});

// --- Round stepper ---
$('#round-minus').addEventListener('click', () => {
    if (buildRound > roundStatus.next_round_number) loadBuilderForRound(buildRound - 1).catch((err) => showError(err.message));
});
$('#round-plus').addEventListener('click', () => {
    loadBuilderForRound(buildRound + 1).catch((err) => showError(err.message));
});

init();
