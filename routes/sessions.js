const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { paymentBreakdown, uniquePlayerCount, attendanceCounts } = require('../lib/sessionReport');
const { sendEmail, parseRecipientList } = require('../lib/sendEmail');
const { buildSessionSummaryEmail } = require('../lib/sessionSummaryEmail');

const router = express.Router();

const STATUSES = ['open', 'closed'];
const MODES = ['auto', 'manual', 'social'];
const FORMATS = ['doubles', 'singles', 'threes']; // 4 a court, 2 a court, or 3 on a court with no sides (e.g. squash)
const PHASES = ['idle', 'game', 'break', 'awaiting_lineup', 'paused'];

function paymentRatesForSession(sessionId) {
    return store.query(
        `SELECT r.payment_category_id, pc.name, r.amount_cents
         FROM session_payment_rates r JOIN payment_categories pc ON pc.id = r.payment_category_id
         WHERE r.session_id = ? ORDER BY pc.sort_order, pc.name`,
        [sessionId]
    );
}

router.get('/', (req, res) => {
    const { status } = req.query;
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params = [];
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY date DESC, id DESC';
    res.json(store.query(sql, params));
});

// Must come before /:id so "open"/"latest" aren't captured as an id param.
router.get('/open', (req, res) => {
    const session = store.queryOne(`SELECT * FROM sessions WHERE status = 'open' LIMIT 1`);
    if (!session) return res.status(404).json({ error: 'No open session' });
    res.json(session);
});

// Whichever session "tonight" means for a quick summary: strictly the one
// currently open - nothing shows once it's finished. An earlier version of
// this fell back to "the most recently closed session, if from today" so
// the totals stayed visible right after clicking "Finish session", but
// that read as a stale/still-open session to anyone glancing at the screen
// later (the "Session finished" alert already shows the same cash-up
// numbers once, right when it happens - see showFinishedSessionSummary in
// checkin.js/manage.js - so nothing is lost by not persisting it here too).
router.get('/latest', (req, res) => {
    const open = store.queryOne(`SELECT * FROM sessions WHERE status = 'open' LIMIT 1`);
    if (!open) return res.status(404).json({ error: 'No open session' });
    res.json(open);
});

// Cash-up totals for one session - shown right after "Finish session" and
// on a tonight-only summary elsewhere, so whoever's closing up can
// reconcile players/payments without going to History and running a
// date-range export just to see tonight's numbers.
router.get('/:id/payment-summary', (req, res) => {
    const session = store.queryOne(`SELECT id, date, label, notes FROM sessions WHERE id = ?`, [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const db = store.getDb();
    res.json({ session, unique_players: uniquePlayerCount(db, session.id), ...attendanceCounts(db, session.id), ...paymentBreakdown(db, session.id) });
});

// Manual only - staff review the summary, then click Send. Never triggered
// automatically on close, so the app stays fully local/offline until staff
// choose to send (see lib/sendEmail.js/lib/sessionSummaryEmail.js). Errors
// here (bad api key, no recipients) are just reported back to the clicking
// user - nothing else about the session is affected either way.
router.post('/:id/send-summary-email', async (req, res) => {
    const session = store.queryOne(`SELECT id, date, label, notes FROM sessions WHERE id = ?`, [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const club = store.queryOne('SELECT * FROM club_settings WHERE id = 1');
    const to = parseRecipientList(club?.summary_recipient_emails);
    if (to.length === 0) return res.status(400).json({ error: 'No recipient email addresses configured - add some on the Club Settings page.' });

    try {
        const { subject, htmlBody, textBody } = buildSessionSummaryEmail(store.getDb(), session);
        const result = await sendEmail(club, { to, subject, htmlBody, textBody });
        res.json({ sent_to: to, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// The "same as usual" / "need to change something" start flow. Only one open
// session is ever expected at a time (decided in the spec), so this refuses
// to start a second one while one is already open - finish it first.
router.post('/start', (req, res) => {
    const { template_id, date, overrides } = req.body;
    if (!template_id) return res.status(400).json({ error: 'template_id is required' });
    if (!date) return res.status(400).json({ error: 'date is required' });

    const template = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [template_id]);
    if (!template) return res.status(404).json({ error: 'Session template not found' });

    const alreadyOpen = store.queryOne(`SELECT id FROM sessions WHERE status = 'open' LIMIT 1`);
    if (alreadyOpen) {
        return res.status(409).json({ error: 'A session is already open. Finish it before starting another.', session_id: alreadyOpen.id });
    }

    const o = overrides || {};
    const mode = o.mode && MODES.includes(o.mode) ? o.mode : template.default_mode;
    const format = o.format && FORMATS.includes(o.format) ? o.format : (template.default_format || 'doubles');
    const max_capacity = o.max_capacity !== undefined ? o.max_capacity : template.default_max_capacity;
    // Falls through to the template's own default when set, then further to
    // club_settings.default_game_minutes/break_minutes at round-start time
    // (see lib/roundLifecycle.js) if the template doesn't set one either.
    const game_minutes = o.game_minutes !== undefined ? o.game_minutes : template.default_game_minutes;
    const break_minutes = o.break_minutes !== undefined ? o.break_minutes : template.default_break_minutes;

    // court_ids override replaces the template's normal set for this session only;
    // the template's own session_template_courts rows are never touched.
    let courtIds;
    if (Array.isArray(o.court_ids)) {
        courtIds = o.court_ids;
    } else {
        courtIds = store.query(
            'SELECT court_id FROM session_template_courts WHERE session_template_id = ?',
            [template_id]
        ).map((r) => r.court_id);
    }

    // payment_rates override replaces the template's normal prices for this
    // session only (mirrors court_ids) - the template's own rates are never touched.
    let paymentRates;
    if (Array.isArray(o.payment_rates)) {
        paymentRates = o.payment_rates.map((r) => ({ payment_category_id: r.payment_category_id, amount_cents: Math.round(r.amount_cents) || 0 }));
    } else {
        paymentRates = store.query(
            'SELECT payment_category_id, amount_cents FROM session_template_payment_rates WHERE session_template_id = ?',
            [template_id]
        );
    }

    try {
        const sessionId = store.insert(
            `INSERT INTO sessions (template_id, date, label, scheduled_start_time, scheduled_end_time, location, status, mode, format, game_minutes, break_minutes, max_capacity, current_phase)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 'idle')`,
            [template_id, date, template.label, template.start_time, template.end_time, o.location ?? null,
                mode, format, game_minutes, break_minutes, max_capacity]
        );
        for (const courtId of courtIds) {
            store.run('INSERT INTO session_courts (session_id, court_id, in_use) VALUES (?, ?, 1)', [sessionId, courtId]);
        }
        for (const r of paymentRates) {
            store.run('INSERT INTO session_payment_rates (session_id, payment_category_id, amount_cents) VALUES (?, ?, ?)', [sessionId, r.payment_category_id, r.amount_cents]);
        }
        store.persist();
        broadcast('session', { session_id: sessionId });
        const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
        const courts = store.query(
            `SELECT sc.court_id, c.court_number, c.label FROM session_courts sc JOIN courts c ON c.id = sc.court_id WHERE sc.session_id = ? ORDER BY c.court_number`,
            [sessionId]
        );
        res.status(201).json({ ...session, courts, payment_rates: paymentRatesForSession(sessionId) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
});

// Basic ad-hoc create (no template) - for one-off events. The template-driven
// "same as usual / need to change something" flow is POST /sessions/start above.
router.post('/', (req, res) => {
    const b = req.body;
    const errors = [];
    if (!b.date) errors.push('date is required');
    if (!b.mode || !MODES.includes(b.mode)) errors.push(`mode must be one of ${MODES.join(', ')}`);
    const format = b.format ?? 'doubles';
    if (!FORMATS.includes(format)) errors.push(`format must be one of ${FORMATS.join(', ')}`);
    if (errors.length) return res.status(400).json({ errors });
    const willBeOpen = (b.status ?? 'open') === 'open';
    if (willBeOpen) {
        const alreadyOpen = store.queryOne(`SELECT id FROM sessions WHERE status = 'open' LIMIT 1`);
        if (alreadyOpen) {
            return res.status(409).json({ error: 'A session is already open. Finish it before starting another.', session_id: alreadyOpen.id });
        }
    }
    try {
        const id = store.insert(
            `INSERT INTO sessions (template_id, date, label, scheduled_start_time, scheduled_end_time, location, status, mode, format, game_minutes, break_minutes, max_capacity, current_phase)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [b.template_id ?? null, b.date, b.label ?? null, b.scheduled_start_time ?? null, b.scheduled_end_time ?? null,
                b.location ?? null, b.status ?? 'open', b.mode, format, b.game_minutes ?? null, b.break_minutes ?? null,
                b.max_capacity ?? null, b.current_phase ?? 'idle']
        );
        if (Array.isArray(b.court_ids)) {
            for (const courtId of b.court_ids) {
                store.run('INSERT INTO session_courts (session_id, court_id, in_use) VALUES (?, ?, 1)', [id, courtId]);
            }
        }
        if (Array.isArray(b.payment_rates)) {
            for (const r of b.payment_rates) {
                store.run('INSERT INTO session_payment_rates (session_id, payment_category_id, amount_cents) VALUES (?, ?, ?)',
                    [id, r.payment_category_id, Math.round(r.amount_cents) || 0]);
            }
        } else {
            // No rates given (the normal case for a genuinely ad-hoc session -
            // there's no template to source them from). Payment category is
            // what TYPE of player someone is (Member/Non-Member/Concession/
            // etc.) - that's true for a walk-in one-off event too, so it
            // uses the same club-wide categories as a templated session,
            // all at $0 so staff type the real amount per player at
            // check-in. is_system categories (the old Cash/Card/Voucher set,
            // kept only for historical payment records) are excluded - how
            // someone paid is recorded separately via
            // attendance.payment_method, not as a category. With payment
            // tracking on, a session with zero rates makes check-in
            // impossible (the payment dropdown has nothing to select), so
            // this also just guarantees there's always something to pick
            // from.
            const categories = store.query(
                `SELECT id FROM payment_categories WHERE is_active = 1 AND is_system = 0`
            );
            for (const c of categories) {
                store.run('INSERT INTO session_payment_rates (session_id, payment_category_id, amount_cents) VALUES (?, ?, 0)', [id, c.id]);
            }
        }
        store.persist();
        broadcast('session', { session_id: id });
        const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
        const courts = store.query(
            `SELECT sc.court_id, c.court_number, c.label FROM session_courts sc JOIN courts c ON c.id = sc.court_id WHERE sc.session_id = ? ORDER BY c.court_number`,
            [id]
        );
        res.status(201).json({ ...session, courts, payment_rates: paymentRatesForSession(id) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    const merged = { ...existing, ...req.body };
    if (!STATUSES.includes(merged.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    if (!MODES.includes(merged.mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
    if (!PHASES.includes(merged.current_phase)) return res.status(400).json({ error: `current_phase must be one of ${PHASES.join(', ')}` });
    if (!FORMATS.includes(merged.format ?? 'doubles')) return res.status(400).json({ error: `format must be one of ${FORMATS.join(', ')}` });
    if (merged.status === 'open' && existing.status !== 'open') {
        const alreadyOpen = store.queryOne(`SELECT id FROM sessions WHERE status = 'open' AND id != ?`, [req.params.id]);
        if (alreadyOpen) {
            return res.status(409).json({ error: 'A session is already open. Finish it before reopening another.', session_id: alreadyOpen.id });
        }
    }
    try {
        store.run(
            `UPDATE sessions SET template_id=?, date=?, label=?, scheduled_start_time=?, scheduled_end_time=?, location=?, status=?, mode=?, format=?, game_minutes=?, break_minutes=?, max_capacity=?, current_phase=?, phase_started_at=?, phase_ends_at=?, notes=?
             WHERE id=?`,
            [merged.template_id, merged.date, merged.label, merged.scheduled_start_time, merged.scheduled_end_time,
                merged.location, merged.status, merged.mode, merged.format ?? 'doubles', merged.game_minutes, merged.break_minutes, merged.max_capacity,
                merged.current_phase, merged.phase_started_at, merged.phase_ends_at, merged.notes ?? null, req.params.id]
        );
        store.persist();
        broadcast('session', { session_id: Number(req.params.id) });
        res.json(store.queryOne('SELECT * FROM sessions WHERE id = ?', [req.params.id]));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id/courts', (req, res) => {
    res.json(store.query(
        `SELECT sc.court_id, c.court_number, c.label, sc.in_use
         FROM session_courts sc JOIN courts c ON c.id = sc.court_id
         WHERE sc.session_id = ? ORDER BY c.court_number`,
        [req.params.id]
    ));
});

router.get('/:id/payment-rates', (req, res) => {
    res.json(paymentRatesForSession(req.params.id));
});

// Replaces a session's payment rates wholesale - lets staff fix up an
// existing session (e.g. an ad-hoc one that was somehow left with none) or
// change pricing mid-session without needing to close and restart it.
router.put('/:id/payment-rates', (req, res) => {
    const session = store.queryOne('SELECT id FROM sessions WHERE id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const rates = req.body.payment_rates;
    if (!Array.isArray(rates)) return res.status(400).json({ error: 'payment_rates array is required' });
    try {
        store.run('DELETE FROM session_payment_rates WHERE session_id = ?', [req.params.id]);
        for (const r of rates) {
            store.run('INSERT INTO session_payment_rates (session_id, payment_category_id, amount_cents) VALUES (?, ?, ?)',
                [req.params.id, r.payment_category_id, Math.round(r.amount_cents) || 0]);
        }
        store.persist();
        broadcast('session', { session_id: Number(req.params.id) });
        res.json(paymentRatesForSession(req.params.id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
