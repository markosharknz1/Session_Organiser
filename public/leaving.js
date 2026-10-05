// Shared by the Check-in and Rounds pages: the right-click menu on a
// player, and the "is leaving" box behind it. Each page keeps its own data
// and passes the attendance entry in; this file only owns the two pieces of
// UI and the requests they make (through the page's own api()).
//
// Left early (the default) and Left injured keep the player in tonight's
// count with their payment; the reports name them. "Checked in by mistake"
// is the undo: it clears the payment details and drops them from tonight
// entirely (recorded with the same 'no-show' reason as a cancelled
// booking, which every total already leaves out).
//
// Left early can also be "after round N" - the player who says "I'm off
// after the next one". They stay on the list (and on their court) until
// that round ends, can't be put on a later court, and are marked as having
// left early when it finishes.

(function () {
    const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const el = (id) => document.getElementById(id);

    document.body.insertAdjacentHTML('beforeend', `
<div id="leave-modal-backdrop" class="modal-backdrop" style="display:none;">
    <div class="modal">
        <h3 style="margin: 0 0 12px;"><span id="lm-player-name"></span> is leaving</h3>
        <div class="leave-options">
            <label class="leave-option"><input type="radio" name="lm-reason" value="departed" checked>
                <span><strong>Left early</strong><br><span class="muted">Still counts as having attended; their payment stays.</span></span></label>
            <label class="leave-option"><input type="radio" name="lm-reason" value="injured">
                <span><strong>Left injured</strong><br><span class="muted">Counts as attended, payment stays, and is listed as an injury in the reports.</span></span></label>
            <label class="leave-option"><input type="radio" name="lm-reason" value="mistake">
                <span><strong>Checked in by mistake</strong><br><span class="muted">Takes them off today's list as if they were never here, and removes their payment details.</span></span></label>
        </div>
        <div class="field" id="lm-when-field" style="display:none;">
            <label for="lm-when">When are they going?</label>
            <select id="lm-when"></select>
            <p class="muted" id="lm-when-hint" style="margin:4px 0 0;"></p>
        </div>
        <div class="field" id="lm-note-field" style="display:none;">
            <label for="lm-note">What happened? (optional)</label>
            <textarea id="lm-note" rows="3" placeholder="e.g. rolled ankle on court 3, ice applied, went home with a friend"></textarea>
            <p class="muted" style="margin:4px 0 0;">Kept as the club's injury record - it appears in the emailed reports and in History's injury log, where it can be edited later.</p>
        </div>
        <p class="error-banner" id="lm-error" style="display:none;"></p>
        <div class="row" style="justify-content: flex-end;">
            <button id="lm-cancel">Cancel</button>
            <button class="primary" id="lm-confirm">Confirm</button>
        </div>
    </div>
</div>
<div id="row-menu" class="ctx-menu" style="display:none;" role="menu"></div>`);

    // --- Right-click menu ---
    function hideRowMenu() {
        el('row-menu').style.display = 'none';
        el('row-menu').innerHTML = '';
    }

    // items: [{ label, run, danger? }]
    function showRowMenu(e, title, items) {
        e.preventDefault();
        const menu = el('row-menu');
        menu.innerHTML = `<div class="ctx-title">${escHtml(title)}</div>` + items.map((it, i) =>
            `<button type="button" data-idx="${i}" class="${it.danger ? 'danger' : ''}">${escHtml(it.label)}</button>`).join('');
        menu.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => { hideRowMenu(); items[Number(btn.dataset.idx)].run(); });
        });
        menu.style.display = 'block';
        // Keep it on screen near the pointer.
        const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
        const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
        menu.style.left = `${Math.max(4, x)}px`;
        menu.style.top = `${Math.max(4, y)}px`;
        menu.querySelector('button')?.focus();
    }

    document.addEventListener('click', (e) => { if (!e.target.closest('#row-menu')) hideRowMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRowMenu(); });
    window.addEventListener('scroll', hideRowMenu, true);
    window.addEventListener('resize', hideRowMenu);

    // --- The "is leaving" box ---
    let leaving = null; // { a, onDone }

    const reason = () => document.querySelector('input[name="lm-reason"]:checked').value;

    function syncLeaveFields() {
        const r = reason();
        el('lm-note-field').style.display = r === 'injured' ? '' : 'none';
        const hasRounds = el('lm-when').options.length > 1;
        el('lm-when-field').style.display = r === 'departed' && hasRounds ? '' : 'none';
        const n = el('lm-when').value;
        el('lm-when-hint').textContent = n
            ? `They stay on the list until round ${n} finishes, then are marked as having left early. They come off any court already set up for a later round.`
            : 'They come off the list now, and off any court that has not been played yet.';
    }

    // a: the player's attendance entry (id, session_id, first_name,
    // last_name, leave_after_round). onDone runs after a successful save.
    async function openLeaveModal(a, { onDone } = {}) {
        if (!a) return;
        leaving = { a, onDone };
        el('lm-player-name').textContent = `${a.first_name} ${a.last_name}`;
        document.querySelector('input[name="lm-reason"][value="departed"]').checked = true;
        el('lm-note').value = '';
        el('lm-error').style.display = 'none';
        el('lm-when').innerHTML = '<option value="">Now</option>';
        syncLeaveFields();
        el('leave-modal-backdrop').style.display = 'flex';
        el('lm-confirm').focus();

        // Which rounds "after round N" can mean. A social session has none.
        try {
            const status = await api(`/api/sessions/${a.session_id}/rounds/status`);
            if (!leaving || leaving.a.id !== a.id || status.mode === 'social') return;
            const rounds = [];
            if (status.current_round) rounds.push([status.current_round, `After round ${status.current_round} (on court now)`]);
            rounds.push([status.next_round_number, `After round ${status.next_round_number} (the next round)`]);
            if (a.leave_after_round && !rounds.some(([n]) => n === a.leave_after_round)) {
                rounds.push([a.leave_after_round, `After round ${a.leave_after_round}`]);
            }
            el('lm-when').innerHTML = '<option value="">Now</option>' + rounds.map(([n, label]) => `<option value="${n}">${label}</option>`).join('');
            if (a.leave_after_round) el('lm-when').value = String(a.leave_after_round);
            syncLeaveFields();
        } catch (err) {
            // no round information (e.g. offline for a moment) - "Now" still works
        }
    }

    function closeLeaveModal() {
        el('leave-modal-backdrop').style.display = 'none';
        leaving = null;
    }

    document.querySelectorAll('input[name="lm-reason"]').forEach((radio) => radio.addEventListener('change', () => {
        syncLeaveFields();
        if (reason() === 'injured') el('lm-note').focus();
    }));
    el('lm-when').addEventListener('change', syncLeaveFields);
    el('lm-cancel').addEventListener('click', closeLeaveModal);
    el('leave-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'leave-modal-backdrop') closeLeaveModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && leaving) closeLeaveModal(); });

    el('lm-confirm').addEventListener('click', async () => {
        if (!leaving) return;
        const { a, onDone } = leaving;
        const r = reason();
        const afterRound = r === 'departed' ? Number(el('lm-when').value) || null : null;
        let body;
        if (r === 'mistake') {
            body = { state: 'left', left_reason: 'no-show', payment_category_id: null, payment_amount_cents: null, payment_method: null, payment_note: null, first_time: false, new_member: false };
        } else if (afterRound) {
            body = { leave_after_round: afterRound };
        } else {
            body = { state: 'left', left_reason: r, leave_note: r === 'injured' ? el('lm-note').value.trim() || null : null };
        }
        try {
            await api(`/api/attendance/${a.id}`, { method: 'PUT', body: JSON.stringify(body) });
            closeLeaveModal();
            if (onDone) await onDone();
        } catch (err) {
            el('lm-error').textContent = err.message;
            el('lm-error').style.display = 'block';
        }
    });

    // "Actually, I'll stay" - undoes a "leaving after round N".
    async function stayAfterAll(a, { onDone } = {}) {
        await api(`/api/attendance/${a.id}`, { method: 'PUT', body: JSON.stringify({ leave_after_round: null }) });
        if (onDone) await onDone();
    }

    // The small red tag shown beside a player who is leaving after a round.
    function leavingBadge(a) {
        return a && a.leave_after_round
            ? ` <span class="leaving-badge" title="Leaving after round ${a.leave_after_round}">leaving after R${a.leave_after_round}</span>`
            : '';
    }

    // The menu entries every page offers for a checked-in player.
    function leavingMenuItems(a, { onDone } = {}) {
        const items = [];
        if (a.leave_after_round) {
            items.push({ label: `Staying after all (was leaving after round ${a.leave_after_round})`, run: () => stayAfterAll(a, { onDone }).catch((err) => (typeof showError === 'function' ? showError : alert)(err.message)) });
        }
        items.push({ label: 'Leaving / remove...', danger: true, run: () => openLeaveModal(a, { onDone }) });
        return items;
    }

    Object.assign(window, { showRowMenu, hideRowMenu, openLeaveModal, stayAfterAll, leavingBadge, leavingMenuItems });
})();
