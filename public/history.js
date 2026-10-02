// Session history / audit view. Read-only: three views (session list,
// one session's rounds, one player's cross-session game history) toggled
// client-side. Nothing here writes - the audit trail is append-only.

let searchDebounce = null;

function $(sel) { return document.querySelector(sel); }

async function api(path) {
    const res = await fetch(path);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
}

function showError(message) {
    const el = $('#error-banner');
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
}

function skillTag(skill) {
    return skill ? `<span class="badge skill-${skill}">${skill}</span>` : '';
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showView(which) {
    $('#landing-view').style.display = which === 'landing' ? 'block' : 'none';
    $('#session-view').style.display = which === 'session' ? 'block' : 'none';
    $('#player-view').style.display = which === 'player' ? 'block' : 'none';
}

// --- Session list ---
let allSessions = [];
let templates = [];

// "all" | "adhoc" | a template id as a string - narrows everything on the
// landing page (calendar, list, trend, export) to one kind of session, so
// "how are Tuesday mornings going" is one dropdown pick, not mental
// filtering of the whole history.
let sessionFilter = 'all';

function filteredSessions() {
    if (sessionFilter === 'all') return allSessions;
    if (sessionFilter === 'adhoc') return allSessions.filter((s) => !s.template_id);
    return allSessions.filter((s) => String(s.template_id) === sessionFilter);
}

async function loadTemplateFilterOptions() {
    templates = await api('/api/session-templates');
    const select = $('#session-filter');
    const keep = select.value;
    select.querySelectorAll('option[data-template]').forEach((o) => o.remove());
    for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = String(t.id);
        opt.dataset.template = '1';
        opt.textContent = `${t.label} (${t.day_of_week} ${t.start_time})`;
        select.appendChild(opt);
    }
    select.value = [...select.options].some((o) => o.value === keep) ? keep : 'all';
    sessionFilter = select.value;
}

$('#session-filter').addEventListener('change', () => {
    sessionFilter = $('#session-filter').value;
    renderSessionsTable();
    renderCalendar();
    renderTrend();
});

function renderTrend() {
    const panel = $('#trend-panel');
    const sessions = filteredSessions().slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    if (sessionFilter === 'all' || sessions.length === 0) {
        panel.innerHTML = sessionFilter === 'all' ? '' : '<p class="muted">No sessions of this kind yet.</p>';
        return;
    }
    const avg = (key) => (sessions.reduce((sum, s) => sum + s[key], 0) / sessions.length).toFixed(1);
    const best = sessions.reduce((m, s) => (s.players_checked_in > m.players_checked_in ? s : m), sessions[0]);
    const recent = sessions.slice(-24);
    const max = Math.max(1, ...recent.map((s) => s.players_checked_in));
    panel.innerHTML = `
        <div class="trend-summary">
            <div><strong>${sessions.length}</strong><span class="muted">sessions</span></div>
            <div><strong>${avg('players_checked_in')}</strong><span class="muted">avg players</span></div>
            <div><strong>${avg('rounds_played')}</strong><span class="muted">avg rounds</span></div>
            <div><strong>${best.players_checked_in}</strong><span class="muted">best night (${formatDate(best.date)})</span></div>
        </div>
        <div class="trend-bars">
            ${recent.map((s) => `<div class="trend-bar" data-session-id="${s.id}" style="height:${Math.round((s.players_checked_in / max) * 100)}%;" title="${esc(formatDate(s.date))} - ${s.players_checked_in} players, ${s.rounds_played} rounds"></div>`).join('')}
        </div>
        <p class="muted" style="margin:6px 0 0;">Players per session, oldest to newest${sessions.length > recent.length ? ` (last ${recent.length} of ${sessions.length})` : ''} - hover for the date, click to open.</p>
    `;
    panel.querySelectorAll('.trend-bar').forEach((el) => el.addEventListener('click', () => openSession(Number(el.dataset.sessionId))));
}

async function loadSessions() {
    allSessions = await api('/api/history/sessions');
    renderSessionsTable();
    renderCalendar();
    renderTrend();
}

function renderSessionsTable() {
    const sessions = filteredSessions();
    const tbody = $('#sessions-table tbody');
    if (sessions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted">${allSessions.length ? 'No sessions of this kind yet.' : 'No sessions yet.'}</td></tr>`;
    } else {
        tbody.innerHTML = sessions.map((s) => `
            <tr data-session-id="${s.id}">
                <td>${formatDate(s.date)}</td>
                <td>${esc(s.label || 'Session')} ${s.status === 'open' ? '<span class="badge">open</span>' : ''}</td>
                <td>${esc(s.mode)}</td>
                <td class="num">${s.players_checked_in}</td>
                <td class="num">${s.rounds_played}</td>
                <td class="num">${s.games_played}</td>
            </tr>
        `).join('');
        tbody.querySelectorAll('tr[data-session-id]').forEach((tr) => {
            tr.addEventListener('click', () => openSession(Number(tr.dataset.sessionId)));
        });
    }
}

// --- Calendar (ported from the club's other admin app, Club Training) ---
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const today = new Date();
let calYear = today.getFullYear();
let calMonth = today.getMonth() + 1; // 1-12

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function mondayIndex(jsDay) { return (jsDay + 6) % 7; } // getDay(): 0=Sun..6=Sat -> Mon-first 0..6

// Weeks of date objects covering the given month, padded with adjacent-month
// days so every week is a full 7 days (Mon-first, matching Club Training's
// calendar.monthdatescalendar()).
function buildCalendarWeeks(year, month) {
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const startOffset = mondayIndex(first.getDay());
    const cells = [];
    for (let i = startOffset; i > 0; i--) cells.push(new Date(year, month - 1, 1 - i));
    for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month - 1, day));
    while (cells.length % 7 !== 0) {
        const last = cells[cells.length - 1];
        cells.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
}

function renderCalendar() {
    const byDate = new Map();
    for (const s of filteredSessions()) {
        if (!byDate.has(s.date)) byDate.set(s.date, []);
        byDate.get(s.date).push(s);
    }

    $('#calendar-title').textContent = `${MONTH_NAMES[calMonth - 1]} ${calYear}`;
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    $('#calendar-thead').innerHTML = `<tr>${dayNames.map((d) => `<th>${d}</th>`).join('')}</tr>`;

    const todayKey = dateKey(today);
    const weeks = buildCalendarWeeks(calYear, calMonth);
    $('#calendar-tbody').innerHTML = weeks.map((week) => `
        <tr>${week.map((d) => {
            const key = dateKey(d);
            const inMonth = d.getMonth() === calMonth - 1;
            const cellClasses = ['calendar-cell', !inMonth && 'calendar-cell-out', key === todayKey && 'calendar-cell-today'].filter(Boolean).join(' ');
            const sessions = byDate.get(key) || [];
            const badges = sessions.map((s) => `
                <a href="#" class="badge calendar-badge session-${s.status}" data-session-id="${s.id}" title="${esc(s.label || 'Session')} - ${s.players_checked_in} player${s.players_checked_in === 1 ? '' : 's'}">${esc(s.label || 'Session')} - ${s.players_checked_in}</a>
            `).join('');
            return `<td class="${cellClasses}"><div class="calendar-date">${d.getDate()}</div>${badges}</td>`;
        }).join('')}</tr>
    `).join('');

    $('#calendar-tbody').querySelectorAll('.calendar-badge').forEach((el) => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openSession(Number(el.dataset.sessionId));
        });
    });
}

$('#calendar-prev').addEventListener('click', () => {
    calMonth--;
    if (calMonth < 1) { calMonth = 12; calYear--; }
    renderCalendar();
});

$('#calendar-next').addEventListener('click', () => {
    calMonth++;
    if (calMonth > 12) { calMonth = 1; calYear++; }
    renderCalendar();
});

// --- One session's rounds ---
// One row per round (number, start time, courts); clicking a row opens
// that round's games on its own, with a link back to the list - every
// round's games stacked on one page was too much to scan.
let sessionRounds = [];

function localClockTime(dtStr) {
    return new Date(`${dtStr.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function openSession(sessionId) {
    try {
        const data = await api(`/api/history/sessions/${sessionId}`);
        openedSessionId = sessionId;
        showView('session');
        $('#session-title').textContent = `${data.session.label || 'Session'} - ${formatDate(data.session.date)}`;
        mountTonightSummary($('#session-payment-summary'), sessionId);
        sessionRounds = data.rounds;
        renderRoundList();
    } catch (err) {
        showError(err.message);
    }
}

function renderRoundList() {
    const container = $('#session-rounds');
    if (sessionRounds.length === 0) {
        container.innerHTML = '<p class="muted">No games were played in this session.</p>';
        return;
    }
    container.innerHTML = `
        <table class="history-table">
            <thead><tr><th>Round</th><th>Started</th><th class="num">Courts</th><th class="num">Players</th></tr></thead>
            <tbody>
                ${sessionRounds.map((r, i) => `
                    <tr data-round-idx="${i}">
                        <td><strong>Round ${r.round_number}</strong></td>
                        <td>${localClockTime(r.started_at)}</td>
                        <td class="num">${r.games.length}</td>
                        <td class="num">${r.games.reduce((n, g) => n + g.players.length, 0)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    container.querySelectorAll('tr[data-round-idx]').forEach((tr) => {
        tr.addEventListener('click', () => renderRoundDetail(Number(tr.dataset.roundIdx)));
    });
}

function renderRoundDetail(idx) {
    const round = sessionRounds[idx];
    const container = $('#session-rounds');
    container.innerHTML = `
        <div class="breadcrumb"><a id="back-to-rounds">&larr; All rounds</a></div>
        <div class="round-block">
            <h3>Round ${round.round_number} <span class="muted round-started">started ${localClockTime(round.started_at)}</span></h3>
            ${round.games.map((g) => renderGameRow(g)).join('')}
        </div>
        <div class="round-stepper" style="justify-content: space-between;">
            <button class="small" id="round-detail-prev" ${idx === 0 ? 'disabled' : ''}>&lsaquo; Round ${idx > 0 ? sessionRounds[idx - 1].round_number : ''}</button>
            <button class="small" id="round-detail-next" ${idx === sessionRounds.length - 1 ? 'disabled' : ''}>Round ${idx < sessionRounds.length - 1 ? sessionRounds[idx + 1].round_number : ''} &rsaquo;</button>
        </div>
    `;
    $('#back-to-rounds').addEventListener('click', renderRoundList);
    $('#round-detail-prev').addEventListener('click', () => renderRoundDetail(idx - 1));
    $('#round-detail-next').addEventListener('click', () => renderRoundDetail(idx + 1));
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderGameRow(g) {
    const side = (n) => g.players
        .filter((p) => p.side === n)
        .map((p) => `${esc(p.first_name)} ${esc(p.last_name)}${skillTag(p.skill_level_at_time)}`)
        .join(' & ') || '<span class="muted">-</span>';
    if (g.format === 'threes') {
        // no sides, no "vs": just the three on the court
        return `
        <div class="history-game">
            <span class="court-tag">Court ${g.court_number}</span>
            <span class="team">${g.players.map((p) => `${esc(p.first_name)} ${esc(p.last_name)}${skillTag(p.skill_level_at_time)}`).join(' &middot; ')}</span>
            <span class="muted">threes</span>
        </div>
    `;
    }
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

// --- One player's history ---
async function openPlayer(playerId) {
    const from = $('#filter-from').value;
    const to = $('#filter-to').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString() ? `?${params.toString()}` : '';
    try {
        const data = await api(`/api/history/players/${playerId}${qs}`);
        showView('player');
        $('#player-title').textContent = `${data.player.first_name} ${data.player.last_name}`;
        const rangeNote = (from || to) ? ` (${from || 'start'} to ${to || 'now'})` : '';
        $('#player-subtitle').innerHTML = `Current grade ${skillTag(data.player.skill_level)} - ${data.games.length} game${data.games.length === 1 ? '' : 's'} on record${rangeNote}. Grade shown per row is what they were officially playing at that night.`;
        const tbody = $('#player-games-table tbody');
        if (data.games.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="muted">No games on record for this range.</td></tr>';
            return;
        }
        tbody.innerHTML = data.games.map((g) => `
            <tr>
                <td>${formatDate(g.date)}</td>
                <td>${esc(g.label || 'Session')}</td>
                <td class="num">${g.round_number}</td>
                <td class="num">${g.court_number}</td>
                <td class="num">${skillTag(g.skill_level_at_time)}</td>
                <td>${g.partners.map((p) => `${esc(p.first_name)} ${esc(p.last_name)}${skillTag(p.skill_level_at_time)}`).join(', ') || '<span class="muted">-</span>'}</td>
                <td>${g.opponents.map((p) => `${esc(p.first_name)} ${esc(p.last_name)}${skillTag(p.skill_level_at_time)}`).join(', ')}</td>
            </tr>
        `).join('');
    } catch (err) {
        showError(err.message);
    }
}

// --- Player search box ---
async function runPlayerSearch() {
    const q = $('#player-search').value.trim();
    const resultsEl = $('#player-search-results');
    if (!q) { resultsEl.innerHTML = ''; return; }
    try {
        const players = await api(`/api/players?search=${encodeURIComponent(q)}`);
        resultsEl.innerHTML = players.slice(0, 8).map((p) => `
            <div data-player-id="${p.id}">${esc(p.first_name)} ${esc(p.last_name)}${skillTag(p.skill_level)}</div>
        `).join('') || '<div class="muted">No matches</div>';
        resultsEl.querySelectorAll('div[data-player-id]').forEach((el) => {
            el.addEventListener('click', () => {
                $('#player-search').value = '';
                resultsEl.innerHTML = '';
                openPlayer(Number(el.dataset.playerId));
            });
        });
    } catch (err) {
        showError(err.message);
    }
}

$('#player-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runPlayerSearch, 200);
});

$('#back-from-session').addEventListener('click', () => { showView('landing'); loadSessions(); });
$('#back-from-player').addEventListener('click', () => showView('landing'));

// --- Excel export (uses the From/To filter above) ---
function reportRangeQs() {
    const from = $('#filter-from').value;
    const to = $('#filter-to').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (sessionFilter === 'adhoc') params.set('adhoc', '1');
    else if (sessionFilter !== 'all') params.set('template_id', sessionFilter);
    return params.toString() ? `?${params.toString()}` : '';
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

$('#report-download').addEventListener('click', async () => {
    const url = `/api/export/report.xlsx${reportRangeQs()}`;
    // Inside the native app shell (launcher.py), a plain navigation/<a
    // href> to a Content-Disposition:attachment response doesn't trigger
    // WebView2's download handling - the click just does nothing, same
    // underlying gap the Display link workaround exists for (see pwa.js).
    // Fetch the file ourselves and hand it to pywebview's own Save As
    // dialog instead. Regular browser tabs (e.g. the installed PWA) never
    // get window.pywebview, so this falls through to the normal
    // navigation-based download there.
    if (window.pywebview?.api?.save_file) {
        try {
            const res = await fetch(url);
            if (!res.ok) { showError(`Export failed (${res.status})`); return; }
            const disposition = res.headers.get('content-disposition') || '';
            const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'session-trend.xlsx';
            const base64 = await blobToBase64(await res.blob());
            const result = await window.pywebview.api.save_file(filename, base64);
            if (!result.ok && !result.cancelled) showError('Could not save the file.');
        } catch (err) {
            showError(err.message);
        }
        return;
    }
    window.location.href = url;
});

// --- Boot ---
// --- Email a report: one session's tally, or a whole month's ---
// The preview shown here is the exact HTML that is emailed (built by
// lib/tallyReport.js on the server, which escapes every name and note).
const TALLY_TO_KEY = 'game-scheduler-tally-to';
let tallyDefaultTo = '';

function tallyTarget() {
    return $('#tally-kind').value === 'month'
        ? { path: `/api/tally/month/${$('#tally-month').value}`, ok: /^\d{4}-\d{2}$/.test($('#tally-month').value) }
        : { path: `/api/tally/session/${$('#tally-session').value}`, ok: !!$('#tally-session').value };
}

async function loadTallyPreview() {
    const isMonth = $('#tally-kind').value === 'month';
    $('#tally-session-field').style.display = isMonth ? 'none' : '';
    $('#tally-month-field').style.display = isMonth ? '' : 'none';
    $('#tally-error').style.display = 'none';
    $('#tally-result').textContent = '';
    const target = tallyTarget();
    $('#tally-send').disabled = true;
    if (!target.ok) { $('#tally-preview').innerHTML = `<p class="muted">${isMonth ? 'Choose a month.' : 'There are no sessions yet.'}</p>`; return; }
    try {
        const report = await api(target.path);
        $('#tally-preview').innerHTML = report.html;
        $('#tally-send').disabled = false;
    } catch (err) {
        $('#tally-preview').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
}

function openTallyModal(kind, sessionId) {
    const newestFirst = allSessions.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    $('#tally-session').innerHTML = newestFirst.map((s) => `<option value="${s.id}">${esc(formatDate(s.date))} - ${esc(s.label || 'Session')}</option>`).join('');
    if (sessionId) $('#tally-session').value = String(sessionId);
    $('#tally-kind').value = kind;
    $('#tally-month').value = `${calYear}-${pad2(calMonth)}`;
    let remembered = '';
    try { remembered = localStorage.getItem(TALLY_TO_KEY) || ''; } catch (e) { /* not remembered */ }
    if (!$('#tally-to').value) $('#tally-to').value = remembered || tallyDefaultTo;
    $('#tally-modal-backdrop').style.display = 'flex';
    loadTallyPreview();
}

function closeTallyModal() { $('#tally-modal-backdrop').style.display = 'none'; }

let openedSessionId = null;
$('#tally-open').addEventListener('click', () => openTallyModal('session', null));
$('#tally-open-session').addEventListener('click', () => openTallyModal('session', openedSessionId));
$('#tally-close').addEventListener('click', closeTallyModal);
$('#tally-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'tally-modal-backdrop') closeTallyModal(); });
['tally-kind', 'tally-session', 'tally-month'].forEach((id) => document.getElementById(id).addEventListener('change', loadTallyPreview));

$('#tally-send').addEventListener('click', async () => {
    const target = tallyTarget();
    const to = $('#tally-to').value.trim();
    $('#tally-error').style.display = 'none';
    $('#tally-result').textContent = 'Sending...';
    $('#tally-send').disabled = true;
    try {
        const res = await fetch(`${target.path}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
        $('#tally-result').textContent = `Sent to ${body.sent_to.join(', ')}`;
        try { localStorage.setItem(TALLY_TO_KEY, to); } catch (e) { /* not remembered */ }
    } catch (err) {
        $('#tally-result').textContent = '';
        $('#tally-error').textContent = err.message;
        $('#tally-error').style.display = 'block';
    } finally {
        $('#tally-send').disabled = false;
    }
});

async function init() {
    try {
        const club = await api('/api/club-settings');
        tallyDefaultTo = club.summary_recipient_emails || '';
        $('#club-name').textContent = club.club_name;
        applyBranding(club);
        setDateFormat(club.date_format);
    } catch (err) { /* non-fatal */ }
    try {
        await loadTemplateFilterOptions();
        await loadSessions();
    } catch (err) {
        showError(err.message);
    }
    // Live-refresh the session list as games complete in other tabs.
    subscribeToEvents((msg) => {
        if ($('#landing-view').style.display !== 'none' && (msg.type === 'game' || msg.type === 'session')) {
            loadSessions().catch(() => {});
        }
    });
}

init();
