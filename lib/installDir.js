// Where Game Scheduler may be installed, and where Windows keeps the user's
// Documents and Desktop folders. Used by launcher.js on first-run setup.
//
// Windows-specific paths are worked out with path.win32 so the rules (and
// their tests) behave the same on the Linux runner that builds releases.
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const win = path.win32;

// Documents and Desktop can be redirected (OneDrive's "Known Folder Move"
// puts them under %USERPROFILE%\OneDrive\...), so the real location comes
// from the registry via reg.exe - a signed Windows tool, no scripting -
// falling back to the classic folder under the profile.
function knownFolder(valueName, fallback) {
    if (process.platform !== 'win32') return fallback;
    try {
        const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', valueName], { encoding: 'utf8', windowsHide: true });
        const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(r.stdout || '');
        if (m) return expandEnv(m[1]);
    } catch (e) { /* fall through */ }
    return fallback;
}

function expandEnv(text) {
    return text.replace(/%([^%]+)%/g, (whole, name) => (process.env[name] !== undefined ? process.env[name] : whole));
}

function documentsFolder() { return knownFolder('Personal', path.join(os.homedir(), 'Documents')); }
function desktopFolder() { return knownFolder('Desktop', path.join(os.homedir(), 'Desktop')); }

// A short, obvious path on the system drive, well away from Documents. A
// standard user can create a folder at the drive root - no admin needed.
function defaultInstallDir() {
    if (process.env.GAMESCHEDULER_SETUP_TARGET) return process.env.GAMESCHEDULER_SETUP_TARGET; // test hook
    return win.join(process.env.SystemDrive || 'C:', 'Apps', 'Game_Scheduler');
}

const norm = (p) => win.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
function isInside(child, parent) {
    const c = norm(child); const p = norm(parent);
    return c === p || c.startsWith(p + '\\');
}

// Returns a message explaining why `dir` can't be used, or null if it can.
// `documents` and `sourceDir` are injectable for tests.
function installDirProblem(dir, { documents, sourceDir } = {}) {
    const text = (dir || '').trim();
    if (!text) return 'Choose a folder to install to.';
    if (!win.isAbsolute(text) || !/^[a-z]:\\/i.test(text)) return 'Please give a full path, like C:\\Apps\\Game_Scheduler.';
    if (/[<>"|?*]/.test(text)) return 'That folder name has characters Windows doesn\'t allow.';
    const full = win.resolve(text);
    if (/^[a-z]:\\?$/i.test(full)) return 'Please choose a folder, not the whole drive.';
    const docs = documents === undefined ? documentsFolder() : documents;
    if (docs && isInside(full, docs)) {
        return "Please don't install in your Documents folder - it's often synced by OneDrive, and syncing the app's live database corrupts it. Backups are already saved to Documents\\GameScheduler\\backups automatically.";
    }
    if (/\\onedrive[^\\]*(\\|$)/i.test(full)) return "Please don't install in a OneDrive folder - syncing the app's live database while a session runs corrupts it.";
    if (/\\(temp|tmp)(\\|$)/i.test(full)) return "That's a temporary folder - it may be cleaned out. Choose somewhere permanent.";
    if (sourceDir && isInside(full, sourceDir) && norm(full) !== norm(sourceDir)) {
        return "That's inside the downloaded folder itself. Choose a folder outside it (or the downloaded folder itself, to run from here).";
    }
    return null;
}

module.exports = { knownFolder, expandEnv, documentsFolder, desktopFolder, defaultInstallDir, installDirProblem, isInside };
