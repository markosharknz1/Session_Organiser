// Access PINs for other devices (Settings > Club details > Other computers).
//
// The main computer's own window talks to the server over 127.0.0.1 and is
// never asked for anything. Every OTHER device - a second check-in PC
// running the Companion, a TV, a phone on the club wifi - must enter a PIN
// once; it then stays signed in (a cookie) until that PIN is changed or
// "Sign out other devices" is used on the main computer.
//
// There are two PINs, and which one a device used decides what it may do:
//
//   Full access PIN   everything the main computer can do, except managing
//                     the PINs themselves.
//   Check-in PIN      the check-in desk only: start the day's session (pick
//                     the session template or a one-off), check players in,
//                     book, take payments, mark people as leaving, session
//                     notes, and the External Display. No Settings, no
//                     player database, no history, no rounds, no finishing
//                     the session - and none of the club's email passwords.
//
// With "Allow other devices on this network" on but no PIN set, other
// devices are refused outright, so turning the network on can never leave
// the app open to the whole wifi by accident.
//
// Storage (club_settings): access_pin_hash / desk_pin_hash = "<salt>:<scrypt
// hash>"; access_secret = a random per-install key. A device's cookie is an
// HMAC under that secret of the hash of the PIN it used, so changing a PIN
// signs out the devices that used it, a new secret signs out everyone, and
// a server restart signs nobody out. Nothing sensitive is sent to a device.
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

// role: 'admin' (the full access PIN) or 'desk' (the check-in PIN)
function deviceToken(secret, pinHash, role = 'admin') {
    return crypto.createHmac('sha256', String(secret)).update(`${role === 'desk' ? 'desk:' : ''}${pinHash}`).digest('hex');
}

function tokenMatches(presented, secret, pinHash, role = 'admin') {
    if (!presented || !secret || !pinHash) return false;
    const expected = Buffer.from(deviceToken(secret, pinHash, role), 'utf8');
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

// Who is asking: 'admin' (this computer, or a device signed in with the full
// PIN), 'desk' (signed in with the check-in PIN), or null (not signed in).
function roleFor(req, s) {
    if (isLocalRequest(req)) return 'admin';
    const settings = s || {};
    const presented = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
    if (tokenMatches(presented, settings.access_secret, settings.access_pin_hash, 'admin')) return 'admin';
    if (tokenMatches(presented, settings.access_secret, settings.desk_pin_hash, 'desk')) return 'desk';
    return null;
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
const OPEN_PATHS = new Set(['/pin.html', '/api/access/login', '/api/access/info', '/api/access/logout', '/api/branding/icon']);

// What a device signed in with the CHECK-IN PIN may call. Everything the
// Check-in page and the External Display need, and nothing else. Anything
// not listed is refused - a new route is closed to the desk until it is
// added here on purpose.
const DESK_PAGES = new Set(['/', '/checkin.html', '/display.html']);
const DESK_API = [
    ['GET', /^\/api\/health$/],
    ['GET', /^\/api\/events$/],
    ['GET', /^\/api\/club-settings$/],          // served without the email/payment secrets - see routes/clubSettings.js
    ['GET', /^\/api\/courts$/],
    ['GET', /^\/api\/launcher$/],
    ['GET', /^\/api\/branding\/(icon|horn)$/],
    ['GET', /^\/api\/players$/],
    ['POST', /^\/api\/players$/],                // quick-add a new player at the desk
    ['PUT', /^\/api\/players\/\d+$/],            // fix a grade/gender/name from the check-in box
    ['GET', /^\/api\/players\/\d+\/last-payment-category$/],
    ['GET', /^\/api\/session-templates(\/for-date)?$/],
    ['GET', /^\/api\/sessions\/(open|latest)$/],
    ['POST', /^\/api\/sessions\/start$/],        // start the day's session from a template...
    ['POST', /^\/api\/sessions$/],               // ...or a one-off
    ['GET', /^\/api\/sessions\/\d+$/],
    ['GET', /^\/api\/sessions\/\d+\/(courts|payment-rates|payment-summary|attendance|display)$/],
    ['POST', /^\/api\/sessions\/\d+\/attendance$/],
    ['PUT', /^\/api\/attendance\/\d+$/],
];
// The one session field the desk may change: its notes. Not the mode, and
// not its status (finishing the session is for the main computer).
const DESK_SESSION_FIELDS = new Set(['notes']);

function deskAllows(req) {
    const path = req.path;
    if (!path.startsWith('/api/')) {
        // pages: only its own. Everything else that isn't a page (scripts,
        // styles, icons, the manifest, the service worker) is fine.
        return req.method === 'GET' && (!path.endsWith('.html') || DESK_PAGES.has(path));
    }
    if (req.method === 'PUT' && /^\/api\/sessions\/\d+$/.test(path)) {
        const keys = Object.keys(req.body || {});
        return keys.length > 0 && keys.every((k) => DESK_SESSION_FIELDS.has(k));
    }
    return DESK_API.some(([method, pattern]) => method === req.method && pattern.test(path));
}

// Express middleware. `settings()` returns the current
// { allow_network_access, access_pin_hash, desk_pin_hash, access_secret } row.
// Sets req.accessRole ('admin' | 'desk') for the routes behind it.
function accessGuard(settings) {
    return function guard(req, res, next) {
        if (isLocalRequest(req)) { req.accessRole = 'admin'; return next(); }
        const path = req.path;
        const s = settings() || {};
        const role = roleFor(req, s);
        if (OPEN_PATHS.has(path)) { req.accessRole = role; return next(); }

        const wantsPage = req.method === 'GET' && !path.startsWith('/api/');
        const refuse = (status, reason, message) => {
            res.set('X-Game-Scheduler-Access', reason);
            if (wantsPage) return res.redirect(`/pin.html?reason=${reason}&next=${encodeURIComponent(req.originalUrl)}`);
            return res.status(status).json({ error: message, access: reason });
        };
        if (!s.allow_network_access) return refuse(403, 'off', 'Other devices are not allowed in - turn that on in Settings on the main computer.');
        if (!s.access_pin_hash && !s.desk_pin_hash) return refuse(403, 'no-pin', 'No access PIN has been set yet - set one on the main computer under Settings > Club details > Other computers.');
        if (!role) return refuse(401, 'pin', 'Sign-in needed: reload this page and enter the club\'s access PIN.');

        req.accessRole = role;
        if (role === 'desk' && !deskAllows(req)) {
            res.set('X-Game-Scheduler-Access', 'desk');
            if (wantsPage) return res.redirect('/checkin.html');
            return res.status(403).json({ error: 'This device is signed in for check-in only.', access: 'desk' });
        }
        return next();
    };
}

module.exports = {
    COOKIE_NAME, PIN_PATTERN, OPEN_PATHS, DESK_API,
    isLocalRequest, hashPin, verifyPin, deviceToken, tokenMatches, parseCookies, cookieHeader, clearCookieHeader,
    roleFor, deskAllows, createAttemptLimiter, accessGuard,
};
