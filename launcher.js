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
// EVERY LATER RUN: starts the server (server.js, unchanged), opens the app
// in a chromeless Edge/Chrome app window, and stops the server when that
// window closes.
//
// Runs itself twice: started plainly it re-launches itself detached with
// `--background` and exits, so the (headless) console that started it can
// go away while the app keeps running.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { findBrowser, openAppWindow } = require('./lib/appWindow');
const { defaultInstallDir, installDirProblem, desktopFolder, isInside } = require('./lib/installDir');
const { writeShellLink } = require('./lib/shellLink');

const BASE_DIR = __dirname;
const LOG_DIR = path.join(BASE_DIR, 'logs');
const PID_FILE = path.join(LOG_DIR, 'server.pid');
const MARKER = path.join(BASE_DIR, '.setup-complete');
const SETUP_PROFILE = path.join(BASE_DIR, '.edge-setup-profile');
const PORT = 4000;
const APP_URL = `http://localhost:${PORT}/checkin.html`;
const CONHOST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
// Live data that must never be copied over an existing install (so
// installing into a folder that already has the app is an upgrade that
// keeps the club's data), plus things that aren't part of the app.
const NEVER_COPY = new Set(['game_scheduler.db', '.setup-complete', 'logs', 'exports', '.edge-app-profile', '.edge-setup-profile', '.git']);

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
    if (waitForClose) await new Promise((resolve) => { win.on('exit', resolve); setTimeout(resolve, 10 * 60 * 1000); });
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

function createDesktopShortcut(appDir) {
    const desktop = desktopFolder();
    fs.mkdirSync(desktop, { recursive: true });
    const lnk = path.join(desktop, 'Game Scheduler.lnk');
    writeShellLink(lnk, {
        target: CONHOST,
        args: `--headless "${nodeFor(appDir)}" "${path.join(appDir, 'launcher.js')}"`,
        workingDir: appDir,
        icon: path.join(appDir, 'app_icon.ico'),
        description: 'Game Scheduler',
    });
    return lnk;
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
        if (!(await waitForPort(PORT, 45000))) return failSetup(`The server did not start in time.\n\nSee logs\\server.err.log in ${appDir} for details.`);
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
    const finish = async (code) => {
        if (browserWin && browserWin.exitCode === null) {
            try { browserWin.kill(); } catch (e) { /* already gone */ }
            // give the browser a moment to let go of its profile files
            for (let i = 0; i < 20 && browserWin.exitCode === null; i++) await sleep(150);
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
        browserWin.on('exit', () => {
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

async function ensureDatabase() {
    // db/init.js is idempotent and additive-only - always safe to run.
    const result = spawnSync(process.execPath, [path.join('db', 'init.js')], { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
        log(`db init failed: ${result.stdout}\n${result.stderr}`);
        await fatal(`Could not set up the database:\n\n${(result.stderr || '').slice(0, 500)}`);
    }
}

async function startServer() {
    if (await portOpen(PORT)) {
        log(`Server already running on port ${PORT} - reusing it.`);
        return null;
    }
    log('Starting server...');
    const out = fs.openSync(path.join(LOG_DIR, 'server.out.log'), 'w');
    const err = fs.openSync(path.join(LOG_DIR, 'server.err.log'), 'w');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: BASE_DIR,
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, GAME_SCHEDULER_APP_WINDOW: '1' },
    });
    fs.writeFileSync(PID_FILE, String(server.pid));
    if (await waitForPort(PORT, 15000)) {
        log(`Server ready on port ${PORT} (pid ${server.pid}).`);
        return server;
    }
    server.kill();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    await fatal('The server did not start in time.\n\nSee logs\\server.err.log for details.');
    return null;
}

function stopServer(server) {
    if (!server) {
        log('Server was reused from another window - leaving it running.');
        return;
    }
    if (server.exitCode !== null) {
        log('Server already stopped (e.g. via Stop.bat) - nothing to do.');
        return;
    }
    log(`Stopping server (pid ${server.pid})...`);
    server.kill();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    log('Server stopped.');
}

async function runApp() {
    log('--- Game Scheduler launched ---');
    await ensureAppFiles();
    await ensureDatabase();
    const server = await startServer();

    const browser = findBrowser();
    if (!browser) {
        // No Edge or Chrome - fall back to whatever the default browser is.
        // We can't tell when that window closes, so the server stays up
        // until Stop.bat; say so.
        log('No Edge/Chrome found - opening in the default browser.');
        spawn('cmd', ['/c', 'start', '', APP_URL], { windowsHide: true, stdio: 'ignore' }).unref();
        await showMessageWindow('Game Scheduler', 'Opened in your default browser (Microsoft Edge or Google Chrome wasn\'t found, so the app can\'t open in its own window).\n\nWhen you\'re finished for the night, run Stop.bat to stop the server.', { ok: true });
        return;
    }

    log(`Opening app window with ${browser}`);
    const win = openAppWindow(browser, APP_URL, { width: 1280, height: 800 });
    win.on('exit', () => {
        log('App window closed.');
        stopServer(server);
        process.exit(0);
    });
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
