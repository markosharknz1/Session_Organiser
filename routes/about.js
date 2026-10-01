// GET /api/about - what the Settings > About page shows: version, when
// this build was released, and where to get help. A release ZIP carries
// build-info.json (written by .github/workflows/release.yml alongside the
// tagged source); a plain checkout has none, so it reads as a
// development build of the package.json version.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../db/store');

const router = express.Router();
const ROOT = path.join(__dirname, '..');
const CONTACT_EMAIL = 'markosharkau@gmail.com';
const REPO_URL = 'https://github.com/markosharknz1/Session_Organiser';
// The small launcher a club puts on a second computer (check-in desk, TV)
// - it opens THIS computer's Game Scheduler over the club network. It has
// no database of its own; this one stays the only copy.
const COMPANION_URL = 'https://github.com/markosharknz1/Session_Organiser_Companion';

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

router.get('/', (req, res) => {
    const pkg = readJson(path.join(ROOT, 'package.json')) || {};
    const build = readJson(path.join(ROOT, 'build-info.json'));
    res.json({
        name: 'Game Scheduler',
        version: (build && build.version) || pkg.version || 'unknown',
        released: build ? build.released : null,   // YYYY-MM-DD, null for a dev checkout
        commit: build ? build.commit : null,
        development_build: !build,
        contact_email: CONTACT_EMAIL,
        repo_url: REPO_URL,
        releases_url: `${REPO_URL}/releases`,
        node_version: process.version,
    });
});

// GET /api/about/network - for Settings > Club details > Other computers:
// whether other devices are allowed in, whether that is live yet (the
// server only binds to the network at start-up), and what to type into the
// companion on the other computer.
router.get('/network', (req, res) => {
    const club = store.queryOne('SELECT allow_network_access, access_pin_hash FROM club_settings WHERE id = 1');
    const addresses = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
        }
    }
    res.json({
        allowed: !!(club && club.allow_network_access),
        pin_set: !!(club && club.access_pin_hash),
        listening: !!req.app.locals.listeningOnNetwork,
        port: Number(process.env.PORT) || 4000,
        computer_name: os.hostname(),
        addresses,
        companion_url: COMPANION_URL,
        companion_releases_url: `${COMPANION_URL}/releases/latest`,
    });
});

module.exports = router;
