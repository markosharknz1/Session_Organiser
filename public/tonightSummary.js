// Shared across Check-in, Rounds, and History: a compact "tonight's totals"
// card - player count and payment-method counts/amounts for whichever
// session currently counts as "tonight" (the open one, or the most
// recently closed one - see GET /api/sessions/latest). One shared script
// (same idiom as events.js/branding.js) so the widget isn't built three
// slightly-different times.
//
// Deliberately separate from the History page's multi-session .xlsx export
// tool - this is a quick "how many players, how much of each payment type"
// glance at the most recent night only, not a trend report.

function tonightSummaryEsc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Whole-dollar amounts are the common case - "$10.00" everywhere reads as
// noise when it's almost always a round number. Cents still show when a
// club actually uses them (e.g. "$9.50").
function tonightDollars(cents) {
    const dollars = (cents ?? 0) / 100;
    return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// Payment method is a fixed small set (see routes/attendance.js's
// PAYMENT_METHODS) - a real grid column per method, not text crammed into
// one cell. One row per category (Member, Non-Member, Member Concession,
// ...), one column per method showing that category's count paid that way,
// a Total ($) column, and one totals row at the end.
const TONIGHT_METHODS = ['Cash', 'Card', 'Voucher'];

// title is optional - pass one (e.g. "Tonight's totals") to put a heading
// and the player-count headline on one compact line, for a panel that has
// no heading of its own yet. Omit it where the surrounding page already
// has its own heading (History's per-session detail view already shows
// the session name/date in its own <h2> right above this).
function tonightSummaryHtml(data, title) {
    if (!data) return '<p class="muted">No sessions yet.</p>';
    const categories = data.payment_breakdown;
    // Total, checked in, booked, and (when nonzero) left, as explicit
    // labeled numbers - a bare "N players" headline didn't add up against
    // the table below it once a booked-but-not-arrived player (counted in
    // the total, but not physically here) was in the mix. "Left" (arrived,
    // then removed/left early) is hidden entirely when zero, same as the
    // Check-in page's own "(+N booked)" convention, since most nights never
    // have one.
    const leftSegment = data.left > 0
        ? `<span class="tonight-headline-sep muted">&middot;</span><strong>${data.left}</strong> left`
        : '';
    const headlineText = `
        <strong>${data.total}</strong> total
        <span class="tonight-headline-sep muted">&middot;</span>
        <strong>${data.checked_in}</strong> checked in
        <span class="tonight-headline-sep muted">&middot;</span>
        <strong>${data.booked}</strong> booked
        ${leftSegment}
        <span class="muted"> - ${tonightSummaryEsc(data.session.label || 'Session')} (${tonightSummaryEsc(formatDate(data.session.date))})</span>
    `;
    const headline = title
        ? `<div class="tonight-headline tonight-title-row"><h2>${tonightSummaryEsc(title)}</h2><span>${headlineText}</span></div>`
        : `<div class="tonight-headline">${headlineText}</div>`;
    if (!categories.length) return `${headline}<p class="muted">No payments recorded yet.</p>`;

    const methodEntry = (c, method) => (c.methods || []).find((m) => m.method === method);
    const methodCount = (c, method) => methodEntry(c, method)?.count || 0;
    const columnTotalCents = (method) => categories.reduce((sum, c) => sum + (methodEntry(c, method)?.amount_cents || 0), 0);

    // Every category row is click-to-expand, revealing exactly who's behind
    // the number - a category with no cash/card/voucher method of its own
    // (Sports Voucher, say) would otherwise show 0 in every method column
    // with nothing to click on to confirm it wasn't actually empty.
    const colCount = TONIGHT_METHODS.length + 2;
    const rows = categories.map((c, i) => {
        const players = (c.players || []).slice().sort((a, b) => a.first_name.localeCompare(b.first_name) || a.last_name.localeCompare(b.last_name));
        const playerItems = players.length
            ? players.map((p) => `<li>${tonightSummaryEsc(p.first_name)} ${tonightSummaryEsc(p.last_name)}${p.method ? ` <span class="muted">(${tonightSummaryEsc(p.method)})</span>` : ''} - $${tonightDollars(p.amount_cents)}</li>`).join('')
            : '<li class="muted">No one recorded.</li>';
        const stripe = i % 2 === 0 ? 'tonight-row-even' : 'tonight-row-odd';
        return `
            <tr class="tonight-category-row ${stripe}" data-row="${i}">
                <td>${tonightSummaryEsc(c.category)} <span class="tonight-expand-arrow">&rsaquo;</span></td>
                ${TONIGHT_METHODS.map((method) => `<td class="num">${methodCount(c, method)}</td>`).join('')}
                <td class="num">$${tonightDollars(c.amount_cents)}</td>
            </tr>
            <tr class="tonight-detail-row" data-detail-for="${i}" style="display:none;">
                <td colspan="${colCount}"><ul class="tonight-player-list">${playerItems}</ul></td>
            </tr>
        `;
    }).join('');

    // Body rows show a headcount per method (how many paid this way); the
    // totals row switches to dollar amounts per method instead of counts -
    // that's the actual cash-up figure ("how much cash, how much card"),
    // not how many people used each method.
    return `
        ${headline}
        <table class="history-table tonight-payment-table">
            <thead><tr><th>Member type</th>${TONIGHT_METHODS.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Total ($)</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr class="tonight-total-row">
                <td>Total</td>
                ${TONIGHT_METHODS.map((method) => `<td class="num">$${tonightDollars(columnTotalCents(method))}</td>`).join('')}
                <td class="num">$${tonightDollars(data.total_funds_cents)}</td>
            </tr></tfoot>
        </table>
    `;
}

// Wires up the click-to-expand behaviour for tonightSummaryHtml's category
// rows - separate from the pure HTML builder above since it needs a live
// DOM to attach listeners to.
function wireTonightExpandRows(containerEl) {
    containerEl.querySelectorAll('.tonight-category-row').forEach((row) => {
        row.addEventListener('click', () => {
            const detail = containerEl.querySelector(`.tonight-detail-row[data-detail-for="${row.dataset.row}"]`);
            if (!detail) return;
            const expanded = detail.style.display !== 'none';
            detail.style.display = expanded ? 'none' : 'table-row';
            row.classList.toggle('expanded', !expanded);
        });
    });
}

// sessionId is optional - omit it (pass null) for "whichever session counts
// as tonight" (Check-in's landing view), or pass a specific session's id to
// show that session's own breakdown instead (History's per-session detail
// view, so a past night's Member/Non-Member/etc. numbers are just as easy
// to pull up as tonight's). title is optional - see tonightSummaryHtml.
async function mountTonightSummary(containerEl, sessionId, title) {
    if (!containerEl) return;
    try {
        let id = sessionId;
        if (!id) {
            const latestRes = await fetch('/api/sessions/latest');
            if (!latestRes.ok) {
                const heading = title ? `<h2>${tonightSummaryEsc(title)}</h2>` : '';
                containerEl.innerHTML = `${heading}<p class="muted">No session currently open.</p>`;
                return;
            }
            id = (await latestRes.json()).id;
        }
        const res = await fetch(`/api/sessions/${id}/payment-summary`);
        containerEl.innerHTML = tonightSummaryHtml(res.ok ? await res.json() : null, title);
        wireTonightExpandRows(containerEl);
    } catch (err) {
        containerEl.innerHTML = '<p class="muted">Could not load totals.</p>';
    }
}
