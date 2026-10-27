const express = require('express');
const lifecycle = require('../lib/roundLifecycle');
const store = require('../db/store');
const { generateRound } = require('../lib/autoGenerate');

const router = express.Router();

function handle(fn) {
    return (req, res) => {
        try {
            const result = fn(Number(req.params.id));
            res.json(result);
        } catch (err) {
            const status = err instanceof lifecycle.LifecycleError ? err.status : 400;
            res.status(status).json({ error: err.message });
        }
    };
}

router.get('/sessions/:id/rounds/status', handle(lifecycle.roundStatus));
router.post('/sessions/:id/rounds/start-next', handle(lifecycle.startNextRound));
router.post('/sessions/:id/rounds/end-game', handle(lifecycle.endGamePhase));
router.post('/sessions/:id/rounds/end-break', handle(lifecycle.endBreakPhase));
router.post('/sessions/:id/rounds/pause', handle(lifecycle.pauseCurrentPhase));
router.post('/sessions/:id/rounds/resume', handle(lifecycle.resumeCurrentPhase));

// Dry run: shows what auto-generate would produce for a round without
// writing anything. Useful for testing/debugging and for staff curiosity in
// auto mode ("what would happen next").
router.get('/sessions/:id/auto-generate/preview', (req, res) => {
    const sessionId = Number(req.params.id);
    const roundNumber = req.query.round_number ? Number(req.query.round_number) : lifecycle.getNextRoundNumber(sessionId);
    const seed = req.query.seed !== undefined && req.query.seed !== '' ? Number(req.query.seed) : undefined;
    try {
        const plan = generateRound(store.getDb(), sessionId, roundNumber, Number.isInteger(seed) ? { seed } : {});
        res.json({ round_number: roundNumber, games: plan });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
