// Builds the end-of-night summary email's subject/body from the same
// summary the "Session finished" box shows (lib/nightSummary.js, worded by
// public/nightSummaryText.js) plus the payment breakdown
// (lib/sessionReport.js) - so the emailed figures can never drift from
// what was on screen when the night was closed.
const { paymentBreakdown, attendanceCounts } = require('./sessionReport');
const { nightSummary } = require('./nightSummary');
const { nightSummaryLines } = require('../public/nightSummaryText');

function dollars(cents) {
    const d = (cents ?? 0) / 100;
    return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// session: {id, label, date, notes}
function buildSessionSummaryEmail(db, session) {
    const summary = paymentBreakdown(db, session.id);
    const counts = attendanceCounts(db, session.id);
    const night = nightSummary(db, session.id);
    const lines = night ? nightSummaryLines(night) : { players: [], play: null };
    const title = `${session.label || 'Session'} - ${session.date}`;
    const headline = `${counts.total} total - ${counts.checked_in} checked in, ${counts.booked} booked`
        + (counts.left > 0 ? `, ${counts.left} left` : '');

    const rows = summary.payment_breakdown.length
        ? summary.payment_breakdown.map((c) => `<tr><td>${esc(c.category)}</td><td style="text-align:right;">${c.count}</td><td style="text-align:right;">${dollars(c.amount_cents)}</td></tr>`).join('')
        : '<tr><td colspan="3">No payments recorded.</td></tr>';
    const textRows = summary.payment_breakdown.length
        ? summary.payment_breakdown.map((c) => `${c.category}: ${c.count} - ${dollars(c.amount_cents)}`).join('\n')
        : 'No payments recorded.';

    const notesHtml = session.notes
        ? `<p><strong>Notes:</strong><br>${esc(session.notes).replace(/\n/g, '<br>')}</p>`
        : '';
    const notesText = session.notes ? `\nNotes:\n${session.notes}\n` : '';

    const section = (heading, items) => (items && items.length
        ? `<h3 style="margin:16px 0 4px;">${heading}</h3><ul style="margin:0; padding-left:20px;">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
        : '');
    const textSection = (heading, items) => (items && items.length ? `\n${heading}\n${items.map((t) => `- ${t}`).join('\n')}\n` : '');

    const subject = `Game Scheduler summary - ${title}`;
    const htmlBody = `
        <h2>${esc(title)}</h2>
        <p>${esc(headline)}</p>
        ${section('Players', lines.players)}
        ${section('Play', lines.play)}
        <h3 style="margin:16px 0 4px;">Takings</h3>
        <table cellpadding="6" style="border-collapse:collapse;">
            <thead><tr><th style="text-align:left;">Category</th><th style="text-align:right;">Count</th><th style="text-align:right;">Total</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p><strong>Total funds: ${dollars(summary.total_funds_cents)}</strong></p>
        ${notesHtml}
    `;
    const textBody = `${title}\n\n${headline}\n${textSection('Players', lines.players)}${textSection('Play', lines.play)}\nTakings\n${textRows}\n\nTotal funds: ${dollars(summary.total_funds_cents)}\n${notesText}`;

    return { subject, htmlBody, textBody };
}

module.exports = { buildSessionSummaryEmail };
