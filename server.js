const express = require('express');
const os = require('os');
const path = require('path');
const store = require('./db/store');

const playersRouter = require('./routes/players');
const sessionsRouter = require('./routes/sessions');
const attendanceRouter = require('./routes/attendance');
const courtsRouter = require('./routes/courts');
const clubSettingsRouter = require('./routes/clubSettings');
const sessionTemplatesRouter = require('./routes/sessionTemplates');
const eventsRouter = require('./routes/events');
const gamesRouter = require('./routes/games');
const roundsRouter = require('./routes/rounds');
const displayRouter = require('./routes/display');
const skillCompatibilityRouter = require('./routes/skillCompatibility');
const historyRouter = require('./routes/history');
const exportRouter = require('./routes/export');
const paymentCategoriesRouter = require('./routes/paymentCategories');
const backupRouter = require('./routes/backup');
const brandingRouter = require('./routes/branding');
const launcherRouter = require('./routes/launcher');
const scheduler = require('./lib/scheduler');

const PORT = process.env.PORT || 4000;

function localNetworkAddresses() {
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
        }
    }
    return addrs;
}

async function main() {
    await store.init();

    const app = express();
    app.use(express.json());

    app.get('/api/health', (req, res) => res.json({ ok: true }));

    app.use('/api/players', playersRouter);
    app.use('/api/sessions', sessionsRouter);
    app.use('/api', attendanceRouter);
    app.use('/api/courts', courtsRouter);
    app.use('/api/club-settings', clubSettingsRouter);
    app.use('/api/session-templates', sessionTemplatesRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api', gamesRouter);
    app.use('/api', roundsRouter);
    app.use('/api', displayRouter);
    app.use('/api/skill-compatibility', skillCompatibilityRouter);
    app.use('/api/history', historyRouter);
    app.use('/api/export', exportRouter);
    app.use('/api/payment-categories', paymentCategoriesRouter);
    app.use('/api/backup', backupRouter);
    app.use('/api/branding', brandingRouter);
    app.use('/api/launcher', launcherRouter);

    // sw.js's own network-first fetch handler only helps once it's actually
    // running the latest version of itself - if the browser's ordinary HTTP
    // cache serves a stale copy of the *script file* on registration/update,
    // the whole "always get fresh files" mechanism silently reinstalls its
    // own old self forever. Force every fetch of sw.js to revalidate.
    app.get('/sw.js', (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(__dirname, 'public', 'sw.js'));
    });

    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/', (req, res) => res.redirect('/checkin.html'));

    app.use((err, req, res, next) => {
        console.error(err);
        res.status(400).json({ error: err.message });
    });

    // This computer only (127.0.0.1) unless the club has turned on network
    // access in Settings > Club details > Game defaults. Listening on every
    // interface is what makes Windows pop its "allow Node.js JavaScript
    // Runtime through the firewall" security alert the first time the app
    // runs - alarming on a club computer, and unnecessary unless the
    // External Display is going to be opened on another device. Read once
    // here; changing the setting takes effect at the next start.
    const club = store.queryOne('SELECT allow_network_access FROM club_settings WHERE id = 1');
    const allowNetwork = process.env.GAME_SCHEDULER_HOST ? process.env.GAME_SCHEDULER_HOST !== '127.0.0.1' : !!(club && club.allow_network_access);
    const host = process.env.GAME_SCHEDULER_HOST || (allowNetwork ? '0.0.0.0' : '127.0.0.1');
    app.listen(PORT, host, () => {
        console.log(`Game Scheduler API listening on ${host}:${PORT}`);
        console.log(`  Local:   http://localhost:${PORT}`);
        if (allowNetwork) {
            for (const addr of localNetworkAddresses()) {
                console.log(`  Network: http://${addr}:${PORT}`);
            }
        } else {
            console.log('  Network: off (Settings > Club details > Game defaults to allow other devices)');
        }
    });

    scheduler.start();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
