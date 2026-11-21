// Small file helpers for launcher.js, kept apart so they can be tested
// without starting anything: the tail of a log (what a failed start shows
// the user and copies into run.log) and keeping the previous launch's
// server logs (a retry used to wipe the only record of why the launch
// before it failed).
const fs = require('fs');

// The last few non-blank lines of a text file, or '' if there is nothing to
// read. Capped by lines and by characters - it goes on screen.
function tailOf(file, { lines = 12, chars = 1500 } = {}) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
    const kept = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join('\n');
    return kept.length > chars ? kept.slice(kept.length - chars) : kept;
}

// server.err.log -> server.err.prev.log. Only when there is something in
// it, so an empty log never replaces a useful one. Never throws: a log that
// can't be moved must not stop the app starting.
function prevName(file) {
    return /\.log$/i.test(file) ? file.replace(/\.log$/i, '.prev.log') : `${file}.prev`;
}

function keepPrevious(file) {
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
        const prev = prevName(file);
        fs.rmSync(prev, { force: true });
        fs.renameSync(file, prev);
        return prev;
    } catch (e) {
        return null;
    }
}

module.exports = { tailOf, keepPrevious, prevName };
