// GET /api/about - what the Settings > About page shows: version, when
// this build was released, and where to get help. A release ZIP carries
// build-info.json (written by .github/workflows/release.yml alongside the
// tagged source); a plain checkout has none, so it reads as a
// development build of the package.json version.
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const ROOT = path.join(__dirname, '..');
const CONTACT_EMAIL = 'markosharkau@gmail.com';
const REPO_URL = 'https://github.com/markosharknz1/Session_Organiser';

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

module.exports = router;
