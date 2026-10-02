// /api/access - the access PINs for other devices (see lib/access.js).
//   GET  /info    club name, whether PINs are set, and this device's role
//   POST /login   { pin } from another device -> sets the sign-in cookie
//   POST /logout  clears this device's cookie
//   POST /pin     { pin, role } set, change or (desk only, pin "") remove a PIN - main computer only
//   POST /revoke  sign every other device out                                 - main computer only
const crypto = require('crypto');
const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const access = require('../lib/access');

const router = express.Router();
const attempts = access.createAttemptLimiter();

function settings() {
    return store.queryOne('SELECT club_name, allow_network_access, access_pin_hash, desk_pin_hash, access_secret FROM club_settings WHERE id = 1');
}

function ensureSecret(s) {
    if (s.access_secret) return s.access_secret;
    const secret = crypto.randomBytes(32).toString('hex');
    store.run('UPDATE club_settings SET access_secret = ? WHERE id = 1', [secret]);
    store.persist();
    return secret;
}

function localOnly(req, res, next) {
    if (!access.isLocalRequest(req)) return res.status(403).json({ error: 'The access PINs can only be managed on the main computer.' });
    return next();
}

router.get('/info', (req, res) => {
    const s = settings() || {};
    res.json({
        club_name: s.club_name || 'Game Scheduler',
        pin_set: !!(s.access_pin_hash || s.desk_pin_hash),
        network_allowed: !!s.allow_network_access,
        role: access.roleFor(req, s), // 'admin' | 'desk' | null (not signed in)
        main_computer: access.isLocalRequest(req),
    });
});

router.post('/login', (req, res) => {
    const s = settings() || {};
    const addr = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!s.allow_network_access && !access.isLocalRequest(req)) return res.status(403).json({ error: 'Other devices are not allowed in.' });
    if (!s.access_pin_hash && !s.desk_pin_hash) return res.status(403).json({ error: 'No access PIN has been set on the main computer yet.' });
    const wait = attempts.blockedFor(addr);
    if (wait > 0) return res.status(429).json({ error: `Too many wrong PINs - try again in ${wait} seconds.`, retry_in: wait });
    const pin = String((req.body && req.body.pin) || '').trim();
    let role = null;
    if (access.verifyPin(pin, s.access_pin_hash)) role = 'admin';
    else if (access.verifyPin(pin, s.desk_pin_hash)) role = 'desk';
    if (!role) {
        attempts.failed(addr);
        const nowWait = attempts.blockedFor(addr);
        return res.status(401).json({ error: nowWait > 0 ? `Wrong PIN. Too many tries - wait ${nowWait} seconds.` : 'Wrong PIN.' });
    }
    attempts.succeeded(addr);
    const hash = role === 'admin' ? s.access_pin_hash : s.desk_pin_hash;
    res.set('Set-Cookie', access.cookieHeader(access.deviceToken(ensureSecret(s), hash, role)));
    res.json({ ok: true, role });
});

router.post('/logout', (req, res) => {
    res.set('Set-Cookie', access.clearCookieHeader());
    res.json({ ok: true });
});

// role 'admin' (default) = the full access PIN; 'desk' = the check-in PIN.
// The two must differ - the PIN typed is what decides what a device may do.
router.post('/pin', localOnly, (req, res) => {
    const role = req.body && req.body.role === 'desk' ? 'desk' : 'admin';
    const pin = String((req.body && req.body.pin) || '').trim();
    const s = settings() || {};
    const column = role === 'desk' ? 'desk_pin_hash' : 'access_pin_hash';
    const other = role === 'desk' ? s.access_pin_hash : s.desk_pin_hash;
    if (pin === '' && role === 'desk') {
        store.run('UPDATE club_settings SET desk_pin_hash = NULL WHERE id = 1');
        store.persist();
        broadcast('club_settings', {});
        return res.json({ ok: true, role, pin_set: false });
    }
    if (!access.PIN_PATTERN.test(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' });
    if (access.verifyPin(pin, other)) return res.status(400).json({ error: 'The two PINs must be different - the PIN a device enters is what decides what it can do.' });
    ensureSecret(s);
    store.run(`UPDATE club_settings SET ${column} = ? WHERE id = 1`, [access.hashPin(pin)]);
    store.persist();
    broadcast('club_settings', {});
    return res.json({ ok: true, role, pin_set: true });
});

// A new secret invalidates every device's cookie; the PINs themselves stay.
router.post('/revoke', localOnly, (req, res) => {
    store.run('UPDATE club_settings SET access_secret = ? WHERE id = 1', [crypto.randomBytes(32).toString('hex')]);
    store.persist();
    res.json({ ok: true });
});

module.exports = router;
