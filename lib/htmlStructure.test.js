// Structure checks for the app's HTML pages. Run: node lib/htmlStructure.test.js
//
// Why this exists: v1.0.15 shipped with one stray </div> in the Settings
// page. It closed the content area early, so six settings windows fell out
// of it and were laid out squashed under the left-hand menu. Nothing in the
// test suite looked at page structure, so nothing caught it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = [
    ...fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html')).map((f) => path.join('public', f)),
    path.join('launcher', 'setup.html'),
];
// Elements that must be closed explicitly. (Void and optionally-closed
// elements - input, br, img, li, p, td, option ... - are left out on purpose.)
const PAIRED = ['div', 'section', 'main', 'nav', 'header', 'footer', 'table', 'thead', 'tbody', 'select', 'form', 'ul', 'ol', 'dl', 'button', 'label', 'script', 'style'];

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

// The markup with scripts, styles and comments blanked out (same length and
// line breaks, so reported line numbers stay right).
function markupOnly(html) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    return html
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => open + blank(body) + close)
        .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => open + blank(body) + close);
}

// Walks the tags in order; returns problems as "line N: ..." strings.
function structureProblems(html) {
    const text = markupOnly(html);
    const problems = [];
    const stack = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
    let m;
    while ((m = re.exec(text))) {
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        if (!PAIRED.includes(tag) || m[3] === '/') continue;
        const line = text.slice(0, m.index).split('\n').length;
        if (!closing) { stack.push({ tag, line }); continue; }
        const top = stack[stack.length - 1];
        if (top && top.tag === tag) { stack.pop(); continue; }
        problems.push(`line ${line}: </${tag}> closes nothing (the open element here is ${top ? `<${top.tag}> from line ${top.line}` : 'none'})`);
        // recover: if this tag is open further up, unwind to it
        const idx = stack.map((s) => s.tag).lastIndexOf(tag);
        if (idx !== -1) stack.length = idx;
    }
    for (const left of stack) problems.push(`line ${left.line}: <${left.tag}> is never closed`);
    return problems;
}

for (const page of PAGES) {
    test(`${page}: every div/section/table/... is opened and closed in order`, () => {
        const problems = structureProblems(fs.readFileSync(path.join(ROOT, page), 'utf8'));
        assert.deepStrictEqual(problems, [], `\n  ${problems.join('\n  ')}`);
    });
}

test('public/club.html: every settings window sits inside the content area, beside the menu', () => {
    const text = markupOnly(fs.readFileSync(path.join(ROOT, 'public', 'club.html'), 'utf8'));
    const open = text.indexOf('<div class="settings-content">');
    assert.ok(open !== -1, 'settings-content wrapper not found');
    // find where that wrapper closes
    const re = /<(\/?)div\b[^>]*>/g;
    re.lastIndex = open;
    let depth = 0; let close = -1; let m;
    while ((m = re.exec(text))) {
        depth += m[1] === '/' ? -1 : 1;
        if (depth === 0) { close = m.index; break; }
    }
    assert.ok(close !== -1, 'settings-content wrapper is never closed');
    const sections = [...text.matchAll(/<section\b[^>]*data-section="([^"]+)"/g)];
    assert.ok(sections.length >= 14, `expected the settings windows, found ${sections.length}`);
    const outside = sections.filter((s) => s.index < open || s.index > close).map((s) => s[1]);
    assert.deepStrictEqual(outside, [], `these windows are outside the content area: ${outside.join(', ')}`);
    // and every menu button points at a window that exists
    const names = new Set(sections.map((s) => s[1]));
    const targets = [...text.matchAll(/data-goto="([^"]+)"/g)].map((g) => g[1]);
    const missing = [...new Set(targets.filter((t) => !names.has(t)))];
    assert.deepStrictEqual(missing, [], `menu buttons point at windows that don't exist: ${missing.join(', ')}`);
});

test('the checker itself catches a stray closing tag and an unclosed one', () => {
    assert.strictEqual(structureProblems('<div><section><div></div></section></div>').length, 0);
    assert.match(structureProblems('<div><section></div></div></section></div>').join(' '), /closes nothing/);
    assert.match(structureProblems('<div><section></section>').join(' '), /never closed/);
    assert.strictEqual(structureProblems('<div><!-- </div> --><script>var s = "</div>";</script></div>').length, 0, 'comments and scripts are ignored');
});

console.log(`\n${passed} html structure tests passed`);
