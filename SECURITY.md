# Security and privacy

Game Scheduler is a local desktop app for running a club's session night. It is
built to keep a club's data on the club's own computer. This page says exactly
what it does and doesn't do, so you can judge that for yourself.

## Where your data lives

- **One file.** Every player, session, game and payment record is in
  `game_scheduler.db` (an SQLite database) in the folder you run the app from.
  Nothing is stored anywhere else, and nothing is sent anywhere.
- **Backups.** Each time the app opens it copies that file to
  `Documents\GameScheduler\backups` on the same computer (newest 30 kept).
- **Not encrypted.** The database holds personal details - names, dates of
  birth, contact details, and any email credentials you enter in Settings - in
  plain form. Treat the computer and its backups the way you'd treat a
  membership spreadsheet: keep the login protected and don't share the folder.

## What connects to the internet

The app makes **no** network connections of its own - no accounts, no cloud
sync, no analytics, no update checks, and nothing is downloaded or installed
during setup (the Node.js runtime it needs is in the ZIP). The only outbound
traffic is **sending the end-of-night summary email**, only when you click
*Send*, to whichever provider you configured in Settings (SMTP2Go, Mailgun, or
Gmail). Nothing is ever sent automatically.

The server the app starts listens on port 4000. It binds to all interfaces so a
second screen on the same network (the External Display on a TV) can reach it,
but it has no authentication - it is meant for a club's own private network,
not the public internet.

## What's in the download, and what runs

Nothing in a release was compiled by this project. The ZIP holds:

- **The app's source code**, exactly as you can read it in this repository,
  packaged by GitHub Actions straight from the tagged commit - not on a
  personal machine.
- **The official Node.js runtime for Windows** in the `node` folder
  (`node.exe`, unchanged from nodejs.org, and its licence). The release
  workflow downloads it from `nodejs.org/dist` and verifies it against the
  `SHASUMS256.txt` nodejs.org publishes; `node\README.txt` and the release
  page carry its version and SHA-256. It is signed by the OpenJS Foundation:
  right-click `node.exe` > Properties > Digital Signatures.
- **Two one-screen batch files** you can open in Notepad: `Game Scheduler.cmd`
  (starts the app) and `Stop.bat` (stops the server). There is no PowerShell
  and no Windows Script Host anywhere in the app - the launcher, the setup
  screen, and even the desktop shortcut are all done by plain Node.js code
  (`launcher.js`, `launcher/setup.html`, `lib/`).

`Game Scheduler.cmd` runs `node.exe launcher.js`. That starts the app's local
server (`server.js`) and opens the app in a window of the Microsoft Edge or
Google Chrome already on the computer - a chromeless "app window" with its own
browser profile kept next to the app. Closing the window stops the server.

## Windows warnings you may see

Everything in the ZIP is marked by Windows as "downloaded from the internet",
so the first run of `Game Scheduler.cmd` can trigger one of these:

- **"Open File - Security Warning"** - click *Run*.
- **"Windows protected your PC"** (Microsoft Defender SmartScreen, for a file
  it hasn't seen before) - click *More info* > *Run anyway*.
- **"Smart App Control blocked an app that may be unsafe"** (Windows 11 PCs
  with Smart App Control on) - this blocks any `.cmd` file that came from the
  internet and can't be bypassed for a single file. Delete the extracted
  folder, then right-click the ZIP > *Properties* > tick *Unblock* > *OK*, and
  extract it again. An unblocked download isn't "from the internet" any more.

Setup removes that mark from every file it installs, so the installed copy
(and its desktop shortcut) never trigger these again.

## Verifying a download

Each release page shows the commit it was built from, a link to the
packaging log, a SHA-256 checksum of the ZIP and of `node.exe`, and a
VirusTotal scan of the ZIP. To check a download on Windows:

```powershell
Get-FileHash .\GameScheduler-v1.2.3.zip -Algorithm SHA256
```

and compare against `SHA256SUMS.txt` on the release page.

(Earlier releases shipped a packaged `.exe`, and then a PowerShell setup
script; antivirus heuristics flagged the first purely for being a
self-extracting bundle, and Smart App Control blocks the second outright.
That's why neither exists any more.)

## Reporting a problem

Open an issue on this repository, or email the maintainer via the address on
the GitHub profile. Please include what you saw and how to reproduce it.
