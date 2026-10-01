// /api/access - the access PIN for other devices (see lib/access.js).
//   GET  /info    club name + whether a PIN is set (open: the PIN page shows it)
//   POST /login   { pin } from another device -> sets the sign-in cookie
//   POST /logout  clears this device's cookie
//   POST /pin     { pin } set or change the PIN  - main computer only
//   POST /revoke  sign every other device out    - main computer only
const crypto = require('crypto');
const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const access = require('../lib/access');

const router = express.Router();
const attempts = access.createAttemptLimiter();

function settings() {
    return store.queryOne('SELECT club_name, allow_network_access, access_pin_hash, access_secret FROM club_settings WHERE id = 1');
}

function ensureSecret(s) {
    if (s.access_secret) return s.access_secret;
    const secret = crypto.randomBytes(32).toString('hex');
    store.run('UPDATE club_settings SET access_secret = ? WHERE id = 1', [secret]);
    store.persist();
    return secret;
}

function localOnly(req, res, next) {
    if (!access.isLocalRequest(req)) return res.status(403).json({ error: 'The access PIN can only be managed on the main computer.' });
    return next();
}

router.get('/info', (req, res) => {
    const s = settings() || {};
    res.json({ club_name: s.club_name || 'Game Scheduler', pin_set: !!s.access_pin_hash, network_allowed: !!s.allow_network_access });
});

router.post('/login', (req, res) => {
    const s = settings() || {};
    const addr = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!s.allow_network_access && !access.isLocalRequest(req)) return res.status(403).json({ error: 'Other devices are not allowed in.' });
    if (!s.access_pin_hash) return res.status(403).json({ error: 'No access PIN has been set on the main computer yet.' });
    const wait = attempts.blockedFor(addr);
    if (wait > 0) return res.status(429).json({ error: `Too many wrong PINs - try again in ${wait} seconds.`, retry_in: wait });
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!access.verifyPin(pin, s.access_pin_hash)) {
        attempts.failed(addr);
        const nowWait = attempts.blockedFor(addr);
        return res.status(401).json({ error: nowWait > 0 ? `Wrong PIN. Too many tries - wait ${nowWait} seconds.` : 'Wrong PIN.' });
    }
    attempts.succeeded(addr);
    res.set('Set-Cookie', access.cookieHeader(access.deviceToken(ensureSecret(s), s.access_pin_hash)));
    res.json({ ok: true });
});

router.post('/logout', (req, res) => {
    res.set('Set-Cookie', access.clearCookieHeader());
    res.json({ ok: true });
});

router.post('/pin', localOnly, (req, res) => {
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!access.PIN_PATTERN.test(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' });
    const s = settings() || {};
    ensureSecret(s);
    store.run('UPDATE club_settings SET access_pin_hash = ? WHERE id = 1', [access.hashPin(pin)]);
    store.persist();
    broadcast('club_settings', {});
    res.json({ ok: true, pin_set: true });
});

// A new secret invalidates every device's cookie; the PIN itself stays.
router.post('/revoke', localOnly, (req, res) => {
    store.run('UPDATE club_settings SET access_secret = ? WHERE id = 1', [crypto.randomBytes(32).toString('hex')]);
    store.persist();
    res.json({ ok: true });
});

module.exports = router;
