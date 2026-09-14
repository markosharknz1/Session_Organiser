const assert = require('assert');
const { installDirProblem, expandEnv, isInside } = require('./installDir');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const docs = 'C:\\Users\\club\\OneDrive\\Documents';
const src = 'C:\\Users\\club\\Downloads\\GameScheduler';
const check = (dir) => installDirProblem(dir, { documents: docs, sourceDir: src });

test('the default and other ordinary folders are accepted', () => {
    assert.strictEqual(check('C:\\Apps\\Game_Scheduler'), null);
    assert.strictEqual(check('D:\\Club\\Scheduler\\'), null);
    assert.strictEqual(check('  C:\\Apps\\Game Scheduler  '), null);
    assert.strictEqual(check(src), null, 'the downloaded folder itself (install in place)');
});

test('Documents is refused, including subfolders and odd casing', () => {
    assert.match(check(docs), /Documents/);
    assert.match(check('c:\\users\\CLUB\\onedrive\\documents\\GameScheduler'), /Documents/);
});

test('OneDrive and temporary folders are refused', () => {
    assert.match(check('C:\\Users\\club\\OneDrive - Some Club\\Apps'), /OneDrive/);
    assert.match(check('C:\\Users\\club\\OneDrive\\Desktop\\GS'), /OneDrive/);
    assert.match(check('C:\\Users\\club\\AppData\\Local\\Temp\\GS'), /temporary/);
    assert.match(check('C:\\tmp\\gs'), /temporary/);
    assert.strictEqual(check('C:\\Apps\\tmp_files'), null, 'only a whole "tmp" segment counts');
});

test('empty, relative, drive-root and inside-the-download paths are refused', () => {
    assert.match(check(''), /Choose a folder/);
    assert.match(check('   '), /Choose a folder/);
    assert.match(check('Apps\\GS'), /full path/);
    assert.match(check('\\\\server\\share\\gs'), /full path/);
    assert.match(check('C:\\'), /whole drive/);
    assert.match(check('C:'), /full path|whole drive/);
    assert.match(check('C:\\Apps\\Bad|Name'), /characters/);
    assert.match(check(src + '\\inner'), /inside the downloaded folder/);
});

test('no Documents path known: only the other rules apply', () => {
    assert.strictEqual(installDirProblem('C:\\Users\\x\\Documents\\GS', { documents: null }), null);
});

test('helpers: isInside and expandEnv', () => {
    assert.strictEqual(isInside('C:\\A\\B\\', 'c:\\a'), true);
    assert.strictEqual(isInside('C:\\AB', 'C:\\A'), false);
    const saved = process.env.GS_TEST_VAR;
    process.env.GS_TEST_VAR = 'C:\\Users\\club';
    assert.strictEqual(expandEnv('%GS_TEST_VAR%\\OneDrive\\Desktop'), 'C:\\Users\\club\\OneDrive\\Desktop');
    assert.strictEqual(expandEnv('%NOPE_NOT_SET_123%\\x'), '%NOPE_NOT_SET_123%\\x');
    if (saved === undefined) delete process.env.GS_TEST_VAR; else process.env.GS_TEST_VAR = saved;
});

console.log(`\n${passed} installDir tests passed`);
