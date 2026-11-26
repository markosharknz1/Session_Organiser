// App-shell service worker: satisfies PWA installability, and gives a
// fallback if the local server is genuinely unreachable. API calls always
// go straight to the network - this is a live local server app, not
// something meant to work truly offline, so caching API responses would
// just show stale data.
//
// NETWORK-FIRST, not cache-first: GameScheduler.exe already waits for the
// server to confirm it's ready before it ever opens the app window (see
// launcher.py's start_server()), so the shell is never actually needed to
// paper over a slow server - and cache-first was actively harmful: every
// version of this app serves from the same http://localhost:4000 origin,
// so WebView2's cache persists across app updates. A cache-first shell
// meant an updated release could still show old cached pages after
// "updating" (real bug hit in testing - see PROGRESS.md). Network-first
// means the live server's current files always win when it's reachable,
// and the cache is only ever a last-resort fallback.
const CACHE_NAME = 'game-scheduler-shell-v6';
const SHELL_FILES = [
    '/checkin.html', '/manage.html', '/display.html', '/club.html', '/members.html', '/history.html',
    '/style.css', '/events.js', '/pwa.js',
    '/checkin.js', '/manage.js', '/display.js', '/club.js', '/members.js', '/history.js',
    '/manifest.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/')) return;
    // Passing event.request straight to fetch() still lets the browser's own
    // HTTP cache short-circuit it via heuristic caching - "network-first" at
    // the service-worker level isn't enough on its own (this is what let
    // stale style.css/*.js keep being served even after the v3 fix below).
    // Fetching by URL string with cache:'no-store' forces a real round trip
    // every time - deliberately NOT `new Request(event.request, {...})`,
    // since the Request constructor throws if the source request's mode is
    // 'navigate' (top-level page loads), which every HTML page load is.
    event.respondWith(
        fetch(event.request.url, { cache: 'no-store' })
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                return res;
            })
            .catch(() => caches.match(event.request))
    );
});
