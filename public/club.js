// Club Settings page: club settings, permanent courts roster, skill
// compatibility matrix, payment categories, and session templates. Player
// roster management and CSV/Excel import live on the separate Members page.

const GRADES = ['A', 'B', 'C', 'D', 'E'];
// The 3-letter code is still what's stored/sent (day_of_week's schema
// CHECK constraint) - only the label shown to staff changes.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LABELS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

let courts = []; // full courts table rows
let matrixState = {}; // "A-B" -> bool (canonical: both directions kept equal)
let templates = [];
let paymentCategories = [];
let editingTemplateKey = null; // template.id currently in edit mode (or 'new'); only one at a time
let justSavedTemplateKey = null; // briefly flashes "Saved" on the card that just collapsed back to read-only

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
    if (message) window.scrollTo(0, 0);
}

function flashSaved(sel) {
    const el = $(sel);
    el.textContent = 'Saved';
    setTimeout(() => { el.textContent = ''; }, 2000);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Whole-dollar prices are the common case - showing "10.00" everywhere
// reads as noise when it's almost always a round number. Cents still show
// when a club actually uses them (e.g. "9.50").
function dollarsDisplay(cents) {
    const dollars = (cents ?? 0) / 100;
    return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// --- Section switcher ---
// Left sidebar picks the window; Club details expands into its own
// sub-items while it (or one of them) is showing.
const CLUB_DETAIL_SECTIONS = ['club-details', 'club-name', 'club-date', 'club-defaults', 'payment-categories'];

function showSettingsSection(name) {
    document.querySelectorAll('[data-section]').forEach((el) => {
        el.style.display = el.dataset.section === name ? '' : 'none';
    });
    const inClubDetails = CLUB_DETAIL_SECTIONS.includes(name);
    $('#club-details-subnav').style.display = inClubDetails ? '' : 'none';
    document.querySelectorAll('#settings-sidebar button[data-goto]').forEach((btn) => {
        const active = btn.dataset.goto === name || (btn.dataset.goto === 'club-details' && inClubDetails);
        btn.classList.toggle('active', active);
    });
    window.scrollTo(0, 0);
}

document.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => showSettingsSection(btn.dataset.goto)));
showSettingsSection('overview');

// --- Overview (what Settings opens to): the club at a glance ---
let clubSettings = null;

function renderOverview() {
    if (!clubSettings) return;
    $('#overview-club-name').textContent = clubSettings.club_name;
    $('#overview-icon').src = `/api/branding/icon?v=${clubSettings.club_icon_ver || 0}`;
    const activeCourts = courts.filter((c) => c.is_active).length;
    $('#overview-club-meta').textContent = `${activeCourts} court${activeCourts === 1 ? '' : 's'} · ${clubSettings.default_game_minutes} min games, ${clubSettings.default_break_minutes} min changeovers · payment tracking ${clubSettings.square_enabled ? 'on' : 'off'}`;

    const list = $('#overview-sessions');
    if (!templates.length) {
        list.innerHTML = '<p class="muted">No session templates yet - add your regular session days under Session templates.</p>';
        return;
    }
    list.innerHTML = templates.map((t) => {
        const courtNumbers = (t.courts || []).slice().sort((a, b) => a.court_number - b.court_number).map((c) => c.court_number).join(', ') || 'none';
        const modeLabel = t.default_mode === 'auto' ? 'Auto' : t.default_mode === 'social' ? 'Social' : 'Manual';
        const rates = (t.payment_rates || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        const priceBox = rates.length
            ? `<div class="price-box">${rates.map((r) => `<div><span>${esc(r.name)}</span><strong>$${dollarsDisplay(r.amount_cents)}</strong></div>`).join('')}</div>`
            : '<div class="price-box muted">No prices set</div>';
        return `
            <div class="overview-session">
                <div>
                    <strong>${esc(t.label)}</strong>
                    <p class="muted" style="margin:4px 0 0;">${DAY_LABELS[t.day_of_week] || t.day_of_week} ${t.start_time}-${t.end_time} · ${modeLabel} mode · ${t.default_format === 'singles' ? 'Singles' : 'Doubles'}<br>Courts ${courtNumbers}${t.default_max_capacity ? ` · guideline ${t.default_max_capacity} players` : ''}</p>
                </div>
                ${priceBox}
            </div>
        `;
    }).join('');
}

// --- Club settings ---
async function loadSettings() {
    const s = await api('/api/club-settings');
    clubSettings = s;
    renderOverview();
    $('#club-name').textContent = s.club_name;
    applyBranding(s);
    setDateFormat(s.date_format);
    $('#cs-name').value = s.club_name;
    $('#cs-date-format').value = s.date_format;
    $('#cs-game').value = s.default_game_minutes;
    $('#cs-break').value = s.default_break_minutes;
    $('#cs-square').checked = !!s.square_enabled;
    $('#cs-gender-aware').checked = !!s.gender_aware_pairing;
    $('#cs-network').checked = !!s.allow_network_access;
    $('#icon-preview').src = `/api/branding/icon?v=${s.club_icon_ver || 0}`;
    $('#email-provider').value = s.email_provider || 'smtp2go';
    $('#email-smtp2go-api-key').value = s.smtp2go_api_key || '';
    $('#email-smtp2go-sender-address').value = s.smtp2go_sender_email || '';
    $('#email-smtp2go-sender-name').value = s.smtp2go_sender_name || '';
    $('#email-mailgun-api-key').value = s.mailgun_api_key || '';
    $('#email-mailgun-domain').value = s.mailgun_domain || '';
    $('#email-mailgun-sender-address').value = s.mailgun_sender_email || '';
    $('#email-mailgun-sender-name').value = s.mailgun_sender_name || '';
    $('#email-gmail-user').value = s.gmail_user || '';
    $('#email-gmail-app-password').value = s.gmail_app_password || '';
    $('#email-recipients').value = s.summary_recipient_emails || '';
    showProviderFields($('#email-provider').value);
    $('#payments-access-token').value = s.square_access_token || '';
    $('#payments-location-id').value = s.square_location_id || '';
}

// Club details is split into small windows (name & icon / date format /
// game defaults), each saving only its own fields - the PUT merges, so a
// partial body never clobbers the rest.
async function saveClubFields(fields, savedNoteSel) {
    try {
        const saved = await api('/api/club-settings', { method: 'PUT', body: JSON.stringify(fields) });
        $('#club-name').textContent = saved.club_name;
        setDateFormat(saved.date_format);
        clubSettings = saved;
        renderOverview();
        showError('');
        flashSaved(savedNoteSel);
    } catch (err) {
        showError(err.message);
    }
}

$('#cs-name-save').addEventListener('click', () => saveClubFields({ club_name: $('#cs-name').value.trim() }, '#cs-name-saved'));
$('#cs-date-save').addEventListener('click', () => saveClubFields({ date_format: $('#cs-date-format').value }, '#cs-date-saved'));
$('#cs-defaults-save').addEventListener('click', () => saveClubFields({
    default_game_minutes: Number($('#cs-game').value),
    default_break_minutes: Number($('#cs-break').value),
    square_enabled: $('#cs-square').checked,
    gender_aware_pairing: $('#cs-gender-aware').checked,
    allow_network_access: $('#cs-network').checked,
}, '#cs-defaults-saved'));

// --- Club icon (favicon, header logo, desktop shortcut icon) ---
// Resizes client-side to a square 256x256 PNG (cover-crop, matching the
// Club Training app's approach) before upload - the server re-validates
// independently either way.
function resizeImageToPng(file, size) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            const scale = Math.max(size / img.width, size / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
            URL.revokeObjectURL(img.src);
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))), 'image/png');
        };
        img.onerror = () => reject(new Error('Could not read that image file - is it a valid PNG, JPG or WebP?'));
        img.src = URL.createObjectURL(file);
    });
}

$('#icon-file').addEventListener('change', async () => {
    const file = $('#icon-file').files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
        showError('Icon must be 2MB or smaller.');
        $('#icon-file').value = '';
        return;
    }
    try {
        const blob = await resizeImageToPng(file, 256);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = await api('/api/branding/icon', {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: bytes,
        });
        $('#icon-preview').src = `/api/branding/icon?v=${result.version}`;
        applyBranding({ club_icon_ver: result.version });
        showError('');
        flashSaved('#icon-saved');
    } catch (err) {
        showError(err.message);
    } finally {
        $('#icon-file').value = '';
    }
});

// --- Email (SMTP2Go / Mailgun / Gmail - sends the manual end-of-night summary) ---
function showProviderFields(provider) {
    document.querySelectorAll('[data-provider-group]').forEach((el) => {
        el.style.display = el.dataset.providerGroup === provider ? '' : 'none';
    });
}

$('#email-provider').addEventListener('change', () => showProviderFields($('#email-provider').value));

$('#email-save').addEventListener('click', async () => {
    try {
        await api('/api/club-settings', {
            method: 'PUT',
            body: JSON.stringify({
                email_provider: $('#email-provider').value,
                smtp2go_api_key: $('#email-smtp2go-api-key').value.trim() || null,
                smtp2go_sender_email: $('#email-smtp2go-sender-address').value.trim() || null,
                smtp2go_sender_name: $('#email-smtp2go-sender-name').value.trim() || null,
                mailgun_api_key: $('#email-mailgun-api-key').value.trim() || null,
                mailgun_domain: $('#email-mailgun-domain').value.trim() || null,
                mailgun_sender_email: $('#email-mailgun-sender-address').value.trim() || null,
                mailgun_sender_name: $('#email-mailgun-sender-name').value.trim() || null,
                gmail_user: $('#email-gmail-user').value.trim() || null,
                gmail_app_password: $('#email-gmail-app-password').value.trim() || null,
                summary_recipient_emails: $('#email-recipients').value.trim() || null,
            }),
        });
        showError('');
        flashSaved('#email-saved');
    } catch (err) {
        showError(err.message);
    }
});

$('#email-send-test').addEventListener('click', async () => {
    const resultEl = $('#email-test-result');
    resultEl.textContent = 'Sending...';
    resultEl.className = 'save-note';
    try {
        await api('/api/club-settings/send-test-email', { method: 'POST' });
        resultEl.textContent = 'Sent!';
    } catch (err) {
        resultEl.textContent = err.message;
        resultEl.className = 'save-note error';
    }
});

// --- Payments (Square credentials - not wired to actually process anything yet) ---
$('#payments-save').addEventListener('click', async () => {
    try {
        await api('/api/club-settings', {
            method: 'PUT',
            body: JSON.stringify({
                square_access_token: $('#payments-access-token').value.trim() || null,
                square_location_id: $('#payments-location-id').value.trim() || null,
            }),
        });
        showError('');
        flashSaved('#payments-saved');
    } catch (err) {
        showError(err.message);
    }
});

// --- Courts roster ---
async function loadCourts() {
    courts = await api('/api/courts');
    renderCourts();
    renderOverview();
}

function renderCourts() {
    const byNumber = new Map(courts.map((c) => [c.court_number, c]));
    $('#court-roster').innerHTML = Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
        const court = byNumber.get(n);
        const active = court && court.is_active;
        return `<div class="court-cell ${active ? 'active' : ''}" data-number="${n}">${n}</div>`;
    }).join('');
    document.querySelectorAll('.court-cell').forEach((cell) => {
        cell.addEventListener('click', () => toggleCourt(Number(cell.dataset.number)));
    });
}

async function toggleCourt(courtNumber) {
    const court = courts.find((c) => c.court_number === courtNumber);
    try {
        if (!court) {
            await api('/api/courts', { method: 'POST', body: JSON.stringify({ court_number: courtNumber, is_active: true }) });
        } else {
            await api(`/api/courts/${court.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !court.is_active }) });
        }
        showError('');
        await loadCourts();
        await loadTemplates(); // template court cells mark which numbers are on the club roster
    } catch (err) {
        showError(err.message);
    }
}

// --- Skill compatibility matrix ---
async function loadMatrix() {
    const rows = await api('/api/skill-compatibility');
    matrixState = {};
    for (const r of rows) matrixState[`${r.skill_a}-${r.skill_b}`] = !!r.allowed;
    renderMatrix();
}

function matrixAllowed(a, b) {
    return matrixState[`${a}-${b}`] ?? matrixState[`${b}-${a}`] ?? true;
}

function renderMatrix() {
    const table = $('#matrix');
    table.innerHTML = `
        <tr><th></th>${GRADES.map((g) => `<th>${g}</th>`).join('')}</tr>
        ${GRADES.map((a) => `
            <tr>
                <th>${a}</th>
                ${GRADES.map((b) => `
                    <td><input type="checkbox" data-a="${a}" data-b="${b}" ${matrixAllowed(a, b) ? 'checked' : ''}></td>
                `).join('')}
            </tr>
        `).join('')}
    `;
    table.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        box.addEventListener('change', () => {
            const { a, b } = box.dataset;
            matrixState[`${a}-${b}`] = box.checked;
            matrixState[`${b}-${a}`] = box.checked;
            // mirror the twin checkbox without a full re-render
            const twin = table.querySelector(`input[data-a="${b}"][data-b="${a}"]`);
            if (twin) twin.checked = box.checked;
        });
    });
}

$('#matrix-save').addEventListener('click', async () => {
    const pairs = [];
    for (const a of GRADES) {
        for (const b of GRADES) {
            if (a <= b) pairs.push({ skill_a: a, skill_b: b, allowed: matrixAllowed(a, b) });
        }
    }
    try {
        await api('/api/skill-compatibility', { method: 'PUT', body: JSON.stringify({ pairs }) });
        showError('');
        flashSaved('#matrix-saved');
    } catch (err) {
        showError(err.message);
    }
});

// --- Payment categories (club-wide list; prices themselves live per template) ---
async function loadPaymentCategories() {
    paymentCategories = await api('/api/payment-categories?all=true');
    renderPaymentCategories();
}

function paymentCategoryRowHtml(c) {
    return `
        <tr data-id="${c.id}">
            <td><input type="text" data-field="name" value="${c.name.replace(/"/g, '&quot;')}" style="width:100%;"></td>
            <td class="num"><input type="number" data-field="sort_order" value="${c.sort_order}" style="width:60px;"></td>
            <td class="num"><input type="checkbox" data-field="is_active" ${c.is_active ? 'checked' : ''}></td>
            <td>
                <button class="small" data-action="save-category">Save</button>
                <button class="small" data-action="delete-category">Delete</button>
            </td>
        </tr>
    `;
}

function renderPaymentCategories() {
    $('#payment-categories-tbody').innerHTML = paymentCategories.length
        ? paymentCategories.map(paymentCategoryRowHtml).join('')
        : '<tr><td colspan="4" class="muted">No payment categories yet.</td></tr>';
    document.querySelectorAll('#payment-categories-tbody button[data-action]').forEach((btn) => {
        const tr = btn.closest('tr');
        const id = Number(tr.dataset.id);
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'save-category') saveCategoryRow(id, tr);
            else deleteCategoryRow(id);
        });
    });
}

async function saveCategoryRow(id, tr) {
    const name = tr.querySelector('[data-field="name"]').value.trim();
    const sort_order = Number(tr.querySelector('[data-field="sort_order"]').value) || 0;
    const is_active = tr.querySelector('[data-field="is_active"]').checked;
    if (!name) {
        showError('Category name is required.');
        return;
    }
    try {
        await api(`/api/payment-categories/${id}`, { method: 'PUT', body: JSON.stringify({ name, sort_order, is_active }) });
        showError('');
        await loadPaymentCategories();
        await loadTemplates(); // rate inputs depend on the active category list
    } catch (err) {
        showError(err.message);
    }
}

async function deleteCategoryRow(id) {
    const c = paymentCategories.find((x) => x.id === id);
    if (!confirm(`Delete payment category "${c.name}"? Only works if it isn't used by a template, session, or attendance record yet - it'll offer to mark it inactive instead if it's already in use.`)) return;
    try {
        await api(`/api/payment-categories/${id}`, { method: 'DELETE' });
        showError('');
        await loadPaymentCategories();
        await loadTemplates();
        return;
    } catch (err) {
        // Already in use somewhere (a template's prices, a past session, an
        // attendance record) - deleting would break that history, but the
        // club still doesn't want to see it going forward, so offer the
        // fallback the error itself describes instead of leaving the user
        // to go find the Active checkbox on their own.
        if (!err.message.includes('Set it to inactive instead')) {
            showError(err.message);
            return;
        }
    }
    if (!confirm(`"${c.name}" is already in use, so it can't be deleted. Mark it inactive instead? It'll stop showing up as a choice anywhere new, but past records keep the name.`)) return;
    try {
        await api(`/api/payment-categories/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: false }) });
        showError('');
        await loadPaymentCategories();
        await loadTemplates();
    } catch (err) {
        showError(err.message);
    }
}

$('#pc-add').addEventListener('click', async () => {
    const name = $('#pc-new-name').value.trim();
    if (!name) {
        showError('Enter a name for the new category.');
        return;
    }
    try {
        await api('/api/payment-categories', { method: 'POST', body: JSON.stringify({ name, sort_order: paymentCategories.length }) });
        $('#pc-new-name').value = '';
        showError('');
        await loadPaymentCategories();
        await loadTemplates();
    } catch (err) {
        showError(err.message);
    }
});

// --- Session templates ---
async function loadTemplates() {
    templates = await api('/api/session-templates');
    renderTemplates();
    renderOverview();
}

// Rotation guideline: a soft, informational headcount target for this
// session type - shown to staff at check-in as a "getting full" hint, but
// never blocks anyone from checking in.
const ROTATION_GUIDELINE_HELP = 'How many players this session type comfortably fits (e.g. courts × 4-6). Purely informational - shown at check-in as a hint, never blocks anyone.';

// What each mode actually does at round-start time (see lib/roundLifecycle.js's
// beginRound): Auto always generates the pairing itself, hands-off. Manual
// never generates anything on its own - "Start round" needs a lineup staged
// first, whether staff dragged players onto courts by hand or just clicked
// the Rounds page's own "Auto-generate round" button as a one-off action.
// Social skips rounds/courts entirely - check-in and payment only.
const MODE_HELP = 'Auto: rounds generate and start themselves. Manual: a lineup must be staged first (by hand, or the Rounds page\'s "Auto-generate round" button). Social: check-in and payment only, no rounds.';

function templateEditHtml(t, idx) {
    const isNew = !t.id;
    // Every venue court number (1-32) is offered, not just the ones already
    // ticked on the Courts page - picking one that isn't on the club's
    // roster yet adds it there on save (see ensureCourtIds). A new template
    // starts with the club's active courts selected.
    const rosterByNumber = new Map(courts.map((c) => [c.court_number, c]));
    const selectedNumbers = new Set(
        isNew ? courts.filter((c) => c.is_active).map((c) => c.court_number) : (t.courts || []).map((c) => c.court_number)
    );
    const rateByCategory = new Map((t.payment_rates || []).map((r) => [r.payment_category_id, r.amount_cents]));
    const activeCategories = paymentCategories.filter((c) => c.is_active);
    return `
        <div class="template-card" data-idx="${idx}">
            <div class="template-card-header">
                <strong>${isNew ? 'New template' : esc(t.label)}</strong>
                ${isNew ? '' : `<button class="small" data-action="delete" data-idx="${idx}">Delete</button>`}
            </div>
            <div class="row">
                <div class="field"><label>Label</label><input type="text" data-field="label" value="${esc(t.label || '')}"></div>
                <div class="field">
                    <label>Day</label>
                    <select data-field="day_of_week">${DAYS.map((d) => `<option value="${d}" ${t.day_of_week === d ? 'selected' : ''}>${DAY_LABELS[d]}</option>`).join('')}</select>
                </div>
                <div class="field"><label>Start</label><input type="time" data-field="start_time" value="${t.start_time || '19:30'}"></div>
                <div class="field"><label>End</label><input type="time" data-field="end_time" value="${t.end_time || '21:30'}"></div>
            </div>
            <div class="row">
                <div class="field">
                    <label>Mode</label>
                    <select data-field="default_mode">
                        <option value="manual" ${t.default_mode !== 'auto' && t.default_mode !== 'social' ? 'selected' : ''}>Manual</option>
                        <option value="auto" ${t.default_mode === 'auto' ? 'selected' : ''}>Auto</option>
                        <option value="social" ${t.default_mode === 'social' ? 'selected' : ''}>Social (check-in + payment only, no rounds)</option>
                    </select>
                    <p class="muted" style="font-size:0.78rem; margin: 4px 0 0;">${MODE_HELP}</p>
                </div>
                <div class="field">
                    <label>Format</label>
                    <select data-field="default_format">
                        <option value="doubles" ${t.default_format !== 'singles' ? 'selected' : ''}>Doubles (4 a court)</option>
                        <option value="singles" ${t.default_format === 'singles' ? 'selected' : ''}>Singles (2 a court, e.g. squash)</option>
                    </select>
                </div>
                <div class="field">
                    <label>Rotation guideline (optional)</label>
                    <input type="number" min="0" data-field="default_max_capacity" value="${t.default_max_capacity ?? ''}" placeholder="No guideline">
                    <p class="muted" style="font-size:0.78rem; margin: 4px 0 0;">${ROTATION_GUIDELINE_HELP}</p>
                </div>
            </div>
            <div class="row">
                <div class="field">
                    <label>Game length (minutes, optional)</label>
                    <input type="number" min="1" data-field="default_game_minutes" value="${t.default_game_minutes ?? ''}" placeholder="Use club default">
                </div>
                <div class="field">
                    <label>Changeover length (minutes, optional)</label>
                    <input type="number" min="0" data-field="default_break_minutes" value="${t.default_break_minutes ?? ''}" placeholder="Use club default">
                </div>
            </div>
            <div class="field">
                <label>Normal courts</label>
                <p class="muted" style="font-size:0.78rem; margin: 0 0 6px;">Click to toggle. A court not yet on the Courts page is added there automatically when you save.</p>
                <div class="court-roster tpl-court-roster">
                    ${Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
                        const onRoster = rosterByNumber.get(n)?.is_active;
                        return `<div class="court-cell tpl-court-cell ${selectedNumbers.has(n) ? 'active' : ''}" data-court-number="${n}" title="${onRoster ? `Court ${n}` : `Court ${n} - not on the Courts page yet`}">${n}</div>`;
                    }).join('')}
                </div>
            </div>
            <div class="field">
                <label>Prices ($)</label>
                <div class="row">
                    ${activeCategories.length ? activeCategories.map((c) => `
                        <div class="field" style="min-width:130px;">
                            <label class="muted" style="font-size:0.75rem;">${esc(c.name)}</label>
                            <input type="number" min="0" step="0.01" data-rate-category-id="${c.id}" value="${dollarsDisplay(rateByCategory.get(c.id))}">
                        </div>
                    `).join('') : '<p class="muted">No payment categories yet - add some above.</p>'}
                </div>
            </div>
            <div class="row" style="justify-content: flex-start;">
                <button class="primary small" data-action="save" data-idx="${idx}" style="flex: none;">${isNew ? 'Create template' : 'Save changes'}</button>
                ${isNew ? '' : `<button class="small" data-action="cancel" data-idx="${idx}" style="flex: none;">Cancel</button>`}
            </div>
        </div>
    `;
}

function templateReadonlyHtml(t, idx) {
    const courtNumbers = (t.courts || [])
        .slice().sort((a, b) => a.court_number - b.court_number)
        .map((c) => c.court_number).join(', ') || 'none';
    const activeCategories = paymentCategories.filter((c) => c.is_active);
    const rateByCategory = new Map((t.payment_rates || []).map((r) => [r.payment_category_id, r.amount_cents]));
    const priceSummary = activeCategories.length
        ? activeCategories.map((c) => `${esc(c.name)} $${dollarsDisplay(rateByCategory.get(c.id))}`).join(', ')
        : 'no payment categories configured';
    const modeLabel = t.default_mode === 'auto' ? 'Auto' : t.default_mode === 'social' ? 'Social' : 'Manual';
    return `
        <div class="template-card" data-idx="${idx}">
            <div class="template-card-header">
                <span><strong>${esc(t.label)}</strong>${t.id === justSavedTemplateKey ? '<span class="save-note">Saved</span>' : ''}</span>
                <span>
                    <button class="small" data-action="edit" data-idx="${idx}">Edit</button>
                    <button class="small" data-action="delete" data-idx="${idx}">Delete</button>
                </span>
            </div>
            <p class="muted">${DAY_LABELS[t.day_of_week] || t.day_of_week} ${t.start_time}-${t.end_time} &middot; ${modeLabel} mode &middot; ${t.default_format === 'singles' ? 'Singles' : 'Doubles'} &middot; Courts ${courtNumbers}${t.default_max_capacity ? ` &middot; guideline ${t.default_max_capacity} players` : ''}${t.default_game_minutes ? ` &middot; ${t.default_game_minutes}min games` : ''}${t.default_break_minutes ? ` &middot; ${t.default_break_minutes}min changeovers` : ''}</p>
            <p class="muted">Prices: ${priceSummary}</p>
        </div>
    `;
}

function renderTemplates() {
    $('#template-list').innerHTML = templates.map((t, idx) => {
        const isNew = !t.id;
        const editing = isNew || t.id === editingTemplateKey;
        return editing ? templateEditHtml(t, idx) : templateReadonlyHtml(t, idx);
    }).join('');
    document.querySelectorAll('.tpl-court-cell').forEach((cell) => {
        cell.addEventListener('click', () => cell.classList.toggle('active'));
    });
    document.querySelectorAll('#template-list button[data-action]').forEach((btn) => {
        const idx = Number(btn.dataset.idx);
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'save') saveTemplate(idx);
            else if (btn.dataset.action === 'delete') deleteTemplate(idx);
            else if (btn.dataset.action === 'edit') { editingTemplateKey = templates[idx].id; renderTemplates(); }
            else if (btn.dataset.action === 'cancel') {
                if (templates[idx].id) { editingTemplateKey = null; renderTemplates(); }
                else { templates.splice(idx, 1); renderTemplates(); } // discard an unsaved new template entirely
            }
        });
    });
}

function readTemplateCard(idx) {
    const card = document.querySelector(`.template-card[data-idx="${idx}"]`);
    const value = (field) => card.querySelector(`[data-field="${field}"]`).value;
    const capacity = value('default_max_capacity');
    const gameMinutes = value('default_game_minutes');
    const breakMinutes = value('default_break_minutes');
    const payment_rates = Array.from(card.querySelectorAll('[data-rate-category-id]')).map((input) => ({
        payment_category_id: Number(input.dataset.rateCategoryId),
        amount_cents: Math.round(parseFloat(input.value || '0') * 100),
    }));
    return {
        label: value('label').trim(),
        day_of_week: value('day_of_week'),
        start_time: value('start_time'),
        end_time: value('end_time'),
        default_mode: value('default_mode'),
        default_format: value('default_format'),
        default_max_capacity: capacity === '' ? null : Number(capacity),
        default_game_minutes: gameMinutes === '' ? null : Number(gameMinutes),
        default_break_minutes: breakMinutes === '' ? null : Number(breakMinutes),
        court_numbers: Array.from(card.querySelectorAll('.tpl-court-cell.active')).map((i) => Number(i.dataset.courtNumber)),
        payment_rates,
    };
}

// Court numbers -> court ids, creating/re-activating any that aren't on
// the club's roster yet so a template can never reference a court that
// doesn't exist (sessions started from it copy these ids).
async function ensureCourtIds(courtNumbers) {
    const ids = [];
    let rosterChanged = false;
    for (const n of courtNumbers) {
        let court = courts.find((c) => c.court_number === n);
        if (!court) {
            court = await api('/api/courts', { method: 'POST', body: JSON.stringify({ court_number: n, is_active: true }) });
            rosterChanged = true;
        } else if (!court.is_active) {
            await api(`/api/courts/${court.id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
            rosterChanged = true;
        }
        ids.push(court.id);
    }
    if (rosterChanged) await loadCourts();
    return ids;
}

async function saveTemplate(idx) {
    const t = templates[idx];
    const body = readTemplateCard(idx);
    try {
        body.court_ids = await ensureCourtIds(body.court_numbers);
        let savedId = t.id;
        if (t.id) {
            await api(`/api/session-templates/${t.id}`, { method: 'PUT', body: JSON.stringify(body) });
            await api(`/api/session-templates/${t.id}/courts`, { method: 'PUT', body: JSON.stringify({ court_ids: body.court_ids }) });
            await api(`/api/session-templates/${t.id}/payment-rates`, { method: 'PUT', body: JSON.stringify({ rates: body.payment_rates }) });
        } else {
            const created = await api('/api/session-templates', { method: 'POST', body: JSON.stringify(body) });
            savedId = created.id;
        }
        showError('');
        // Collapse back to the read-only view - that state change (form ->
        // summary + Edit button) is the visible "yes, this saved" signal,
        // plus a brief "Saved" note next to the label.
        editingTemplateKey = null;
        justSavedTemplateKey = savedId;
        await loadTemplates();
        setTimeout(() => { justSavedTemplateKey = null; renderTemplates(); }, 2000);
    } catch (err) {
        showError(err.message);
    }
}

async function deleteTemplate(idx) {
    const t = templates[idx];
    if (!confirm(`Delete template "${t.label}"?`)) return;
    try {
        await api(`/api/session-templates/${t.id}`, { method: 'DELETE' });
        showError('');
        await loadTemplates();
    } catch (err) {
        showError(err.message);
    }
}

$('#template-add').addEventListener('click', () => {
    templates.push({ label: '', day_of_week: 'Mon', default_mode: 'manual', courts: [] });
    renderTemplates();
});

// --- Boot ---
async function init() {
    try {
        await loadSettings();
        await loadCourts();
        await loadMatrix();
        await loadPaymentCategories();
        await loadTemplates();
    } catch (err) {
        showError(err.message);
    }
    subscribeToEvents((msg) => {
        // Another tab may edit the same data; refresh the affected section.
        if (msg.type === 'courts') loadCourts().then(loadTemplates).catch(() => {});
        else if (msg.type === 'session_templates') loadTemplates().catch(() => {});
        else if (msg.type === 'club_settings') loadSettings().catch(() => {});
        else if (msg.type === 'skill_compatibility') loadMatrix().catch(() => {});
        else if (msg.type === 'payment_categories') loadPaymentCategories().then(loadTemplates).catch(() => {});
    });
}

init();
