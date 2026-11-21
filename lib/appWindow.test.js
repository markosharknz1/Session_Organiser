// Run with: node lib/appWindow.test.js
//
// whenAppClosed() decides when the launcher stops the server, so getting it
// wrong either kills the app under the user (v1.0.21 and earlier did, once
// Edge started handing its window to a second process) or leaves the server
// running for ever. Driven here with a fake process, a fake lockfile and a
// fake clock.
const assert = require('assert');
const { EventEmitter } = require('events');
const { whenAppClosed } = require('./appWindow');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// A world where each sleep() moves the clock on and runs whatever was
// scheduled for that moment.
function world() {
    let t = 0;
    const events = [];
    const child = new EventEmitter();
    child.exitCode = null;
    let lock = false;
    return {
        child,
        at(ms, fn) { events.push([ms, fn]); },
        exit() { child.exitCode = 0; child.emit('exit', 0); },
        setLock(v) { lock = v; },
        options: {
            lockExists: () => lock,
            now: () => t,
            pollMs: 100,
            sleep: async (ms) => {
                t += ms;
                for (const e of events.filter((x) => x[0] <= t && !x.done)) { e.done = true; e[1](); }
            },
        },
        time: () => t,
    };
}

test('an ordinary browser: the process stays for the life of the window', async () => {
    const w = world();
    w.at(500, () => w.setLock(true));
    w.at(60000, () => { w.setLock(false); w.exit(); });
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() >= 60000 && w.time() <= 60200, `stopped at ${w.time()}`);
});

test('Edge hands the window to a second process: the first one exiting is NOT the window closing', async () => {
    const w = world();
    w.at(100, () => w.exit()); // gone almost at once
    w.at(1500, () => w.setLock(true)); // the real browser takes the profile
    w.at(3600000, () => w.setLock(false)); // an hour's club night later
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() >= 3600000 && w.time() <= 3600200, `stopped at ${w.time()}`);
});

test('the hand-over is given time on a cold computer (the real browser is slow to appear)', async () => {
    const w = world();
    w.at(100, () => w.exit());
    w.at(40000, () => w.setLock(true)); // 40 seconds before the browser is up
    w.at(50000, () => w.setLock(false));
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() >= 50000, `stopped at ${w.time()}`);
});

test('a hand-over that comes to nothing is given up on after the grace period', async () => {
    const w = world();
    w.at(100, () => w.exit());
    assert.strictEqual(await whenAppClosed(w.child, { ...w.options, handoverGraceMs: 90000 }), 'never-opened');
    assert.ok(w.time() >= 90000 && w.time() <= 90400, `gave up at ${w.time()}`);
});

test('a browser that keeps no lockfile: its exit is believed once it has run a while', async () => {
    const w = world();
    w.at(30000, () => w.exit());
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() <= 30200, `stopped at ${w.time()}`);
});

test('a second window in the same browser keeps the app open after the first closes', async () => {
    const w = world();
    w.at(200, () => w.setLock(true));
    w.at(1000, () => w.exit()); // the spawned process goes; the lock stays (Display window still open)
    w.at(20000, () => w.setLock(false));
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() >= 20000, `stopped at ${w.time()}`);
});

test('a process that had already exited when watching began', async () => {
    const w = world();
    w.child.exitCode = 0;
    w.setLock(true);
    w.at(5000, () => w.setLock(false));
    assert.strictEqual(await whenAppClosed(w.child, w.options), 'closed');
    assert.ok(w.time() >= 5000, `stopped at ${w.time()}`);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log(`ok - ${name}`); } catch (err) { console.error(`FAILED - ${name}`); console.error(err); process.exitCode = 1; }
    }
    console.log(`\n${passed} appWindow tests passed`);
})();
