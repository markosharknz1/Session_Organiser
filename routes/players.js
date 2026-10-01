const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { parseCsv, planImport } = require('../lib/csvImport');
const { parseGbcMembersXlsx } = require('../lib/xlsxImport');

const router = express.Router();

const SKILL_LEVELS = ['A', 'B', 'C', 'D', 'E'];
const MEMBERSHIP_STATUSES = ['active', 'lapsed', 'guest'];

function validatePlayer(body, { partial = false } = {}) {
    const errors = [];
    if (!partial) {
        for (const field of ['first_name', 'last_name', 'skill_level']) {
            if (!body[field]) errors.push(`${field} is required`);
        }
    }
    if (body.skill_level !== undefined && body.skill_level !== null && !SKILL_LEVELS.includes(body.skill_level)) {
        errors.push(`skill_level must be one of ${SKILL_LEVELS.join(', ')}`);
    }
    if (body.membership_status !== undefined && body.membership_status !== null && !MEMBERSHIP_STATUSES.includes(body.membership_status)) {
        errors.push(`membership_status must be one of ${MEMBERSHIP_STATUSES.join(', ')}`);
    }
    return errors;
}

router.get('/', (req, res) => {
    const { search, membership_status } = req.query;
    let sql = 'SELECT * FROM players WHERE 1=1';
    const params = [];
    if (search) {
        sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)';
        const like = `%${search}%`;
        params.push(like, like, like);
    }
    if (membership_status) {
        sql += ' AND membership_status = ?';
        params.push(membership_status);
    }
    sql += ' ORDER BY last_name, first_name';
    res.json(store.query(sql, params));
});

// Shared by both import routes below: runs the dedup plan and, if commit is
// true, inserts the toCreate bucket. commit=false returns a preview only -
// the client never sends player objects to insert, so a stale preview can't
// create duplicates that a re-run would have caught.
function runImportPlan(rows, membershipStatus, commit) {
    const existing = store.query('SELECT * FROM players');
    const plan = planImport(rows, existing, membershipStatus);

    let created = 0;
    let defaultedSkill = 0;
    if (commit) {
        for (const item of plan.toCreate) {
            const p = item.player;
            let skill = p.skill_level;
            if (!SKILL_LEVELS.includes(skill)) {
                skill = 'C'; // mid-grade default; flagged in the response so staff can review
                defaultedSkill++;
            }
            store.insert(
                `INSERT INTO players (first_name, last_name, email, phone, dob, skill_level, gender, membership_status, membership_number, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [p.first_name, p.last_name, p.email, p.phone, p.dob, skill, p.gender, p.membership_status, p.membership_number, p.notes]
            );
            created++;
        }
        store.persist();
        if (created > 0) broadcast('players', {});
    }

    return {
        committed: !!commit,
        created,
        defaulted_skill: defaultedSkill,
        to_create: plan.toCreate.map((i) => ({ row: i.rowIndex + 1, name: `${i.player.first_name} ${i.player.last_name}`, email: i.player.email })),
        to_skip: plan.toSkip.map((i) => ({ row: i.rowIndex + 1, name: `${i.row.first_name} ${i.row.last_name}`, reason: i.reason })),
        to_review: plan.toReview.map((i) => ({
            row: i.rowIndex + 1,
            name: `${i.row.first_name} ${i.row.last_name}`,
            email: i.row.email || null,
            dob: i.row.dob || null,
            reason: i.reason,
            candidates: i.candidates.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email, dob: c.dob })),
        })),
    };
}

// CSV import. See runImportPlan for the preview/commit contract.
router.post('/import', (req, res) => {
    const { csv_text, membership_status, commit } = req.body;
    if (!csv_text || typeof csv_text !== 'string') return res.status(400).json({ error: 'csv_text is required' });
    if (!MEMBERSHIP_STATUSES.includes(membership_status)) {
        return res.status(400).json({ error: `membership_status must be one of ${MEMBERSHIP_STATUSES.join(', ')}` });
    }

    let rows;
    try {
        rows = parseCsv(csv_text);
    } catch (err) {
        return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'CSV contains no data rows' });
    const missingName = rows.filter((r) => !(r.first_name || '').trim() || !(r.last_name || '').trim());
    if (missingName.length > 0) {
        return res.status(400).json({ error: `CSV must have first_name and last_name columns filled on every row (${missingName.length} row(s) missing them)` });
    }

    try {
        res.json(runImportPlan(rows, membership_status, commit));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Excel import for the club's membership export (Rego #, Full Name, Gender,
// Mbshp Type, Status columns). Body is the raw .xlsx file bytes;
// membership_status/commit travel as query params since there's no JSON body.
router.post('/import-xlsx', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
    const membership_status = req.query.membership_status;
    const commit = req.query.commit === 'true';
    if (!MEMBERSHIP_STATUSES.includes(membership_status)) {
        return res.status(400).json({ error: `membership_status must be one of ${MEMBERSHIP_STATUSES.join(', ')}` });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    let rows;
    try {
        rows = await parseGbcMembersXlsx(req.body);
    } catch (err) {
        return res.status(400).json({ error: `Could not parse Excel file: ${err.message}` });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'Excel file contains no data rows' });

    try {
        res.json(runImportPlan(rows, membership_status, commit));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    const player = store.queryOne('SELECT * FROM players WHERE id = ?', [req.params.id]);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
});

// What this player paid as (Member/Non-Member/Concession/etc.) last time
// they checked in anywhere - lets check-in default to it instead of
// forcing staff to re-pick the same category for the same regular every
// single night. is_system categories (the old Cash/Card/Voucher set) are
// excluded - they're not a "type of player" and shouldn't be suggested
// going forward. Whether the suggestion actually applies to tonight's
// session (is it even one of this session's configured rates) is the
// caller's job - a player's usual category might not exist on an ad-hoc
// one-off session's rate list, for instance.
router.get('/:id/last-payment-category', (req, res) => {
    const row = store.queryOne(
        `SELECT a.payment_category_id, pc.name
         FROM attendance a JOIN payment_categories pc ON pc.id = a.payment_category_id
         WHERE a.player_id = ? AND a.payment_category_id IS NOT NULL AND pc.is_system = 0
         ORDER BY a.id DESC LIMIT 1`,
        [req.params.id]
    );
    res.json(row || null);
});

// Leading/trailing spaces in a name sort it to the wrong place and make
// two entries for one person - never store them.
function trimNames(body) {
    for (const key of ['first_name', 'last_name']) {
        if (typeof body[key] === 'string') body[key] = body[key].trim();
    }
    return body;
}

router.post('/', (req, res) => {
    trimNames(req.body);
    const errors = validatePlayer(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const b = req.body;
    try {
        const id = store.insert(
            `INSERT INTO players (first_name, last_name, email, phone, dob, skill_level, gender, membership_status, membership_number, emergency_contact_name, emergency_contact_phone, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [b.first_name, b.last_name, b.email ?? null, b.phone ?? null, b.dob ?? null, b.skill_level,
                b.gender ?? null, b.membership_status ?? 'active', b.membership_number ?? null,
                b.emergency_contact_name ?? null, b.emergency_contact_phone ?? null, b.notes ?? null]
        );
        store.persist();
        broadcast('players', { player_id: id });
        res.status(201).json(store.queryOne('SELECT * FROM players WHERE id = ?', [id]));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM players WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Player not found' });
    trimNames(req.body);
    const errors = validatePlayer(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ errors });
    const merged = { ...existing, ...req.body };
    try {
        store.run(
            `UPDATE players SET first_name=?, last_name=?, email=?, phone=?, dob=?, skill_level=?, gender=?,
             membership_status=?, membership_number=?, emergency_contact_name=?, emergency_contact_phone=?, notes=?
             WHERE id=?`,
            [merged.first_name, merged.last_name, merged.email, merged.phone, merged.dob, merged.skill_level,
                merged.gender, merged.membership_status, merged.membership_number, merged.emergency_contact_name,
                merged.emergency_contact_phone, merged.notes, req.params.id]
        );
        store.persist();
        broadcast('players', { player_id: Number(req.params.id) });
        res.json(store.queryOne('SELECT * FROM players WHERE id = ?', [req.params.id]));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    const existing = store.queryOne('SELECT * FROM players WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Player not found' });
    const hasHistory = store.queryOne('SELECT id FROM attendance WHERE player_id = ? LIMIT 1', [req.params.id]);
    if (hasHistory) {
        return res.status(409).json({
            error: 'Player has attendance history and cannot be deleted. Set membership_status to lapsed instead.'
        });
    }
    store.run('DELETE FROM players WHERE id = ?', [req.params.id]);
    store.persist();
    broadcast('players', { player_id: Number(req.params.id) });
    res.status(204).end();
});

module.exports = router;
