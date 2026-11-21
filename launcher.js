// Game Scheduler launcher. Started by "Game Scheduler.cmd" (the download)
// or the desktop shortcut (an installed copy), both through
// `conhost.exe --headless node.exe launcher.js` so there's no console
// window. Everything here is plain Node.js - no PowerShell, no Windows
// Script Host, no compiled program - because a locked-down Windows 11 PC
// (Smart App Control on) blocks every one of those when they come from a
// download, and antivirus heuristics flag them even when it doesn't.
//
// FIRST RUN (no .setup-complete marker beside this file): opens a setup
// page in an Edge/Chrome app window - install location (default
// C:\Apps\Game_Scheduler; never Documents/OneDrive), desktop-shortcut
// tickbox, then progress - copies the app there, removes the "downloaded
// from the internet" mark from the copied files, prepares the database,
// writes the shortcut, and starts the installed copy. This downloaded
// folder remembers where the app went ("installed-to=<path>" in its
// marker), so running its .cmd again just opens the installed copy.
//
// EVERY LATER RUN: opens the app's window straight away on a "Starting"
// page (launcher/starting.html, served from here), starts the server
// (server.js, unchanged), moves the window on to the app once the server
// answers, and stops the server when the window closes. A start that fails
// is reported in that same window, with what the server said and a Try
// again button; a second double-click while one start is under way (or
// showing its failure) is handed to the launcher that is already there.
//
// Runs itself twice: started plainly it re-launches itself detached with
// `--background` and exits, so the (headless) console that started it can
// go away while the app keeps running.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { findBrowser, openAppWindow, whenAppClosed } = require('./lib/appWindow');
const { defaultInstallDir, installDirProblem, desktopFolder, isInside } = require('./lib/installDir');
const { writeShellLink } = require('./lib/shellLink');
const { tailOf, keepPrevious } = require('./lib/launchLogs');

const BASE_DIR = __dirname;
const LOG_DIR = path.join(BASE_DIR, 'logs');
const PID_FILE = path.join(LOG_DIR, 'server.pid');
// Who is starting (or showing) the app right now: this launcher's pid and
// the address of its starting page. A second launch reads it.
const LAUNCH_FILE = path.join(LOG_DIR, 'launcher.json');
const SERVER_OUT_LOG = path.join(LOG_DIR, 'server.out.log');
const SERVER_ERR_LOG = path.join(LOG_DIR, 'server.err.log');
// How long the server gets to answer. It is up in a second or two on a
// warm computer, but one that has only just been switched on (cold disk,
// antivirus reading every file for the first time) has been seen to need
// far longer than the 15 seconds this used to allow.
const START_TIMEOUT_MS = Number(process.env.GAMESCHEDULER_START_TIMEOUT_MS) || 60000;
const MARKER = path.join(BASE_DIR, '.setup-complete');
const SETUP_PROFILE = path.join(BASE_DIR, '.edge-setup-profile');
const PORT = 4000;
const APP_URL = `http://localhost:${PORT}/checkin.html`;
const CONHOST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
// Live data that must never be copied over an existing install (so
// installing into a folder that already has the app is an upgrade that
// keeps the club's data), plus things that aren't part of the app.
const NEVER_COPY = new Set(['game_scheduler.db', '.setup-complete', 'logs', 'exports', '.edge-app-profile', '.edge-setup-profile', '.git', 'Game Scheduler.lnk']);
const SHORTCUT_NAME = 'Game Scheduler.lnk';

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'run.log'), `${timestamp()}  ${message}\n`);
}

function portOpen(port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portOpen(port)) return true;
        await sleep(300);
    }
    return false;
}

// The Node.js that runs an app folder: the runtime bundled in its node\
// folder (the release ZIP), else whatever is running this file.
function nodeFor(dir) {
    const bundled = path.join(dir, 'node', 'node.exe');
    return fs.existsSync(bundled) ? bundled : process.execPath;
}

// Starts a copy of the app (this one or an installed one) detached from
// this process. A detached process gets no console of its own, so no
// conhost --headless is needed here - that's only for the .cmd and the
// shortcut, where a shell is doing the starting.
function launchDetached(dir) {
    const child = spawn(nodeFor(dir), [path.join(dir, 'launcher.js'), '--background'], {
        cwd: dir, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
}

// --- Failure surface ----------------------------------------------------------
// There's no console to print to, so a failure is shown as a page in an
// app window (the same way the setup page is). No browser at all: the log
// is opened in Notepad instead, which every Windows has.
function messagePage(title, message, ok) {
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<!doctype html><html><head><meta charset="utf-8"><title>Game Scheduler</title><style>
body{margin:0;background:#fff;color:#1f2937;font:15px/1.5 "Segoe UI",system-ui,sans-serif}.page{max-width:560px;margin:0 auto;padding:28px 32px}
h1{font-size:22px;margin:0 0 14px;color:${ok ? '#15803d' : '#b91c1c'}}p{white-space:pre-wrap}.small{font-size:13px;color:#6b7280;margin-top:24px}</style></head>
<body><div class="page"><h1>${esc(title)}</h1><p>${esc(message)}</p><p class="small">Details are in logs\\run.log next to the app. You can close this window.</p></div></body></html>`;
}

function serveOnce(html) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}

async function showMessageWindow(title, message, { ok = false, waitForClose = true } = {}) {
    const browser = findBrowser();
    if (!browser) {
        try {
            const notice = path.join(LOG_DIR, 'NOTICE.txt');
            fs.writeFileSync(notice, `${title}\r\n\r\n${message.replace(/\n/g, '\r\n')}\r\n`);
            spawn('notepad.exe', [notice], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) { /* nothing more we can do */ }
        return;
    }
    const { server, url } = await serveOnce(messagePage(title, message, ok));
    const win = openAppWindow(browser, url, { width: 620, height: 420, profileDir: SETUP_PROFILE });
    if (waitForClose) await Promise.race([whenAppClosed(win, { profileDir: SETUP_PROFILE }), sleep(10 * 60 * 1000)]);
    server.close();
}

async function fatal(message) {
    log(`FATAL: ${message}`);
    await showMessageWindow('Game Scheduler could not start', message);
    process.exit(1);
}

// --- Setup (first run) --------------------------------------------------------
const setup = { phase: 'welcome', steps: [], message: '', installedTo: null };

function step(text) { setup.steps.push({ text, state: 'running' }); log(text); }
function done() { setup.steps[setup.steps.length - 1].state = 'done'; }
function failSetup(message) {
    if (setup.steps.length) setup.steps[setup.steps.length - 1].state = 'failed';
    setup.phase = 'failed';
    setup.message = message;
    log(`SETUP FAILED: ${message}`);
}

function copyApp(target) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(BASE_DIR, target, {
        recursive: true,
        filter: (src) => {
            const rel = path.relative(BASE_DIR, src);
            if (!rel) return true;
            return !NEVER_COPY.has(rel.split(path.sep)[0]);
        },
    });
}

// Files extracted from a downloaded ZIP carry a "Zone.Identifier" stream -
// the mark that makes Windows warn about (or, with Smart App Control,
// refuse) running them. The installed copy is the user's own now.
function unblockTree(dir) {
    let removed = 0;
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { if (!NEVER_COPY.has(entry.name)) walk(full); continue; }
            try { fs.unlinkSync(`${full}:Zone.Identifier`); removed++; } catch (e) { /* no mark on this file */ }
        }
    };
    walk(dir);
    return removed;
}

// A shortcut that starts the app in appDir with no console window, written
// to `lnk`. Same shortcut wherever it is put.
function writeAppShortcut(lnk, appDir) {
    writeShellLink(lnk, {
        target: CONHOST,
        args: `--headless "${nodeFor(appDir)}" "${path.join(appDir, 'launcher.js')}"`,
        workingDir: appDir,
        icon: path.join(appDir, 'app_icon.ico'),
        description: 'Game Scheduler',
    });
    return lnk;
}

function createDesktopShortcut(appDir) {
    const desktop = desktopFolder();
    fs.mkdirSync(desktop, { recursive: true });
    return writeAppShortcut(path.join(desktop, SHORTCUT_NAME), appDir);
}

// The app folder always holds its own "Game Scheduler" shortcut - the icon
// to double-click when looking in the folder, and one that can be copied to
// the taskbar, the Start menu or another desktop. Rewritten whenever it is
// missing or the folder has moved (it stores the full path). Never fatal.
function ensureFolderShortcut(appDir) {
    try {
        const lnk = path.join(appDir, SHORTCUT_NAME);
        let current = null;
        try { current = require('./lib/shellLink').readShellLink(fs.readFileSync(lnk)); } catch (e) { /* missing or unreadable */ }
        if (current && current.workingDir === appDir && current.args && current.args.includes(nodeFor(appDir))) return lnk;
        writeAppShortcut(lnk, appDir);
        log(`Shortcut in the app folder: ${lnk}`);
        return lnk;
    } catch (e) {
        log(`Could not create the shortcut in the app folder (non-fatal): ${e.message}`);
        return null;
    }
}

async function runInstall(dirText, wantShortcut) {
    setup.phase = 'running';
    const target = path.win32.resolve(dirText.trim()).replace(/[\\/]+$/, '');
    const inPlace = isInside(target, BASE_DIR) && isInside(BASE_DIR, target);
    const appDir = inPlace ? BASE_DIR : target;
    try {
        if (!inPlace) {
            step(`Copying the app to ${target}`);
            copyApp(target);
            done();
        } else {
            log('Installing in place (chosen folder is this folder).');
        }
        step('Unblocking the app files');
        const removed = unblockTree(appDir);
        log(`Removed the downloaded-file mark from ${removed} file(s).`);
        done();

        step('Setting up the database');
        const init = spawnSync(nodeFor(appDir), [path.join('db', 'init.js')], { cwd: appDir, encoding: 'utf8', windowsHide: true });
        if (init.status !== 0) return failSetup(`Could not set up the database.\n\n${(init.stderr || init.stdout || '').slice(0, 500)}`);
        done();

        ensureFolderShortcut(appDir);
        if (wantShortcut) {
            step('Creating a desktop shortcut');
            try { log(`Shortcut: ${createDesktopShortcut(appDir)}`); done(); } catch (e) {
                // never block the app over a shortcut
                log(`Could not create a desktop shortcut (non-fatal): ${e.message}`);
                setup.steps[setup.steps.length - 1].text += ' (skipped - see logs\\run.log)';
                done();
            }
        }

        fs.writeFileSync(path.join(appDir, '.setup-complete'), `setup completed ${timestamp()}\r\n`);
        if (!inPlace) fs.writeFileSync(MARKER, `installed-to=${appDir}\r\n`);
        setup.installedTo = appDir;

        step(await portOpen(PORT) ? 'Game Scheduler is already running - opening it' : 'Starting Game Scheduler');
        launchDetached(appDir);
        if (!(await waitForPort(PORT, START_TIMEOUT_MS + 30000))) return failSetup(`The app did not start in time.\n\nSee logs\\run.log in ${appDir} for details.`);
        done();
        setup.phase = 'done';
        setup.message = inPlace
            ? 'Game Scheduler is opening.'
            : `Installed to ${appDir} - Game Scheduler is opening. The downloaded folder can be deleted; use the desktop shortcut from now on.`;
        log(setup.message);
    } catch (e) {
        failSetup(`${e.message}\n\nCheck the folder is writable, then run Game Scheduler.cmd again.`);
    }
}

function readJson(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
    });
}

function startSetupServer(onCancel) {
    const page = fs.readFileSync(path.join(BASE_DIR, 'launcher', 'setup.html'));
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
            if (req.method === 'GET' && req.url === '/api/setup') return json(200, { defaultDir: defaultInstallDir(), sourceDir: BASE_DIR });
            if (req.method === 'GET' && req.url === '/api/status') return json(200, setup);
            if (req.method === 'POST' && req.url === '/api/install') {
                const body = await readJson(req);
                if (setup.phase !== 'welcome') return json(409, { error: 'Setup is already running.' });
                const problem = installDirProblem(body.dir, { sourceDir: BASE_DIR });
                if (problem) return json(200, { error: problem });
                json(200, { ok: true });
                runInstall(body.dir, body.shortcut !== false);
                return undefined;
            }
            if (req.method === 'POST' && req.url === '/api/cancel') { json(200, { ok: true }); return onCancel(); }
            res.writeHead(404); return res.end();
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}

async function runSetup() {
    log('--- first run: setup ---');
    // Test hook: install to the default (or GAMESCHEDULER_SETUP_TARGET)
    // folder immediately, with no setup window.
    if (process.env.GAMESCHEDULER_SETUP_AUTORUN === '1') {
        const dir = defaultInstallDir();
        const problem = installDirProblem(dir, { sourceDir: BASE_DIR });
        if (problem) { log(`autorun refused: ${problem}`); process.exit(2); }
        await runInstall(dir, process.env.GAMESCHEDULER_SETUP_SHORTCUT === '1');
        process.exit(setup.phase === 'done' ? 0 : 1);
    }

    let browserWin = null;
    let setupWindowGone = null; // resolves when the setup window's browser has gone
    const finish = async (code) => {
        if (browserWin) {
            // The page closes its own window once setup is done or
            // cancelled (launcher/setup.html). Killing the process we
            // spawned is only a backstop: the browser may have handed the
            // window to another process of itself (lib/appWindow.js).
            await Promise.race([setupWindowGone, sleep(4000)]);
            if (browserWin.exitCode === null) { try { browserWin.kill(); } catch (e) { /* already gone */ } }
            // give the browser a moment to let go of its profile files
            await Promise.race([setupWindowGone, sleep(3000)]);
            await sleep(500);
        }
        try { fs.rmSync(SETUP_PROFILE, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        process.exit(code);
    };
    const { url } = await startSetupServer(() => { log('Setup cancelled.'); setTimeout(() => finish(0), 300); });
    log(`Setup page at ${url}`);
    const browser = findBrowser();
    if (browser) {
        browserWin = openAppWindow(browser, url, { width: 640, height: 760, profileDir: SETUP_PROFILE });
        setupWindowGone = whenAppClosed(browserWin, { profileDir: SETUP_PROFILE });
        setupWindowGone.then(() => {
            if (setup.phase === 'welcome') { log('Setup window closed before installing.'); finish(0); }
        });
    } else {
        log('No Edge/Chrome found - opening the setup page in the default browser.');
        spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' }).unref();
    }
    // Wait for the install to finish (or fail), then give the user a moment
    // to read the result before the setup window goes away.
    while (setup.phase === 'welcome' || setup.phase === 'running') await sleep(300);
    if (setup.phase === 'done') { await sleep(7000); finish(0); }
    // failed: leave the page up until the user closes it (Close -> /api/cancel)
}

// --- Normal run ---------------------------------------------------------------
async function ensureAppFiles() {
    const missing = ['server.js', 'db', 'public', 'node_modules'].filter((name) => !fs.existsSync(path.join(BASE_DIR, name)));
    if (missing.length) {
        await fatal(`Game Scheduler must be run from inside its own folder - it looks like only part of it is here:\n\n${BASE_DIR}\n\nMissing: ${missing.join(', ')}\n\nDownload the full GameScheduler ZIP from the Releases page, extract it anywhere, and run "Game Scheduler.cmd" from inside that folder.`);
    }
}

// Runs a script with this Node.js without blocking - the starting page has
// to keep answering while it runs.
function runNode(args) {
    return new Promise((resolve) => {
        let out = '';
        let err = '';
        const child = spawn(process.execPath, args, { cwd: BASE_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.once('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
        child.once('close', (code) => resolve({ code, out, err }));
    });
}

const lastLines = (text) => String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(-12).join('\n').slice(-1500);

// What the starting page shows (GET /status on the status server below).
const start = { phase: 'starting', step: '', message: '', detail: '', startedAt: Date.now() };
let serverChild = null; // the server this launcher started (null: none - or it is someone else's)
let stoppingServer = false; // it is being stopped on purpose
let attempting = false;
let appBrowser = null;

// Sets up the database and starts server.js, waiting for it to answer on
// the port. Resolves { ok: true } or { ok: false, message, detail }; it
// shows nothing itself.
async function bringUpServer() {
    if (await portOpen(PORT)) {
        log(`Server already running on port ${PORT} - reusing it.`);
        return { ok: true };
    }
    start.step = 'Getting the club\u2019s data ready\u2026';
    // db/init.js is idempotent and additive-only - always safe to run.
    const init = await runNode([path.join('db', 'init.js')]);
    if (init.code !== 0) {
        return { ok: false, message: 'The database could not be set up.', detail: lastLines(init.err || init.out) };
    }

    start.step = 'Starting the app\u2026';
    log('Starting server...');
    // The launch before this one may be the one that failed: keep its logs
    // (server.err.prev.log) instead of wiping them with this launch's.
    keepPrevious(SERVER_OUT_LOG);
    keepPrevious(SERVER_ERR_LOG);
    const out = fs.openSync(SERVER_OUT_LOG, 'w');
    const err = fs.openSync(SERVER_ERR_LOG, 'w');
    const child = spawn(process.execPath, ['server.js'], {
        cwd: BASE_DIR,
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, GAME_SCHEDULER_APP_WINDOW: '1' },
    });
    fs.closeSync(out);
    fs.closeSync(err);
    serverChild = child; // from this moment, closing the window stops it
    let gone = null;
    child.once('error', (e) => { gone = gone || { error: e.message }; });
    child.once('exit', (code) => { gone = gone || { code }; });
    if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid));

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!gone && Date.now() < deadline) {
        if (await portOpen(PORT)) {
            child.once('exit', (code) => serverStopped(child, code));
            log(`Server ready on port ${PORT} (pid ${child.pid}) after ${((Date.now() - start.startedAt) / 1000).toFixed(1)}s.`);
            return { ok: true };
        }
        await sleep(250);
    }

    // It never answered. A server that died says why in its error log; one
    // that is merely slow gets stopped so the next try starts clean.
    serverChild = null;
    if (!gone) { stoppingServer = true; child.kill(); stoppingServer = false; }
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    const detail = tailOf(SERVER_ERR_LOG) || tailOf(SERVER_OUT_LOG);
    if (gone && gone.error) return { ok: false, message: `Node.js could not be started: ${gone.error}`, detail };
    if (gone) return { ok: false, message: `The app stopped while it was starting (exit code ${gone.code}).`, detail };
    return {
        ok: false,
        message: `The app did not start within ${Math.round(START_TIMEOUT_MS / 1000)} seconds.\n\nThis can happen on a computer that has only just been switched on. Give it a moment, then click Try again.`,
        detail,
    };
}

// The server went away while the app window was open (Stop.bat, or it
// failed). Nothing can be shown in the window - it is on the app's own
// page by now - so record why; starting Game Scheduler again brings it back
// (the new launch finds this one and asks it to try again).
async function serverStopped(child, code) {
    if (stoppingServer || serverChild !== child) return;
    serverChild = null;
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    if (await portOpen(PORT)) { log('This window\'s server has stopped, but another copy is answering - leaving it be.'); return; }
    start.phase = 'stopped';
    const detail = tailOf(SERVER_ERR_LOG);
    log(`Server stopped while the app window was open (exit code ${code}) - Stop.bat, or it failed.${detail ? `\n--- what the app reported ---\n${detail}\n---` : ''}`);
}

// One go at getting the server up, reported through `start`. Resolves true
// when the app is ready.
async function attemptStart() {
    if (attempting) return false;
    attempting = true;
    const windowIsOnTheApp = start.phase === 'stopped';
    Object.assign(start, { phase: 'starting', step: '', message: '', detail: '', startedAt: Date.now() });
    let result;
    try { result = await bringUpServer(); } catch (e) { result = { ok: false, message: `Unexpected error: ${e.message}`, detail: '' }; }
    attempting = false;
    if (result.ok) {
        start.phase = 'ready';
        if (windowIsOnTheApp && appBrowser) {
            // The old window can't be moved from here; this opens the app
            // afresh in the same browser (which is still running).
            log('Server is back - opening the app again.');
            openAppWindow(appBrowser, APP_URL, { width: 1280, height: 800 });
        }
        return true;
    }
    log(`FATAL: ${result.message}${result.detail ? `\n--- what the app reported ---\n${result.detail}\n---` : ''}`);
    Object.assign(start, { phase: 'failed', message: result.message, detail: result.detail || '' });
    return false;
}

function stopServer() {
    if (!serverChild) {
        log('No server of this window\'s to stop (it was already running from another window, or had stopped).');
        return;
    }
    if (serverChild.exitCode !== null) {
        log('Server already stopped (e.g. via Stop.bat) - nothing to do.');
        return;
    }
    log(`Stopping server (pid ${serverChild.pid})...`);
    stoppingServer = true;
    serverChild.kill();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    log('Server stopped.');
}

// The starting page and what it polls. Stays up for as long as this
// launcher does, so a later launch can find it (LAUNCH_FILE).
function startStatusServer() {
    const page = fs.readFileSync(path.join(BASE_DIR, 'launcher', 'starting.html'));
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page); }
            if (req.method === 'GET' && req.url === '/status') {
                return json(200, { app: 'game-scheduler-launcher', phase: start.phase, step: start.step, message: start.message, detail: start.detail, appUrl: APP_URL, elapsedMs: Date.now() - start.startedAt });
            }
            if (req.method === 'POST' && req.url === '/retry') {
                req.resume();
                // The Try again button, or another launch finding this one.
                if (!attempting && start.phase !== 'starting' && !(await portOpen(PORT))) {
                    log('Trying again.');
                    attemptStart();
                }
                return json(200, { ok: true });
            }
            res.writeHead(404); return res.end();
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}

// A small JSON request to another launcher's status server; null if nobody
// answers (in time).
function requestJson(method, url, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.request(url, { method, timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// Another launcher of this copy of the app that is alive right now - the
// one whose window the user is (or should be) looking at.
async function otherLauncher() {
    let info;
    try { info = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8')); } catch (e) { return null; }
    if (!info || info.pid === process.pid || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url || '')) return null;
    const status = await requestJson('GET', `${info.url}status`);
    if (!status || status.app !== 'game-scheduler-launcher') return null; // a file left by a launcher that has gone
    return { pid: info.pid, url: info.url, phase: status.phase };
}

// No Edge or Chrome - fall back to whatever the default browser is. We
// can't tell when that window closes, so the server stays up until
// Stop.bat; say so.
async function openInDefaultBrowser() {
    log('No Edge/Chrome found - opening in the default browser.');
    spawn('cmd', ['/c', 'start', '', APP_URL], { windowsHide: true, stdio: 'ignore' }).unref();
    await showMessageWindow('Game Scheduler', 'Opened in your default browser (Microsoft Edge or Google Chrome wasn\'t found, so the app can\'t open in its own window).\n\nWhen you\'re finished for the night, run Stop.bat to stop the server.', { ok: true });
}

async function runApp() {
    log('--- Game Scheduler launched ---');
    await ensureAppFiles();
    ensureFolderShortcut(BASE_DIR);
    const browser = findBrowser();
    appBrowser = browser;

    // Already running - another window of it is open. Nothing to set up
    // and nothing to start (and the database file is the running server's
    // to write, not ours): just one more window on it.
    if (await portOpen(PORT)) {
        log(`Server already running on port ${PORT} - reusing it.`);
        if (!browser) return openInDefaultBrowser();
        log(`Opening another app window with ${browser} - the launcher that started the server looks after it.`);
        openAppWindow(browser, APP_URL, { width: 1280, height: 800 }).unref();
        return undefined;
    }

    // A second double-click while the first is still starting, or while its
    // window is showing that the start failed: that launcher has the
    // window, so it does the work.
    const other = await otherLauncher();
    if (other) {
        if (other.phase === 'starting') {
            log(`Already starting (launcher pid ${other.pid}) - leaving it to that one.`);
        } else {
            log(`A Game Scheduler window is already open (${other.phase}, launcher pid ${other.pid}) - asking it to try again.`);
            await requestJson('POST', `${other.url}retry`);
        }
        return undefined;
    }

    if (!browser) {
        if (!(await attemptStart())) {
            await showMessageWindow('Game Scheduler could not start', `${start.message}${start.detail ? `\n\nWhat the app reported:\n${start.detail}` : ''}`);
            process.exit(1);
        }
        return openInDefaultBrowser();
    }

    // The window first, on the starting page, so there is something to see
    // from the moment of the double-click; then the server.
    const status = await startStatusServer();
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ pid: process.pid, url: status.url, at: timestamp() }));
    log(`Opening app window with ${browser}`);
    const win = openAppWindow(browser, status.url, { width: 1280, height: 800 });
    whenAppClosed(win).then((how) => {
        if (how === 'never-opened') log('The browser never opened the app window.');
        log(start.phase === 'ready' ? 'App window closed.' : `App window closed (${start.phase}).`);
        stopServer();
        try { fs.unlinkSync(LAUNCH_FILE); } catch (e) { /* already gone */ }
        process.exit(start.phase === 'failed' ? 1 : 0);
    });
    await attemptStart();
    return undefined;
}

// --- Entry --------------------------------------------------------------------
async function main() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    let marker = null;
    try { marker = fs.readFileSync(MARKER, 'utf8'); } catch (e) { /* first run */ }
    const installedTo = marker && /installed-to=(.+)/.exec(marker);
    if (installedTo) {
        const dir = installedTo[1].trim();
        if (fs.existsSync(path.join(dir, 'launcher.js'))) {
            log(`This folder was installed to ${dir} - starting that copy.`);
            launchDetached(dir);
            return;
        }
        log(`Installed copy at ${dir} is gone - running setup again.`);
        fs.unlinkSync(MARKER);
        marker = null;
    }
    if (!marker) return runSetup();
    return runApp();
}

if (process.argv.includes('--background')) {
    main().catch((err) => fatal(`Unexpected error: ${err.message}`));
} else {
    const child = spawn(process.execPath, [__filename, '--background'], {
        cwd: BASE_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}
