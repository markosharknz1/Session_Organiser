// Player Database page: browse/search/edit/delete the full player roster,
// import players from CSV/Excel, and manage database backups.

let allMembers = [];

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

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- Club members ---
let editingMemberId = null; // only one row editable at a time

async function loadMembers() {
    allMembers = await api('/api/players');
    renderMembers();
}

function skillBadge(skill) {
    return skill ? `<span class="badge skill-${skill}">${skill}</span>` : '';
}

function memberRowReadonlyHtml(p) {
    const statusLabel = { active: 'Active', lapsed: 'Lapsed', guest: 'Guest' }[p.membership_status] || p.membership_status;
    return `
        <tr data-id="${p.id}">
            <td>${esc(p.first_name)} ${esc(p.last_name)}</td>
            <td>${skillBadge(p.skill_level)}</td>
            <td>${p.gender || '-'}</td>
            <td class="muted">${statusLabel}</td>
            <td class="muted">${esc(p.membership_number || '')}</td>
            <td>
                <button class="small" data-action="edit-member">Edit</button>
                <button class="small" data-action="delete-member">Delete</button>
            </td>
        </tr>
    `;
}

function memberRowEditHtml(p) {
    return `
        <tr data-id="${p.id}">
            <td>
                <input type="text" data-field="first_name" value="${esc(p.first_name)}" style="width:90px;">
                <input type="text" data-field="last_name" value="${esc(p.last_name)}" style="width:110px;">
            </td>
            <td>
                <select data-field="skill_level">
                    ${['A', 'B', 'C', 'D', 'E'].map((g) => `<option value="${g}" ${p.skill_level === g ? 'selected' : ''}>${g}</option>`).join('')}
                </select>
            </td>
            <td>
                <select data-field="gender">
                    <option value="" ${!p.gender ? 'selected' : ''}>-</option>
                    <option value="F" ${p.gender === 'F' ? 'selected' : ''}>F</option>
                    <option value="M" ${p.gender === 'M' ? 'selected' : ''}>M</option>
                </select>
            </td>
            <td>
                <select data-field="membership_status">
                    <option value="active" ${p.membership_status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="lapsed" ${p.membership_status === 'lapsed' ? 'selected' : ''}>Lapsed</option>
                    <option value="guest" ${p.membership_status === 'guest' ? 'selected' : ''}>Guest</option>
                </select>
            </td>
            <td><input type="text" data-field="membership_number" value="${esc(p.membership_number || '')}" style="width:90px;"></td>
            <td>
                <button class="primary small" data-action="save-member">Save</button>
                <button class="small" data-action="cancel-edit-member">Cancel</button>
            </td>
        </tr>
    `;
}

function renderMembers() {
    const query = $('#member-search').value.trim().toLowerCase();
    const filtered = query
        ? allMembers.filter((p) => `${p.first_name} ${p.last_name}`.toLowerCase().includes(query))
        : allMembers;
    $('#member-count').textContent = allMembers.length;

    $('#members-tbody').innerHTML = filtered.length
        ? filtered.slice().sort(comparePlayersByName)
            .map((p) => (p.id === editingMemberId ? memberRowEditHtml(p) : memberRowReadonlyHtml(p))).join('')
        : `<tr class="empty-row"><td colspan="6" class="muted">${query ? 'No matching members.' : 'No members yet.'}</td></tr>`;

    document.querySelectorAll('#members-tbody button[data-action]').forEach((btn) => {
        const tr = btn.closest('tr');
        const id = Number(tr.dataset.id);
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'edit-member') { editingMemberId = id; renderMembers(); }
            else if (btn.dataset.action === 'cancel-edit-member') { editingMemberId = null; renderMembers(); }
            else if (btn.dataset.action === 'save-member') saveMemberRow(id, tr);
            else deleteMemberRow(id, tr);
        });
    });
}

async function saveMemberRow(id, tr) {
    const field = (name) => tr.querySelector(`[data-field="${name}"]`).value.trim();
    const first_name = field('first_name');
    const last_name = field('last_name');
    if (!first_name || !last_name) {
        showError('First and last name are required.');
        return;
    }
    try {
        await api(`/api/players/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                first_name,
                last_name,
                skill_level: field('skill_level'),
                gender: field('gender') || null,
                membership_status: field('membership_status'),
                membership_number: field('membership_number') || null,
            }),
        });
        editingMemberId = null;
        showError('');
        await loadMembers();
    } catch (err) {
        showError(err.message);
    }
}

async function deleteMemberRow(id, tr) {
    const name = `${tr.querySelector('td').textContent.trim()}`;
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
        await api(`/api/players/${id}`, { method: 'DELETE' });
        showError('');
        await loadMembers();
    } catch (err) {
        showError(err.message);
    }
}

$('#member-search').addEventListener('input', renderMembers);

$('#show-add-member').addEventListener('click', () => {
    const form = $('#add-member-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
});

// Splits "Joe Bloggs" -> {first: "Joe", last: "Bloggs"}; "Joe Van Bloggs" ->
// {first: "Joe", last: "Van Bloggs"}. Returns null if there's no space at
// all, since a last name is required.
function splitFullName(fullName) {
    const trimmed = fullName.trim().replace(/\s+/g, ' ');
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return null;
    return { first: trimmed.slice(0, spaceIdx), last: trimmed.slice(spaceIdx + 1) };
}

$('#am-submit').addEventListener('click', async () => {
    const name = splitFullName($('#am-name').value);
    if (!name) {
        showError('Enter a first and last name, e.g. "Joe Bloggs".');
        return;
    }
    try {
        await api('/api/players', {
            method: 'POST',
            body: JSON.stringify({
                first_name: name.first,
                last_name: name.last,
                skill_level: $('#am-skill').value,
                gender: $('#am-gender').value || null,
                membership_status: $('#am-status').value,
            }),
        });
        $('#am-name').value = '';
        $('#add-member-form').style.display = 'none';
        showError('');
        await loadMembers();
    } catch (err) {
        showError(err.message);
    }
});

// --- CSV / Excel import ---
let xlsxFile = null; // set when the chosen file is .xlsx; takes priority over pasted CSV text

$('#import-file').addEventListener('change', () => {
    const file = $('#import-file').files[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.xlsx')) {
        xlsxFile = file;
        $('#import-text').value = '';
        $('#import-text-field').style.display = 'none';
        return;
    }
    xlsxFile = null;
    $('#import-text-field').style.display = '';
    const reader = new FileReader();
    reader.onload = () => { $('#import-text').value = reader.result; };
    reader.readAsText(file);
});

async function runImport(commit) {
    const membershipStatus = $('#import-status').value;
    try {
        let result;
        if (xlsxFile) {
            const bytes = await xlsxFile.arrayBuffer();
            result = await api(`/api/players/import-xlsx?membership_status=${membershipStatus}&commit=${commit}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: bytes,
            });
        } else {
            const csvText = $('#import-text').value.trim();
            if (!csvText) {
                showError('Choose a CSV/Excel file or paste CSV text first.');
                return;
            }
            result = await api('/api/players/import', {
                method: 'POST',
                body: JSON.stringify({ csv_text: csvText, membership_status: membershipStatus, commit }),
            });
        }
        showError('');
        renderImportResult(result);
        if (result.committed) await loadMembers();
    } catch (err) {
        showError(err.message);
    }
}

$('#import-preview').addEventListener('click', () => runImport(false));

function renderImportResult(r) {
    const container = $('#import-result');
    const listItems = (arr, fmt) => arr.length ? `<ul>${arr.map(fmt).join('')}</ul>` : '<p class="muted" style="margin:0;">None</p>';
    container.innerHTML = `
        ${r.committed ? `<div class="bucket create"><h4>Imported ${r.created} player${r.created === 1 ? '' : 's'}${r.defaulted_skill ? ` (${r.defaulted_skill} defaulted to skill C - review their grades)` : ''}</h4></div>` : ''}
        <div class="bucket create">
            <h4>${r.committed ? 'Created' : 'Will create'} (${r.to_create.length})</h4>
            ${listItems(r.to_create, (i) => `<li>Row ${i.row}: ${i.name}${i.email ? ` &lt;${i.email}&gt;` : ''}</li>`)}
        </div>
        <div class="bucket skip">
            <h4>Skipped - already exist (${r.to_skip.length})</h4>
            ${listItems(r.to_skip, (i) => `<li>Row ${i.row}: ${i.name} (${i.reason})</li>`)}
        </div>
        <div class="bucket review">
            <h4>Needs manual review - not imported (${r.to_review.length})</h4>
            ${listItems(r.to_review, (i) => `<li>Row ${i.row}: ${i.name} (${i.email || 'no email'}, ${i.dob || 'no DOB'}) - possible duplicate of ${i.candidates.map((c) => `#${c.id} ${c.name}`).join(', ')}</li>`)}
        </div>
        ${!r.committed && r.to_create.length > 0 ? `<button class="primary" id="import-commit">Import ${r.to_create.length} new player${r.to_create.length === 1 ? '' : 's'}</button>` : ''}
    `;
    const commitBtn = $('#import-commit');
    if (commitBtn) commitBtn.addEventListener('click', () => runImport(true));
}

// --- Database backups ---
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadBackups() {
    const status = await api('/api/backup/status');
    $('#backup-location').textContent = `Automatic backups are saved to ${status.backup_dir} every time the app opens (the newest 30 are kept, older ones are pruned automatically).`;
    if (!status.backups.length) $('#backup-result').textContent = '';
    $('#backups-tbody').innerHTML = status.backups.length
        ? status.backups.map((b) => `
            <tr>
                <td>${esc(b.name)}</td>
                <td>${new Date(b.created_at).toLocaleString()}</td>
                <td class="num">${formatBytes(b.size_bytes)}</td>
                <td class="muted">${backupAssetsLabel(b)}</td>
                <td><a class="textlink" data-restore="${esc(b.name)}">Restore</a></td>
            </tr>
        `).join('')
        : '<tr class="empty-row"><td colspan="5" class="muted">No backups yet.</td></tr>';
}

function backupAssetsLabel(b) {
    if (!b.has_manifest) return 'not included (older backup)';
    const parts = [b.has_icon ? 'icon' : null, b.has_horn ? 'sound' : null].filter(Boolean);
    return parts.length ? parts.join(' + ') : 'built-in icon and horn';
}

// --- Restore ---
function restoredMessage(result) {
    const s = result.summary;
    const bits = [`Restored: ${s.players} players, ${s.sessions} sessions${s.last_session_date ? `, latest ${s.last_session_date}` : ''}.`];
    const asset = { restored: 'restored', removed: 'removed (the backup had none)', kept: 'left as it was', none: 'none' };
    bits.push(`Icon ${asset[result.assets.icon]}; sound ${asset[result.assets.horn]}.`);
    if (result.safety_backup) bits.push(`Your data as it was a moment ago is saved as ${result.safety_backup}.`);
    return bits.join(' ');
}

async function finishRestore(result) {
    $('#backup-result').textContent = restoredMessage(result);
    showError('');
    await loadMembers();
    await loadBackups();
}

$('#backups-tbody').addEventListener('click', async (e) => {
    const link = e.target.closest('[data-restore]');
    if (!link) return;
    const name = link.dataset.restore;
    try {
        const d = await api(`/api/backup/describe/${encodeURIComponent(name)}`);
        const open = await fetch('/api/sessions/open').then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const lines = [
            `Restore this backup?`,
            ``,
            `${d.club_name || 'Game Scheduler'} - ${d.players} players, ${d.sessions} sessions${d.last_session_date ? `, latest session ${d.last_session_date}` : ''}.`,
            d.includes_icon_and_sound ? `Club icon and sound: put back as they were (${backupAssetsLabel({ has_manifest: true, has_icon: d.has_icon, has_horn: d.has_horn })}).` : `Club icon and sound: not part of this older backup - left as they are now.`,
            ``,
            `Everything entered since this backup was made will be replaced. Your data as it is now is saved as a new backup first, so you can come back to it.`,
        ];
        if (open) lines.push('', `A SESSION IS OPEN RIGHT NOW (${open.label || 'session'}) - restoring replaces it.`);
        if (!confirm(lines.join('\n'))) return;
        const result = await api('/api/backup/restore', { method: 'POST', body: JSON.stringify({ name }) });
        await finishRestore(result);
    } catch (err) {
        showError(err.message);
    }
});

$('#backup-restore-file').addEventListener('click', () => $('#backup-restore-input').click());
$('#backup-restore-input').addEventListener('change', async () => {
    const file = $('#backup-restore-input').files[0];
    if (!file) return;
    try {
        if (!confirm(`Restore from "${file.name}"?\n\nThe club's data will be replaced by what is in this file. Your data as it is now is saved as a new backup first, so you can come back to it. The club icon and sound are not in a database file, so they stay as they are.`)) return;
        const res = await fetch('/api/backup/restore-upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer() });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `Restore failed (${res.status})`);
        await finishRestore(body);
    } catch (err) {
        showError(err.message);
    } finally {
        $('#backup-restore-input').value = '';
    }
});

$('#backup-now').addEventListener('click', async () => {
    try {
        await api('/api/backup/now', { method: 'POST' });
        showError('');
        await loadBackups();
    } catch (err) {
        showError(err.message);
    }
});

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Inside the native app shell (launcher.py) a plain navigation / <a
// download> to a file does nothing - WebView2 doesn't handle downloads in
// a pywebview window (same gap history.js works around). Hand the bytes
// to pywebview's own Save As dialog there; regular browser tabs get a
// normal download link instead.
async function saveFile(filename, blob) {
    if (window.pywebview?.api?.save_file) {
        const result = await window.pywebview.api.save_file(filename, await blobToBase64(blob));
        if (!result.ok && !result.cancelled) throw new Error('Could not save the file.');
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Exactly the headings lib/csvImport.js's planImport reads (the batch's
// membership status is chosen on this page, not per row - so it's not a
// column). Two example rows show the expected formats: dob as
// YYYY-MM-DD, skill_level A-E (blank defaults to C), gender M or F.
const IMPORT_TEMPLATE_CSV = [
    'first_name,last_name,email,phone,dob,skill_level,gender,membership_number,notes',
    'Jane,Smith,jane.smith@example.com,0400 000 000,1990-05-14,B,F,1234,',
    'Sam,Lee,,,,C,M,,Left-handed',
].join('\r\n') + '\r\n';

$('#import-template-download').addEventListener('click', async () => {
    try {
        await saveFile('player-import-template.csv', new Blob([IMPORT_TEMPLATE_CSV], { type: 'text/csv' }));
        showError('');
    } catch (err) {
        showError(err.message);
    }
});

$('#backup-download').addEventListener('click', async () => {
    try {
        const res = await fetch('/api/backup/download');
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const filename = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'game_scheduler.db';
        await saveFile(filename, await res.blob());
        showError('');
    } catch (err) {
        showError(err.message);
    }
});

// --- Boot ---
async function init() {
    try {
        const club = await api('/api/club-settings');
        $('#club-name').textContent = club.club_name;
        applyBranding(club);
    } catch (err) {
        // non-fatal, matches other pages
    }
    try {
        await loadMembers();
        await loadBackups();
    } catch (err) {
        showError(err.message);
    }
    subscribeToEvents((msg) => {
        if (msg.type === 'players') loadMembers().catch(() => {});
        else if (msg.type === 'club_settings') {
            api('/api/club-settings').then((c) => { $('#club-name').textContent = c.club_name; applyBranding(c); }).catch(() => {});
        }
    });
}

init();

wireNameSortToggle(document.getElementById('members-name-sort'), renderMembers);
