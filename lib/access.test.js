// Access PIN: hashing, device tokens, cookie parsing, the wrong-PIN
// throttle, and the request guard's decisions. Run: node lib/access.test.js
const assert = require('assert');
const access = require('./access');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('a PIN verifies against its hash and nothing else does', () => {
    const stored = access.hashPin('2468');
    assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
    assert.strictEqual(access.verifyPin('2468', stored), true);
    assert.strictEqual(access.verifyPin('2469', stored), false);
    assert.strictEqual(access.verifyPin('', stored), false);
    assert.strictEqual(access.verifyPin('2468', null), false);
    assert.strictEqual(access.verifyPin('abcd', access.hashPin('abcd')), false, 'only digits are PINs');
    assert.notStrictEqual(access.hashPin('2468'), stored, 'a fresh salt each time');
});

test('device token depends on both the secret and the PIN hash', () => {
    const t = access.deviceToken('secret-a', 'hash-1');
    assert.strictEqual(access.tokenMatches(t, 'secret-a', 'hash-1'), true);
    assert.strictEqual(access.tokenMatches(t, 'secret-b', 'hash-1'), false, 'sign out other devices = new secret');
    assert.strictEqual(access.tokenMatches(t, 'secret-a', 'hash-2'), false, 'changed PIN = new hash');
    assert.strictEqual(access.tokenMatches('', 'secret-a', 'hash-1'), false);
    assert.strictEqual(access.tokenMatches(t, '', 'hash-1'), false);
});

test('cookies parse and the Set-Cookie headers are well formed', () => {
    assert.deepStrictEqual(access.parseCookies('a=1; gs_access=abc%3D; b = 2'), { a: '1', gs_access: 'abc=', b: '2' });
    assert.deepStrictEqual(access.parseCookies(undefined), {});
    assert.match(access.cookieHeader('tok'), /^gs_access=tok; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    assert.match(access.clearCookieHeader(), /Max-Age=0/);
});

test('five wrong PINs lock a device out for 30s, then longer each time', () => {
    let t = 1000000;
    const lim = access.createAttemptLimiter(() => t);
    for (let i = 0; i < 4; i++) lim.failed('10.0.0.5');
    assert.strictEqual(lim.blockedFor('10.0.0.5'), 0, 'four misses: still allowed');
    lim.failed('10.0.0.5');
    assert.strictEqual(lim.blockedFor('10.0.0.5'), 30);
    assert.strictEqual(lim.blockedFor('10.0.0.6'), 0, 'other devices unaffected');
    t += 31000;
    assert.strictEqual(lim.blockedFor('10.0.0.5'), 0);
    for (let i = 0; i < 5; i++) lim.failed('10.0.0.5');
    assert.strictEqual(lim.blockedFor('10.0.0.5'), 60, 'second lock-out doubles');
    lim.succeeded('10.0.0.5');
    assert.strictEqual(lim.blockedFor('10.0.0.5'), 0);
});

function run(guard, { addr, path, method = 'GET', cookie = '' }) {
    const out = { status: 200, redirected: null, json: null, headers: {}, nexted: false };
    const req = { socket: { remoteAddress: addr }, path, originalUrl: path, method, headers: { cookie } };
    const res = {
        set: (k, v) => { out.headers[k] = v; return res; },
        status: (s) => { out.status = s; return res; },
        json: (b) => { out.json = b; return res; },
        redirect: (u) => { out.redirected = u; return res; },
    };
    guard(req, res, () => { out.nexted = true; });
    return out;
}

test('the guard: main computer always through; others need network on, a PIN set, and a valid cookie', () => {
    const settings = { allow_network_access: 1, access_pin_hash: access.hashPin('1234'), access_secret: 'sec' };
    const guard = access.accessGuard(() => settings);
    const good = `gs_access=${access.deviceToken('sec', settings.access_pin_hash)}`;

    assert.strictEqual(run(guard, { addr: '127.0.0.1', path: '/api/club-settings' }).nexted, true);
    assert.strictEqual(run(guard, { addr: '::1', path: '/club.html' }).nexted, true);
    assert.strictEqual(run(guard, { addr: '::ffff:127.0.0.1', path: '/api/access/pin', method: 'POST' }).nexted, true);

    assert.strictEqual(run(guard, { addr: '10.0.0.5', path: '/checkin.html', cookie: good }).nexted, true, 'signed-in device');
    assert.strictEqual(run(guard, { addr: '10.0.0.5', path: '/api/sessions/open', cookie: good }).nexted, true);

    const page = run(guard, { addr: '10.0.0.5', path: '/checkin.html' });
    assert.strictEqual(page.nexted, false);
    assert.strictEqual(page.redirected, '/pin.html?reason=pin&next=%2Fcheckin.html', 'a page request goes to the PIN page');
    const api = run(guard, { addr: '10.0.0.5', path: '/api/sessions/open', cookie: 'gs_access=wrong' });
    assert.strictEqual(api.status, 401);
    assert.strictEqual(api.json.access, 'pin');

    for (const open of ['/pin.html', '/api/access/login', '/api/access/info', '/api/branding/icon']) {
        assert.strictEqual(run(guard, { addr: '10.0.0.5', path: open }).nexted, true, `${open} is reachable before sign-in`);
    }
    assert.strictEqual(run(guard, { addr: '10.0.0.5', path: '/api/access/pin', method: 'POST' }).nexted, false, 'PIN management is not an open path');
});

test('the guard: no PIN set, or network off, refuses other devices outright', () => {
    const noPin = access.accessGuard(() => ({ allow_network_access: 1, access_pin_hash: null, access_secret: 'sec' }));
    const r1 = run(noPin, { addr: '10.0.0.5', path: '/display.html' });
    assert.strictEqual(r1.redirected, '/pin.html?reason=no-pin&next=%2Fdisplay.html');
    assert.strictEqual(run(noPin, { addr: '10.0.0.5', path: '/api/sessions/open' }).status, 403);

    const off = access.accessGuard(() => ({ allow_network_access: 0, access_pin_hash: access.hashPin('1234'), access_secret: 'sec' }));
    assert.strictEqual(run(off, { addr: '10.0.0.5', path: '/api/sessions/open' }).status, 403);
    assert.strictEqual(run(off, { addr: '127.0.0.1', path: '/api/sessions/open' }).nexted, true);
});

test('two PINs, two roles: the cookie says which PIN a device used', () => {
    const settings = { allow_network_access: 1, access_pin_hash: access.hashPin('1234'), desk_pin_hash: access.hashPin('5678'), access_secret: 'sec' };
    const adminCookie = `gs_access=${access.deviceToken('sec', settings.access_pin_hash, 'admin')}`;
    const deskCookie = `gs_access=${access.deviceToken('sec', settings.desk_pin_hash, 'desk')}`;
    const req = (addr, cookie) => ({ socket: { remoteAddress: addr }, headers: { cookie } });
    assert.strictEqual(access.roleFor(req('127.0.0.1', ''), settings), 'admin', 'the main computer is always admin');
    assert.strictEqual(access.roleFor(req('10.0.0.5', adminCookie), settings), 'admin');
    assert.strictEqual(access.roleFor(req('10.0.0.5', deskCookie), settings), 'desk');
    assert.strictEqual(access.roleFor(req('10.0.0.5', 'gs_access=nope'), settings), null);
    // a desk token can't be passed off as admin even if both PINs hashed the same
    assert.strictEqual(access.tokenMatches(access.deviceToken('sec', 'h', 'desk'), 'sec', 'h', 'admin'), false);
    // changing the desk PIN signs out desk devices only
    const changed = { ...settings, desk_pin_hash: access.hashPin('9999') };
    assert.strictEqual(access.roleFor(req('10.0.0.5', deskCookie), changed), null);
    assert.strictEqual(access.roleFor(req('10.0.0.5', adminCookie), changed), 'admin');
});

test('the check-in role: the desk pages and what they need, nothing else', () => {
    const settings = { allow_network_access: 1, access_pin_hash: access.hashPin('1234'), desk_pin_hash: access.hashPin('5678'), access_secret: 'sec' };
    const guard = access.accessGuard(() => settings);
    const cookie = `gs_access=${access.deviceToken('sec', settings.desk_pin_hash, 'desk')}`;
    const go = (method, path, body) => {
        const out = { status: 200, redirected: null, json: null, nexted: false, role: null };
        const req = { socket: { remoteAddress: '10.0.0.5' }, path, originalUrl: path, method, headers: { cookie }, body };
        const res = { set: () => res, status: (s) => { out.status = s; return res; }, json: (b) => { out.json = b; return res; }, redirect: (u) => { out.redirected = u; return res; } };
        guard(req, res, () => { out.nexted = true; out.role = req.accessRole; });
        return out;
    };
    const allowed = [
        ['GET', '/checkin.html'], ['GET', '/display.html'], ['GET', '/style.css'], ['GET', '/checkin.js'], ['GET', '/sw.js'], ['GET', '/icons/icon-192.png'],
        ['GET', '/api/club-settings'], ['GET', '/api/events'], ['GET', '/api/players'], ['POST', '/api/players'], ['PUT', '/api/players/12'],
        ['GET', '/api/players/12/last-payment-category'], ['GET', '/api/session-templates/for-date'], ['GET', '/api/session-templates'],
        ['GET', '/api/sessions/open'], ['GET', '/api/sessions/latest'], ['POST', '/api/sessions/start'], ['POST', '/api/sessions'],
        ['GET', '/api/sessions/7'], ['GET', '/api/sessions/7/attendance'], ['POST', '/api/sessions/7/attendance'], ['GET', '/api/sessions/7/payment-rates'],
        ['GET', '/api/sessions/7/payment-summary'], ['GET', '/api/sessions/7/display'], ['GET', '/api/sessions/7/courts'], ['PUT', '/api/attendance/31'],
        ['GET', '/api/courts'], ['GET', '/api/branding/horn'], ['GET', '/api/launcher'],
    ];
    for (const [m, p] of allowed) {
        const r = go(m, p);
        assert.ok(r.nexted, `${m} ${p} should be allowed for the desk`);
        assert.strictEqual(r.role, 'desk');
    }
    const refused = [
        ['PUT', '/api/club-settings'], ['POST', '/api/club-settings/send-test-email'], ['DELETE', '/api/players/12'], ['POST', '/api/players/import'],
        ['GET', '/api/history/sessions'], ['GET', '/api/export/sessions.xlsx'], ['GET', '/api/backup/download'], ['POST', '/api/backup/restore'],
        ['GET', '/api/tally/session/7'], ['POST', '/api/tally/session/7/email'], ['POST', '/api/sessions/7/send-summary-email'],
        ['POST', '/api/sessions/7/rounds/start-next'], ['GET', '/api/sessions/7/games'], ['POST', '/api/sessions/7/games'],
        ['PUT', '/api/session-templates/2'], ['POST', '/api/courts'], ['PUT', '/api/sessions/7/payment-rates'],
        ['POST', '/api/access/pin'], ['POST', '/api/access/revoke'], ['POST', '/api/branding/horn'], ['GET', '/api/about/network'],
    ];
    for (const [m, p] of refused) {
        const r = go(m, p);
        assert.ok(!r.nexted, `${m} ${p} must be refused for the desk`);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.access, 'desk');
    }
    for (const page of ['/club.html', '/members.html', '/history.html', '/manage.html']) {
        assert.strictEqual(go('GET', page).redirected, '/checkin.html', `${page} sends a desk device back to Check-in`);
    }
    // session notes yes; finishing the session or changing its mode, no
    assert.ok(go('PUT', '/api/sessions/7', { notes: 'sold 2 shirts' }).nexted);
    assert.ok(!go('PUT', '/api/sessions/7', { status: 'closed' }).nexted);
    assert.ok(!go('PUT', '/api/sessions/7', { notes: 'x', mode: 'auto' }).nexted);
    assert.ok(!go('PUT', '/api/sessions/7', {}).nexted);
});

test('a desk PIN alone is enough to let devices in; admin devices are unrestricted', () => {
    const deskOnly = { allow_network_access: 1, access_pin_hash: null, desk_pin_hash: access.hashPin('5678'), access_secret: 'sec' };
    const guard = access.accessGuard(() => deskOnly);
    assert.strictEqual(run(guard, { addr: '10.0.0.5', path: '/checkin.html' }).redirected, '/pin.html?reason=pin&next=%2Fcheckin.html');
    const both = { allow_network_access: 1, access_pin_hash: access.hashPin('1234'), desk_pin_hash: access.hashPin('5678'), access_secret: 'sec' };
    const g2 = access.accessGuard(() => both);
    const admin = `gs_access=${access.deviceToken('sec', both.access_pin_hash, 'admin')}`;
    assert.strictEqual(run(g2, { addr: '10.0.0.5', path: '/club.html', cookie: admin }).nexted, true);
    assert.strictEqual(run(g2, { addr: '10.0.0.5', path: '/api/backup/download', cookie: admin }).nexted, true);
});

console.log(`\n${passed} access tests passed`);
