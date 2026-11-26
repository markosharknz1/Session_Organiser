// The end-of-night summary box, shared by Check-in and Rounds (shown when a
// session is finished) and History (any past night): who came, how the play
// went, and the takings - GET /api/sessions/:id/summary, lib/nightSummary.js
// - plus a "Send summary" button wired to POST
// /api/sessions/:id/send-summary-email. Same shared-script idiom as
// sessionNotes.js/tonightSummary.js - does its own fetch, no dependency on
// the host page's own api()/$ helpers. Needs nightSummaryText.js loaded
// first and a #session-summary-modal-backdrop with the expected child ids
// in the host page's HTML (see checkin.html/manage.html/history.html).

function sessionSummaryEsc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sessionSummaryDollars(cents) {
    const d = (cents ?? 0) / 100;
    return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

const SESSION_SUMMARY_METHODS = ['Cash', 'Card', 'Voucher'];

// The takings: one row per payment category that took part, a column per
// payment method (how many paid that way), and the dollar totals along the
// bottom - the cash-up figures.
function sessionSummaryTakingsHtml(money) {
    // The breakdown's "booked, not arrived" and "left before paying" lines
    // are people, not takings - the Players list above already names them.
    const categories = money.payment_breakdown.filter((c) => c.methods.length || c.amount_cents);
    if (!categories.length) return '<p class="muted">No payments recorded.</p>';
    const method = (c, name) => (c.methods || []).find((m) => m.method === name);
    const columnCents = (name) => categories.reduce((sum, c) => sum + ((method(c, name) || {}).amount_cents || 0), 0);
    return `
        <table class="history-table night-summary-takings">
            <thead><tr><th>Paid as</th>${SESSION_SUMMARY_METHODS.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Players</th><th class="num">Total</th></tr></thead>
            <tbody>
                ${categories.map((c) => `
                    <tr>
                        <td>${sessionSummaryEsc(c.category)}</td>
                        ${SESSION_SUMMARY_METHODS.map((m) => `<td class="num">${(method(c, m) || {}).count || 0}</td>`).join('')}
                        <td class="num">${c.count}</td>
                        <td class="num">${sessionSummaryDollars(c.amount_cents)}</td>
                    </tr>`).join('')}
            </tbody>
            <tfoot><tr class="tonight-total-row">
                <td>Total</td>
                ${SESSION_SUMMARY_METHODS.map((m) => `<td class="num">${sessionSummaryDollars(columnCents(m))}</td>`).join('')}
                <td class="num">${categories.reduce((n, c) => n + c.count, 0)}</td>
                <td class="num">${sessionSummaryDollars(money.total_funds_cents)}</td>
            </tr></tfoot>
        </table>`;
}

function sessionSummaryHtml(summary) {
    const lines = nightSummaryLines(summary);
    const list = (items) => `<ul class="night-summary-list">${items.map((t) => `<li>${sessionSummaryEsc(t)}</li>`).join('')}</ul>`;
    const tiles = [`<div><strong>${summary.players.came}</strong><span class="muted">${summary.players.came === 1 ? 'player' : 'players'} came</span></div>`];
    if (summary.play) {
        tiles.push(`<div><strong>${summary.play.rounds}</strong><span class="muted">${summary.play.rounds === 1 ? 'round' : 'rounds'}</span></div>`);
        tiles.push(`<div><strong>${summary.play.games}</strong><span class="muted">${summary.play.games === 1 ? 'game' : 'games'}</span></div>`);
    }
    if (summary.money) tiles.push(`<div><strong>${sessionSummaryDollars(summary.money.total_funds_cents)}</strong><span class="muted">taken</span></div>`);
    const notesHtml = summary.session.notes
        ? `<h4>Notes</h4><p class="night-summary-notes">${sessionSummaryEsc(summary.session.notes).replace(/\n/g, '<br>')}</p>`
        : '';
    return `
        <div class="trend-summary night-summary-tiles">${tiles.join('')}</div>
        <h4>Players</h4>
        ${list(lines.players)}
        ${lines.play ? `<h4>Play</h4>${list(lines.play)}` : ''}
        ${summary.money ? `<h4>Takings</h4>${sessionSummaryTakingsHtml(summary.money)}` : ''}
        ${notesHtml}
    `;
}

// heading: "Session finished" right after closing; History passes "Summary".
async function showSessionSummaryModal(sessionId, heading = 'Session finished') {
    const backdrop = document.querySelector('#session-summary-modal-backdrop');
    if (!backdrop) return;
    const titleEl = backdrop.querySelector('#session-summary-title');
    const bodyEl = backdrop.querySelector('#session-summary-body');
    const sendBtn = backdrop.querySelector('#session-summary-send');
    const sendResultEl = backdrop.querySelector('#session-summary-send-result');

    titleEl.textContent = heading;
    bodyEl.innerHTML = '<p class="muted">Loading...</p>';
    sendResultEl.textContent = '';
    sendResultEl.className = 'muted';
    sendResultEl.style.display = '';
    backdrop.style.display = 'flex';

    let summary;
    try {
        const res = await fetch(`/api/sessions/${sessionId}/summary`);
        summary = await res.json();
        if (!res.ok) throw new Error(summary?.error || 'Could not load the summary.');
    } catch (err) {
        bodyEl.innerHTML = `<p class="muted">${sessionSummaryEsc(err.message)}</p>`;
        return;
    }

    const date = typeof formatDate === 'function' ? formatDate(summary.session.date) : summary.session.date;
    titleEl.textContent = `${heading} - ${summary.session.label || 'Session'} (${date})`;
    bodyEl.innerHTML = sessionSummaryHtml(summary);

    sendBtn.onclick = async () => {
        sendBtn.disabled = true;
        sendResultEl.textContent = 'Sending...';
        sendResultEl.className = 'muted';
        try {
            const res = await fetch(`/api/sessions/${sessionId}/send-summary-email`, { method: 'POST' });
            const body = await res.json();
            if (!res.ok) throw new Error(body?.error || 'Send failed.');
            sendResultEl.textContent = `Sent to ${body.sent_to.join(', ')}`;
            sendResultEl.className = 'muted';
        } catch (err) {
            sendResultEl.textContent = err.message;
            sendResultEl.className = 'error-banner';
            sendResultEl.style.display = 'block';
        } finally {
            sendBtn.disabled = false;
        }
    };
}

function wireSessionSummaryModalClose() {
    const backdrop = document.querySelector('#session-summary-modal-backdrop');
    if (!backdrop) return;
    const closeBtn = backdrop.querySelector('#session-summary-close');
    const close = () => { backdrop.style.display = 'none'; };
    if (closeBtn) closeBtn.addEventListener('click', close);
    let mouseDownTarget = null;
    backdrop.addEventListener('mousedown', (e) => { mouseDownTarget = e.target; });
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop && mouseDownTarget === backdrop) close();
    });
}

wireSessionSummaryModalClose();
