const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { vacateStagedGames } = require('../lib/leaving');

const router = express.Router();

// 'booked' = staff have marked this player as coming tonight, but they
// haven't arrived/paid yet - a lightweight pre-arrival reservation, no
// payment fields expected. Converting a booked row to 'here_today' (via
// PUT) is how staff record their actual arrival + payment once they show up.
const STATES = ['checked_in', 'here_today', 'playing', 'booked', 'left'];
const LEFT_REASONS = ['no-show', 'departed', 'injured', 'session_ended', 'removed'];
// How someone paid - a fixed, non-editable field (not a club-configurable
// category like payment_category_id, which is what TYPE of player they are).
const PAYMENT_METHODS = ['Cash', 'Card', 'Voucher'];

// Shared by POST (create + pay in one call) and PUT (attach/change payment
// on an existing row) so a category id has to pass the exact same checks
// either way - including belonging to THIS session's own priced categories,
// not just existing globally, so a stale/mismatched category from a modal
// that outlived a payment-rates change is rejected with a clear error
// instead of silently saving a category the session never actually priced.
function validatePaymentFields(sessionId, fields) {
    if (fields.payment_category_id !== null && fields.payment_category_id !== undefined) {
        const rate = store.queryOne(
            'SELECT 1 FROM session_payment_rates WHERE session_id = ? AND payment_category_id = ?',
            [sessionId, fields.payment_category_id]
        );
        if (!rate) return 'payment_category_id is not one of this session\'s payment categories';
    }
    if (fields.payment_amount_cents !== null && fields.payment_amount_cents !== undefined) {
        if (!Number.isFinite(fields.payment_amount_cents) || fields.payment_amount_cents < 0) {
            return 'payment_amount_cents must be a non-negative number';
        }
    }
    if (fields.payment_method !== null && fields.payment_method !== undefined && !PAYMENT_METHODS.includes(fields.payment_method)) {
        return `payment_method must be one of ${PAYMENT_METHODS.join(', ')}`;
    }
    return null;
}

// A voucher was already paid for when it was bought/allocated - checking
// someone in against one still counts them and their category, but is
// never new money taken that night. Enforced here (not just the check-in
// UI resetting the field) so it holds regardless of caller.
function applyPaymentDefaults(fields) {
    if (fields.payment_method === 'Voucher') fields.payment_amount_cents = 0;
}

router.get('/sessions/:sessionId/attendance', (req, res) => {
    const { state } = req.query;
    let sql = `SELECT a.*, p.first_name, p.last_name, p.skill_level, p.gender, pc.name AS payment_category_name
               FROM attendance a
               JOIN players p ON p.id = a.player_id
               LEFT JOIN payment_categories pc ON pc.id = a.payment_category_id
               WHERE a.session_id = ?`;
    const params = [req.params.sessionId];
    if (state) {
        sql += ' AND a.state = ?';
        params.push(state);
    }
    sql += ' ORDER BY a.checked_in_at';
    res.json(store.query(sql, params));
});

// Check-in and payment happen in ONE call when payment fields are included
// (the normal Check-in modal flow) - previously this was a separate POST
// then PUT, sharing one try/catch on the client. If the POST succeeded but
// the PUT failed (a network blip, or a stale payment_category_id), the
// player ended up checked in with blank/wrong payment info and no clear
// signal that had happened - a real "2 players had incorrect payment
// information" report. A single atomic write closes that window entirely:
// since sql.js is synchronous with no await gap in this handler, it either
// fully succeeds or fully fails with nothing persisted.
router.post('/sessions/:sessionId/attendance', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = store.queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { player_id, state, payment_category_id, payment_amount_cents, payment_method, payment_note, first_time, new_member } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    const player = store.queryOne('SELECT * FROM players WHERE id = ?', [player_id]);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const already = store.queryOne(
        `SELECT * FROM attendance WHERE session_id = ? AND player_id = ? AND state != 'left'`,
        [sessionId, player_id]
    );
    if (already) return res.status(409).json({ error: 'Player is already checked in to this session', attendance: already });
    const s = state && STATES.includes(state) ? state : 'here_today';

    const paymentFields = { payment_category_id, payment_amount_cents, payment_method, payment_note };
    const validationError = validatePaymentFields(sessionId, paymentFields);
    if (validationError) return res.status(400).json({ error: validationError });
    applyPaymentDefaults(paymentFields);

    try {
        const id = store.insert(
            `INSERT INTO attendance (session_id, player_id, state, was_booked, payment_category_id, payment_amount_cents, payment_method, payment_note, first_time, new_member)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                sessionId, player_id, s, s === 'booked' ? 1 : 0,
                paymentFields.payment_category_id ?? null,
                paymentFields.payment_amount_cents ?? null,
                paymentFields.payment_method ?? null,
                paymentFields.payment_note ?? null,
                first_time ? 1 : 0,
                new_member ? 1 : 0,
            ]
        );
        // Back after leaving: any "this spot emptied when they left" marker
        // on an upcoming court is out of date.
        store.run(
            `DELETE FROM game_vacancies WHERE player_id = ? AND game_id IN (SELECT id FROM games WHERE session_id = ?)`,
            [player_id, sessionId]
        );
        store.persist();
        broadcast('attendance', { session_id: Number(sessionId) });
        res.status(201).json(store.queryOne('SELECT * FROM attendance WHERE id = ?', [id]));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/attendance/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
    const merged = { ...existing, ...req.body };
    if (!STATES.includes(merged.state)) return res.status(400).json({ error: `state must be one of ${STATES.join(', ')}` });
    if (merged.state === 'left' && !merged.left_reason) {
        return res.status(400).json({ error: 'left_reason is required when state is left' });
    }
    if (merged.left_reason && !LEFT_REASONS.includes(merged.left_reason)) {
        return res.status(400).json({ error: `left_reason must be one of ${LEFT_REASONS.join(', ')}` });
    }
    const validationError = validatePaymentFields(existing.session_id, merged);
    if (validationError) return res.status(400).json({ error: validationError });
    applyPaymentDefaults(merged);
    // "Leaving after round N": only for someone who is here, and only for a
    // round that hasn't finished.
    let leaveAfterRound = null;
    if (['here_today', 'playing', 'checked_in'].includes(merged.state) && merged.leave_after_round !== null && merged.leave_after_round !== undefined && merged.leave_after_round !== '') {
        leaveAfterRound = Number(merged.leave_after_round);
        if (!Number.isInteger(leaveAfterRound) || leaveAfterRound < 1) {
            return res.status(400).json({ error: 'leave_after_round must be a round number' });
        }
        if (leaveAfterRound !== existing.leave_after_round) {
            const done = store.queryOne(
                `SELECT MAX(round_number) AS m FROM games WHERE session_id = ? AND status = 'completed'`,
                [existing.session_id]
            ).m || 0;
            if (leaveAfterRound <= done) {
                return res.status(400).json({ error: `Round ${leaveAfterRound} has already been played - choose a later round, or mark them as leaving now.` });
            }
        }
    }
    try {
        store.run(
            `UPDATE attendance SET state=?, left_reason=?, leave_note=?, leave_after_round=?, payment_category_id=?, payment_amount_cents=?, payment_method=?, payment_note=?, first_time=?, new_member=?
             WHERE id=?`,
            [
                merged.state,
                merged.state === 'left' ? merged.left_reason : null,
                merged.state === 'left' ? (String(merged.leave_note || '').trim() || null) : null,
                leaveAfterRound,
                merged.payment_category_id ?? null,
                merged.payment_amount_cents ?? null,
                merged.payment_method ?? null,
                merged.payment_note ?? null,
                merged.first_time ? 1 : 0,
                merged.new_member ? 1 : 0,
                req.params.id,
            ]
        );

        // A player leaving mid-session is cleanly detached from anything
        // staged for a future round - active/completed games (already
        // played) are never touched, preserving the audit trail.
        // Their place on each of those courts is remembered (game_vacancies)
        // so the Rounds page can show whose spot needs filling. Someone
        // leaving after round N keeps their court up to round N and comes
        // off anything staged beyond it.
        let affectedStagedGames = 0;
        if (merged.state === 'left') {
            affectedStagedGames = vacateStagedGames(existing.session_id, existing.player_id, 0);
        } else if (leaveAfterRound !== null) {
            affectedStagedGames = vacateStagedGames(existing.session_id, existing.player_id, leaveAfterRound);
        } else if (existing.leave_after_round !== null && existing.leave_after_round !== undefined) {
            // Staying after all: their old spots are no longer "left" ones
            // (they go back in the pool to be placed again).
            const cleared = store.query(
                `SELECT gv.game_id FROM game_vacancies gv JOIN games g ON g.id = gv.game_id WHERE gv.player_id = ? AND g.session_id = ?`,
                [existing.player_id, existing.session_id]
            );
            for (const row of cleared) store.run('DELETE FROM game_vacancies WHERE game_id = ? AND player_id = ?', [row.game_id, existing.player_id]);
            affectedStagedGames = cleared.length;
        }

        store.persist();
        broadcast('attendance', { session_id: existing.session_id });
        if (affectedStagedGames > 0) broadcast('game', { session_id: existing.session_id });
        res.json(store.queryOne('SELECT * FROM attendance WHERE id = ?', [req.params.id]));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
