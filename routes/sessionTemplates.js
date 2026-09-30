const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { todayLocalDateStr } = require('../db/index');

const router = express.Router();

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES = ['auto', 'manual', 'social'];
const FORMATS = ['doubles', 'singles', 'threes'];

function dayOfWeekFor(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    return DAYS[d.getDay()];
}

// The club's own local date, not UTC - see db/index.js's
// todayLocalDateStr for why that distinction matters (a club well ahead of
// UTC, e.g. New Zealand, would otherwise see "today's session template"
// still showing yesterday's for hours after local midnight).
const todayDateStr = todayLocalDateStr;

function courtsForTemplate(templateId) {
    return store.query(
        `SELECT c.id AS court_id, c.court_number, c.label
         FROM session_template_courts stc JOIN courts c ON c.id = stc.court_id
         WHERE stc.session_template_id = ? ORDER BY c.court_number`,
        [templateId]
    );
}

function paymentRatesForTemplate(templateId) {
    return store.query(
        `SELECT r.payment_category_id, pc.name, r.amount_cents
         FROM session_template_payment_rates r JOIN payment_categories pc ON pc.id = r.payment_category_id
         WHERE r.session_template_id = ? ORDER BY pc.sort_order, pc.name`,
        [templateId]
    );
}

function setPaymentRatesForTemplate(templateId, rates) {
    store.run('DELETE FROM session_template_payment_rates WHERE session_template_id = ?', [templateId]);
    for (const r of rates) {
        store.run(
            'INSERT INTO session_template_payment_rates (session_template_id, payment_category_id, amount_cents) VALUES (?, ?, ?)',
            [templateId, r.payment_category_id, Math.round(r.amount_cents) || 0]
        );
    }
}

router.get('/', (req, res) => {
    const { day_of_week } = req.query;
    let sql = 'SELECT * FROM session_templates WHERE 1=1';
    const params = [];
    if (day_of_week) {
        sql += ' AND day_of_week = ?';
        params.push(day_of_week);
    }
    sql += ' ORDER BY start_time';
    const templates = store.query(sql, params);
    res.json(templates.map((t) => ({ ...t, courts: courtsForTemplate(t.id), payment_rates: paymentRatesForTemplate(t.id) })));
});

// Templates that apply to a given date (defaults to today) - this is what the
// "start a session" screen shows staff to pick from.
router.get('/for-date', (req, res) => {
    const date = req.query.date || todayDateStr();
    const dow = dayOfWeekFor(date);
    const templates = store.query('SELECT * FROM session_templates WHERE day_of_week = ? ORDER BY start_time', [dow]);
    res.json({
        date,
        day_of_week: dow,
        templates: templates.map((t) => ({ ...t, courts: courtsForTemplate(t.id), payment_rates: paymentRatesForTemplate(t.id) })),
    });
});

router.get('/:id', (req, res) => {
    const template = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]);
    if (!template) return res.status(404).json({ error: 'Session template not found' });
    res.json({ ...template, courts: courtsForTemplate(template.id), payment_rates: paymentRatesForTemplate(template.id) });
});

router.post('/', (req, res) => {
    const b = req.body;
    const errors = [];
    if (!b.label) errors.push('label is required');
    if (!b.day_of_week || !DAYS.includes(b.day_of_week)) errors.push(`day_of_week must be one of ${DAYS.join(', ')}`);
    if (!b.start_time) errors.push('start_time is required');
    if (!b.end_time) errors.push('end_time is required');
    if (!b.default_mode || !MODES.includes(b.default_mode)) errors.push(`default_mode must be one of ${MODES.join(', ')}`);
    const defaultFormat = b.default_format ?? 'doubles';
    if (!FORMATS.includes(defaultFormat)) errors.push(`default_format must be one of ${FORMATS.join(', ')}`);
    if (errors.length) return res.status(400).json({ errors });
    try {
        const id = store.insert(
            `INSERT INTO session_templates (label, day_of_week, start_time, end_time, default_mode, default_format, default_max_capacity, default_game_minutes, default_break_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [b.label, b.day_of_week, b.start_time, b.end_time, b.default_mode, defaultFormat, b.default_max_capacity ?? null,
                b.default_game_minutes ?? null, b.default_break_minutes ?? null]
        );
        const courtIds = Array.isArray(b.court_ids) ? b.court_ids : [];
        for (const courtId of courtIds) {
            store.run('INSERT INTO session_template_courts (session_template_id, court_id) VALUES (?, ?)', [id, courtId]);
        }
        if (Array.isArray(b.payment_rates)) setPaymentRatesForTemplate(id, b.payment_rates);
        store.persist();
        broadcast('session_templates', {});
        res.status(201).json({
            ...store.queryOne('SELECT * FROM session_templates WHERE id = ?', [id]),
            courts: courtsForTemplate(id),
            payment_rates: paymentRatesForTemplate(id),
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Session template not found' });
    const merged = { ...existing, ...req.body };
    if (!DAYS.includes(merged.day_of_week)) return res.status(400).json({ error: `day_of_week must be one of ${DAYS.join(', ')}` });
    if (!MODES.includes(merged.default_mode)) return res.status(400).json({ error: `default_mode must be one of ${MODES.join(', ')}` });
    if (!FORMATS.includes(merged.default_format ?? 'doubles')) return res.status(400).json({ error: `default_format must be one of ${FORMATS.join(', ')}` });
    try {
        store.run(
            `UPDATE session_templates SET label=?, day_of_week=?, start_time=?, end_time=?, default_mode=?, default_format=?, default_max_capacity=?, default_game_minutes=?, default_break_minutes=?
             WHERE id=?`,
            [merged.label, merged.day_of_week, merged.start_time, merged.end_time, merged.default_mode, merged.default_format ?? 'doubles', merged.default_max_capacity,
                merged.default_game_minutes ?? null, merged.default_break_minutes ?? null, req.params.id]
        );
        store.persist();
        broadcast('session_templates', {});
        res.json({
            ...store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]),
            courts: courtsForTemplate(req.params.id),
            payment_rates: paymentRatesForTemplate(req.params.id),
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Session template not found' });
    const inUse = store.queryOne('SELECT id FROM sessions WHERE template_id = ? LIMIT 1', [req.params.id]);
    if (inUse) return res.status(409).json({ error: 'Sessions have already been started from this template and cannot be deleted.' });
    store.run('DELETE FROM session_template_courts WHERE session_template_id = ?', [req.params.id]);
    store.run('DELETE FROM session_template_payment_rates WHERE session_template_id = ?', [req.params.id]);
    store.run('DELETE FROM session_templates WHERE id = ?', [req.params.id]);
    store.persist();
    broadcast('session_templates', {});
    res.status(204).end();
});

// Replace the full set of courts normally used by this template.
router.put('/:id/courts', (req, res) => {
    const existing = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Session template not found' });
    const courtIds = req.body.court_ids;
    if (!Array.isArray(courtIds)) return res.status(400).json({ error: 'court_ids must be an array' });
    store.run('DELETE FROM session_template_courts WHERE session_template_id = ?', [req.params.id]);
    for (const courtId of courtIds) {
        store.run('INSERT INTO session_template_courts (session_template_id, court_id) VALUES (?, ?)', [req.params.id, courtId]);
    }
    store.persist();
    broadcast('session_templates', {});
    res.json(courtsForTemplate(req.params.id));
});

// Replace the full set of payment prices (cents) for this template.
router.put('/:id/payment-rates', (req, res) => {
    const existing = store.queryOne('SELECT * FROM session_templates WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Session template not found' });
    const rates = req.body.rates;
    if (!Array.isArray(rates)) return res.status(400).json({ error: 'rates must be an array of {payment_category_id, amount_cents}' });
    setPaymentRatesForTemplate(req.params.id, rates);
    store.persist();
    broadcast('session_templates', {});
    res.json(paymentRatesForTemplate(req.params.id));
});

module.exports = router;
