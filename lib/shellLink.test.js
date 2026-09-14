// Byte-level tests for lib/shellLink.js. The real proof is Windows itself
// launching a shortcut this writes (done live before each release); these
// check the layout against MS-SHLLINK so a regression is caught on any OS.
const assert = require('assert');
const { buildShellLink, readShellLink, FLAGS, HEADER_SIZE } = require('./shellLink');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('header: size, CLSID, flags, show command', () => {
    const buf = buildShellLink({ target: 'C:\\Windows\\System32\\conhost.exe', args: '--headless x', workingDir: 'C:\\Apps', icon: 'C:\\Apps\\app.ico', description: 'Game Scheduler' });
    assert.strictEqual(buf.readUInt32LE(0), HEADER_SIZE);
    assert.strictEqual(buf.subarray(4, 20).toString('hex'), '0114020000000000c000000000000046');
    const flags = buf.readUInt32LE(20);
    assert.strictEqual(flags, FLAGS.HasLinkTargetIDList | FLAGS.HasLinkInfo | FLAGS.IsUnicode | FLAGS.HasName | FLAGS.HasWorkingDir | FLAGS.HasArguments | FLAGS.HasIconLocation);
    assert.strictEqual(buf.readUInt32LE(60), 1, 'SW_SHOWNORMAL');
    assert.strictEqual(buf.readUInt16LE(64), 0, 'no hotkey');
});

test('item ID list: My Computer, drive, one item per folder, then the file', () => {
    const buf = buildShellLink({ target: 'C:\\Windows\\System32\\conhost.exe' });
    const size = buf.readUInt16LE(HEADER_SIZE);
    const items = readShellLink(buf).idListItems;
    assert.deepStrictEqual(items.map((i) => [i.type, i.name]), [[0x1f, null], [0x2f, 'C:\\'], [0x31, 'Windows'], [0x31, 'System32'], [0x32, 'conhost.exe']]);
    // last two bytes of the list are the terminator
    assert.strictEqual(buf.readUInt16LE(HEADER_SIZE + 2 + size - 2), 0);
    // a file-entry item: name at 14, then a version-9 0xBEEF0004 block whose
    // last field points back at the block's own offset within the item
    const p = HEADER_SIZE + 2 + 20 + 25; // after root + drive items
    const cb = buf.readUInt16LE(p);
    assert.strictEqual(buf[p + 2], 0x31);
    assert.strictEqual(buf.readUInt16LE(p + 12), 0x10, 'directory attribute');
    assert.strictEqual(buf.subarray(p + 14, p + 21).toString('latin1'), 'Windows');
    const ext = p + 22;
    assert.strictEqual(buf.readUInt16LE(ext + 2), 9);
    assert.strictEqual(buf.readUInt32LE(ext + 4), 0xbeef0004);
    assert.strictEqual(buf.subarray(ext + 46, ext + 46 + 14).toString('utf16le'), 'Windows');
    assert.strictEqual(buf.readUInt16LE(p + cb - 2), 22, 'version offset = extension block start');
    assert.strictEqual(buf.readUInt16LE(ext), cb - 22, 'extension size fills the item');
    assert.throws(() => buildShellLink({ target: 'conhost.exe' }), /full local path/);
    assert.throws(() => buildShellLink({ target: '\\\\server\\share\\x.exe' }), /full local path/);
});

test('LinkInfo: offsets land on the ANSI target path and the suffix', () => {
    const target = 'C:\\Apps\\Game_Scheduler\\node\\node.exe';
    const buf = buildShellLink({ target });
    const li = HEADER_SIZE + 2 + buf.readUInt16LE(HEADER_SIZE);
    const size = buf.readUInt32LE(li);
    assert.strictEqual(buf.readUInt32LE(li + 4), 0x1c, 'LinkInfoHeaderSize');
    assert.strictEqual(buf.readUInt32LE(li + 8), 1, 'VolumeIDAndLocalBasePath');
    const volOff = buf.readUInt32LE(li + 12);
    const baseOff = buf.readUInt32LE(li + 16);
    const suffixOff = buf.readUInt32LE(li + 24);
    assert.strictEqual(buf.readUInt32LE(li + 20), 0, 'no CommonNetworkRelativeLink');
    assert.strictEqual(buf.readUInt32LE(li + volOff + 4), 3, 'DRIVE_FIXED');
    assert.strictEqual(buf.subarray(li + baseOff, li + baseOff + target.length).toString('latin1'), target);
    assert.strictEqual(buf[li + baseOff + target.length], 0, 'null-terminated base path');
    assert.strictEqual(buf[li + suffixOff], 0, 'empty common path suffix');
    assert.strictEqual(size, suffixOff + 1);
    // the terminal block follows the (absent) string data
    assert.strictEqual(buf.readUInt32LE(li + size), 0);
    assert.strictEqual(buf.length, li + size + 4);
});

test('StringData round-trips in the documented order', () => {
    const opts = { target: 'C:\\W\\conhost.exe', args: '--headless "C:\\Apps\\Game_Scheduler\\node\\node.exe" "C:\\Apps\\Game_Scheduler\\launcher.js"', workingDir: 'C:\\Apps\\Game_Scheduler', icon: 'C:\\Apps\\Game_Scheduler\\app_icon.ico', description: 'Game Scheduler', showMinimized: true };
    const back = readShellLink(buildShellLink(opts));
    assert.strictEqual(back.target, opts.target);
    assert.strictEqual(back.args, opts.args);
    assert.strictEqual(back.workingDir, opts.workingDir);
    assert.strictEqual(back.icon, opts.icon);
    assert.strictEqual(back.description, opts.description);
    assert.strictEqual(back.showCommand, 7, 'SW_SHOWMINNOACTIVE');
    assert.strictEqual(back.relativePath, undefined);
});

test('optional strings are omitted, not written empty', () => {
    const back = readShellLink(buildShellLink({ target: 'C:\\x.exe' }));
    assert.strictEqual(back.target, 'C:\\x.exe');
    assert.strictEqual(back.args, undefined);
    assert.strictEqual(back.workingDir, undefined);
    assert.strictEqual(back.flags, FLAGS.HasLinkTargetIDList | FLAGS.HasLinkInfo | FLAGS.IsUnicode);
});

test('rejects a missing or non-ANSI target', () => {
    assert.throws(() => buildShellLink({}), /target is required/);
    assert.throws(() => buildShellLink({ target: 'C:\\Ωmega\\x.exe' }), /ASCII/);
});

console.log(`\n${passed} shellLink tests passed`);
