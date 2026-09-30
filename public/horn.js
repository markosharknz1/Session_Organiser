// Round-end horn, shared by the Display screen and the Rounds page (same
// idiom as events.js/branding.js). The built-in horn is synthesised with
// the Web Audio API - no audio file to bundle, nothing to download. A club
// can upload its own .wav instead (Settings > Club details > Round-end
// sound); setClubHorn() loads it and playHorn() plays that in place of the
// built-in one.
//
// Which screen actually sounds it: the Display screen owns the horn (it's
// the players' screen, where "Time! Come off court" already shows). The
// Rounds page only sounds it when no Display window is alive on this same
// machine - Display windows heartbeat over a BroadcastChannel (same origin,
// same browser profile - true for both the pywebview app and a browser), so
// a laptop running both screens gets exactly one horn, and a laptop running
// only the Rounds page still gets one.
//
// Browsers won't start audio until the user has interacted with the page
// (the launcher lifts that for the .exe via an autoplay flag). When audio is
// blocked, a small "sound off" pill appears; any click on the page unlocks it.

const HORN_CHANNEL_NAME = 'game-scheduler-horn';
const HORN_HEARTBEAT_MS = 2000;
const HORN_OWNER_TIMEOUT_MS = 6000;

let hornCtx = null;
let hornChannel = null;
let lastDisplayHornSeen = 0;

function hornContext() {
    if (!hornCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        hornCtx = new AC();
    }
    return hornCtx;
}

function hornUnlocked() {
    const ctx = hornContext();
    return !!ctx && ctx.state === 'running';
}

async function unlockHorn() {
    const ctx = hornContext();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch (err) { /* still blocked - pill stays up */ }
    }
    return ctx.state === 'running';
}

// Whether a game -> not-game transition deserves the horn. A round that
// was left running when the app was closed gets force-ended by the
// server's scheduler seconds after the next launch - a real transition,
// but for a round that finished hours ago, and it made opening the app
// sound the horn. Only a round whose scheduled end is recent (or still
// in the future - staff ending it early by hand) counts as "just ended".
const HORN_STALE_AFTER_MS = 90000;
function roundJustEnded(previousEndsAt) {
    if (!previousEndsAt) return true;
    const endsAt = new Date(`${previousEndsAt.replace(' ', 'T')}Z`).getTime();
    return Date.now() - endsAt < HORN_STALE_AFTER_MS;
}

// The club's own sound, if one is uploaded. Call with the club-settings
// object a page already has (same idiom as applyBranding) - and again when
// a 'club_settings' event arrives, so a new upload is picked up without a
// reload. club_horn_ver > 0 means a custom sound is in use. The file is
// fetched and decoded up front (decoding works even while audio is still
// blocked), so the round-end moment has nothing left to load.
const CUSTOM_HORN_MAX_SECONDS = 15;
let clubHornVer = 0;
let clubHornBuffer = null;

async function setClubHorn(clubSettings) {
    const ver = Number(clubSettings?.club_horn_ver) || 0;
    if (ver === clubHornVer) return clubHornBuffer !== null;
    clubHornVer = ver;
    clubHornBuffer = null;
    if (ver <= 0) return false;
    try {
        const ctx = hornContext();
        if (!ctx) return false;
        const res = await fetch(`/api/branding/horn?v=${ver}`);
        if (!res.ok) return false;
        const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
        if (clubHornVer === ver) clubHornBuffer = decoded; // a newer upload may have landed meanwhile
    } catch (err) {
        clubHornBuffer = null; // unreadable file - the built-in horn still sounds
    }
    return clubHornBuffer !== null;
}

function usingClubHorn() {
    return clubHornBuffer !== null;
}

// The club's own sound if one is loaded, else a stadium-style two-tone
// blast (a minor third, like an air horn), ~1.4s. Pass { builtIn: true } to
// hear the built-in horn regardless (the Settings "test" buttons).
function playHorn(options = {}) {
    const ctx = hornContext();
    if (!ctx || ctx.state !== 'running') return false;
    if (clubHornBuffer && !options.builtIn) {
        const src = ctx.createBufferSource();
        src.buffer = clubHornBuffer;
        src.connect(ctx.destination);
        src.start(0, 0, CUSTOM_HORN_MAX_SECONDS); // a long upload is cut off, not played out over the next round
        return true;
    }
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.7, now + 0.04);
    master.gain.setValueAtTime(0.7, now + 1.15);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    master.connect(filter);
    filter.connect(ctx.destination);
    for (const freq of [392, 466]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.linearRampToValueAtTime(freq * 0.97, now + 1.4);
        osc.connect(master);
        osc.start(now);
        osc.stop(now + 1.45);
    }
    return true;
}

function hornBroadcastChannel() {
    if (hornChannel === null && 'BroadcastChannel' in window) {
        hornChannel = new BroadcastChannel(HORN_CHANNEL_NAME);
        hornChannel.onmessage = (e) => {
            if (e.data && e.data.type === 'display-horn-ready') lastDisplayHornSeen = Date.now();
        };
    }
    return hornChannel;
}

// Display screen: call once; keeps telling other screens "I've got the horn"
// for as long as this window is open AND audio is actually unlocked here -
// a Display window that can't make a sound shouldn't silence the Rounds page.
function startDisplayHornHeartbeat() {
    const channel = hornBroadcastChannel();
    if (!channel) return;
    setInterval(() => {
        if (hornUnlocked()) channel.postMessage({ type: 'display-horn-ready', at: Date.now() });
    }, HORN_HEARTBEAT_MS);
}

// Rounds page: true while a Display window on this machine is sounding horns.
function displayScreenHandlesHorn() {
    hornBroadcastChannel();
    return Date.now() - lastDisplayHornSeen < HORN_OWNER_TIMEOUT_MS;
}

// Shows pillEl while audio is blocked; any click on the page (or the pill
// itself) tries to unlock, and the pill goes away once it succeeds.
function wireHornUnlockPill(pillEl) {
    const refresh = async () => {
        await unlockHorn();
        pillEl.style.display = hornUnlocked() ? 'none' : '';
    };
    document.addEventListener('click', refresh, true);
    document.addEventListener('keydown', refresh, true);
    refresh();
    // Some browsers flip to running a moment after load without a gesture
    // (e.g. with the autoplay flag) - re-check once so the pill doesn't
    // linger for no reason.
    setTimeout(refresh, 1500);
}
