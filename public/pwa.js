// Shared across every page: registers the service worker and wires up the
// header's "+ Install app" button (if the page has one) to the browser's
// native PWA install prompt. Pages with no #install-app-btn (the Display
// kiosk screen) just get the service worker registration.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker registration failed:', err));
    });
}

// A device signed in with the check-in PIN (see lib/access.js) can only use
// the Check-in page and the External Display. Mark the page so the links and
// buttons it can't use are hidden (style.css, .role-desk) rather than
// leading to a refusal. The server enforces it either way.
fetch('/api/access/info').then((r) => r.json()).then((info) => {
    if (info.role === 'desk') document.documentElement.classList.add('role-desk');
}).catch(() => {});

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const btn = document.getElementById('install-app-btn');
    if (btn && !isStandalone()) btn.style.display = '';
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const btn = document.getElementById('install-app-btn');
    if (btn) btn.style.display = 'none';
});

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('install-app-btn');
    if (!btn || isStandalone()) return;
    btn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        btn.style.display = 'none';
    });
});

// Inside the launcher's app window (launcher.js - a chromeless Edge/Chrome
// window), a target="_blank" link would open the Display in a normal browser
// window with an address bar and tabs, which is not what you want on a TV.
// Ask the server to open it as a second app window instead. A regular
// browser tab, or a device elsewhere on the wifi, gets a refusal and simply
// keeps the ordinary link.
document.addEventListener('DOMContentLoaded', () => {
    const displayLink = document.querySelector('a[href="/display.html"]');
    if (!displayLink) return;
    fetch('/api/launcher').then((r) => r.json()).then(({ app_window }) => {
        if (!app_window) return;
        displayLink.addEventListener('click', async (event) => {
            event.preventDefault();
            const res = await fetch('/api/launcher/open-display', { method: 'POST' }).catch(() => null);
            if (!res || !res.ok) window.open('/display.html', '_blank');
        });
    }).catch(() => {});
});
