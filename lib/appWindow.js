// Opens the app in a chromeless "app window" of a browser that's already on
// the machine (Edge ships with Windows 10/11; Chrome as a fallback) - no
// bundled runtime, no packed executable, nothing for antivirus heuristics
// to object to. Shared by launcher.js (the main window) and
// routes/launcher.js (the External Display window).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// One dedicated browser profile for the app, kept next to it (launcher.js
// passes a different one for its first-run setup window). Two reasons:
// the browser then runs as its own process that exits when the app's last
// window closes (so the launcher knows when to stop the server), and the
// autoplay flag below only takes effect on a fresh browser process.
const PROFILE_DIR = path.join(__dirname, '..', '.edge-app-profile');

function findBrowser() {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const candidates = [
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
}

function appWindowArgs(url, { width = 1280, height = 800, profileDir = PROFILE_DIR } = {}) {
    return [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
        // A fresh profile on a PC signed in with a Microsoft account gets a
        // "we're now syncing your browsing data" prompt from Edge on top of
        // the app the first time. The app profile has nothing to sync.
        '--disable-sync',
        '--disable-features=msImplicitSignin,msSyncPromo',
        // The round-end horn (public/horn.js) has to play on the Display
        // window, which nobody ever clicks - browsers block audio until a
        // click without this.
        '--autoplay-policy=no-user-gesture-required',
    ];
}

// Returns the spawned process (exits when the app's last window closes if
// this was the first window; exits immediately if it just handed the URL to
// an already-running app-profile browser). Deliberately NOT windowsHide:
// that flag is for console programs, and Chromium honours the "start
// hidden" hint it sets - the app window opened invisible.
function openAppWindow(browserPath, url, options) {
    const child = spawn(browserPath, appWindowArgs(url, options), { stdio: 'ignore', windowsHide: false });
    return child;
}

module.exports = { PROFILE_DIR, findBrowser, appWindowArgs, openAppWindow };
