// /api/tally - the tally report on the History page: preview it, or email
// it to an address typed in there. One session, or a whole month.
//   GET  /session/:id          GET  /month/:ym  (ym = YYYY-MM)   -> { subject, html, text, tally }
//   POST /session/:id/email    POST /month/:ym/email   body { to: "a@club.org, b@club.org" }
const express = require('express');
const store = require('../db/store');
const { sendEmail, parseRecipientList } = require('../lib/sendEmail');
const { sessionTally, monthTally, renderSessionTally, renderMonthTally } = require('../lib/tallyReport');

const router = express.Router();
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function clubRow() {
    return store.queryOne('SELECT * FROM club_settings WHERE id = 1') || {};
}

function build(kind, key) {
    const club = clubRow();
    const options = { clubName: club.club_name || 'Game Scheduler', dateFormat: club.date_format };
    if (kind === 'session') {
        const tally = sessionTally(store.getDb(), key);
        if (!tally) return { error: 'Session not found', status: 404 };
        return { club, tally, ...renderSessionTally(tally, options) };
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return { error: 'Month must look like 2026-10', status: 400 };
    const tally = monthTally(store.getDb(), key);
    if (!tally) return { error: 'There are no sessions in that month.', status: 404 };
    return { club, tally, ...renderMonthTally(tally, options) };
}

function preview(kind) {
    return (req, res) => {
        const r = build(kind, req.params.key);
        if (r.error) return res.status(r.status).json({ error: r.error });
        return res.json({ subject: r.subject, html: r.htmlBody, text: r.textBody, tally: r.tally });
    };
}

function send(kind) {
    return async (req, res) => {
        const to = parseRecipientList(req.body && req.body.to);
        if (to.length === 0) return res.status(400).json({ error: 'Type the address to send the report to.' });
        const bad = to.filter((a) => !EMAIL_PATTERN.test(a));
        if (bad.length) return res.status(400).json({ error: `That doesn't look like an email address: ${bad.join(', ')}` });
        const r = build(kind, req.params.key);
        if (r.error) return res.status(r.status).json({ error: r.error });
        try {
            const result = await sendEmail(r.club, { to, subject: r.subject, htmlBody: r.htmlBody, textBody: r.textBody });
            return res.json({ sent_to: to, subject: r.subject, ...result });
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
    };
}

router.get('/session/:key', preview('session'));
router.get('/month/:key', preview('month'));
router.post('/session/:key/email', send('session'));
router.post('/month/:key/email', send('month'));

module.exports = router;
