// Run with: node lib/launchLogs.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { tailOf, keepPrevious, prevName } = require('./launchLogs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-launchlogs-'));
const file = (name) => path.join(dir, name);
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`ok - ${name}`); } catch (err) { console.error(`FAILED - ${name}`); console.error(err); process.exitCode = 1; }
}

test('tailOf: a missing file is just empty', () => {
    assert.strictEqual(tailOf(file('nope.log')), '');
});

test('tailOf: the last lines only, blank lines dropped, CRLF handled', () => {
    fs.writeFileSync(file('a.log'), `${['one', '', 'two', 'three   ', '', 'four'].join('\r\n')}\r\n`);
    assert.strictEqual(tailOf(file('a.log'), { lines: 2 }), 'three\nfour');
    assert.strictEqual(tailOf(file('a.log')), 'one\ntwo\nthree\nfour');
});

test('tailOf: capped by characters from the end', () => {
    fs.writeFileSync(file('b.log'), `${'x'.repeat(50)}\nError: the real reason\n`);
    assert.strictEqual(tailOf(file('b.log'), { chars: 22 }), 'Error: the real reason');
});

test('keepPrevious: a log with something in it becomes .prev.log, replacing the older one', () => {
    fs.writeFileSync(file('server.err.log'), 'first failure\n');
    assert.strictEqual(keepPrevious(file('server.err.log')), file('server.err.prev.log'));
    assert.ok(!fs.existsSync(file('server.err.log')));
    assert.strictEqual(fs.readFileSync(file('server.err.prev.log'), 'utf8'), 'first failure\n');
    fs.writeFileSync(file('server.err.log'), 'second failure\n');
    keepPrevious(file('server.err.log'));
    assert.strictEqual(fs.readFileSync(file('server.err.prev.log'), 'utf8'), 'second failure\n');
});

test('keepPrevious: an empty or missing log never replaces a useful one', () => {
    fs.writeFileSync(file('server.err.log'), '');
    assert.strictEqual(keepPrevious(file('server.err.log')), null);
    assert.strictEqual(fs.readFileSync(file('server.err.prev.log'), 'utf8'), 'second failure\n');
    assert.strictEqual(keepPrevious(file('missing.log')), null);
});

test('prevName', () => {
    assert.strictEqual(prevName(path.join('x', 'server.out.log')), path.join('x', 'server.out.prev.log'));
    assert.strictEqual(prevName(path.join('x', 'thing')), path.join('x', 'thing.prev'));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} launchLogs tests passed`);
