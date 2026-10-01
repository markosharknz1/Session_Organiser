// Access PIN for other devices (Settings > Club details > Other computers).
//
// The main computer's own window talks to the server over 127.0.0.1 and is
// never asked for anything. Every OTHER device - a second check-in PC
// running the Companion, a TV, a phone on the club wifi - must enter the
// club's PIN once; it then stays signed in (a cookie) until the PIN is
// changed or "Sign out other devices" is used on the main computer.
//
// With "Allow other devices on this network" on but no PIN set, other
// devices are refused outright, so turning the network on can never leave
// the app open to the whole wifi by accident.
//
// Storage (club_settings): access_pin_hash = "<salt>:<scrypt hash>" of the
// PIN; access_secret = a random per-install key. A device's cookie is an
// HMAC of the PIN hash under that secret, so changing either signs every
// device out, and a server restart signs nobody out. Nothing sensitive is
// ever sent to a device.
const crypto = require('crypto');

const COOKIE_NAME = 'gs_access';
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const PIN_PATTERN = /^\d{4,8}$/;

function isLocalRequest(req) {
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
    if (!stored || !PIN_PATTERN.test(String(pin))) return false;
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(String(pin), salt, 32);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function deviceToken(secret, pinHash) {
    return crypto.createHmac('sha256', String(secret)).update(String(pinHash)).digest('hex');
}

function tokenMatches(presented, secret, pinHash) {
    if (!presented || !secret || !pinHash) return false;
    const expected = Buffer.from(deviceToken(secret, pinHash), 'utf8');
    const given = Buffer.from(String(presented), 'utf8');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        const name = part.slice(0, i).trim();
        if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function cookieHeader(token) {
    return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`;
}

function clearCookieHeader() {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

// Wrong-PIN throttle per device address: after 5 misses, a wait that
// doubles each time (30s, 60s, ...). A 4-digit PIN with no throttle is
// guessable in minutes from the car park; with this it isn't.
function createAttemptLimiter(now = () => Date.now()) {
    const byAddress = new Map();
    return {
        blockedFor(addr) {
            const e = byAddress.get(addr);
            if (!e || !e.until || e.until <= now()) return 0;
            return Math.ceil((e.until - now()) / 1000);
        },
        failed(addr) {
            const e = byAddress.get(addr) || { fails: 0, locks: 0, until: 0 };
            e.fails += 1;
            if (e.fails >= 5) {
                e.fails = 0;
                e.locks += 1;
                e.until = now() + 30000 * Math.pow(2, Math.min(e.locks - 1, 6));
            }
            byAddress.set(addr, e);
        },
        succeeded(addr) { byAddress.delete(addr); },
    };
}

// Paths another device may reach BEFORE it has signed in: the PIN page and
// what it needs, and the club icon (what the Companion pings to see whether
// the main computer is there - it reveals nothing).
const OPEN_PATHS = new Set(['/pin.html', '/api/access/login', '/api/access/info', '/api/branding/icon']);

// Express middleware. `settings()` returns the current
// { allow_network_access, access_pin_hash, access_secret } row.
function accessGuard(settings) {
    return function guard(req, res, next) {
        if (isLocalRequest(req)) return next();
        const path = req.path;
        if (OPEN_PATHS.has(path)) return next();

        const s = settings() || {};
        const wantsPage = req.method === 'GET' && !path.startsWith('/api/');
        const refuse = (status, reason, message) => {
            res.set('X-Game-Scheduler-Access', reason);
            if (wantsPage) return res.redirect(`/pin.html?reason=${reason}&next=${encodeURIComponent(req.originalUrl)}`);
            return res.status(status).json({ error: message, access: reason });
        };
        if (!s.allow_network_access) return refuse(403, 'off', 'Other devices are not allowed in - turn that on in Settings on the main computer.');
        if (!s.access_pin_hash) return refuse(403, 'no-pin', 'No access PIN has been set yet - set one on the main computer under Settings > Club details > Other computers.');
        const presented = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!tokenMatches(presented, s.access_secret, s.access_pin_hash)) return refuse(401, 'pin', 'Sign-in needed: reload this page and enter the club\'s access PIN.');
        return next();
    };
}

module.exports = {
    COOKIE_NAME, PIN_PATTERN, OPEN_PATHS,
    isLocalRequest, hashPin, verifyPin, deviceToken, tokenMatches, parseCookies, cookieHeader, clearCookieHeader,
    createAttemptLimiter, accessGuard,
};
