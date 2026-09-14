# Game Scheduler

> **Is this safe to download?** Nothing in it was compiled by this project.
> The download is the source code you can read here, packaged by GitHub
> Actions straight from the tagged commit - nothing is built or uploaded from
> a personal computer - plus the official Node.js runtime from nodejs.org
> (checksum-verified by the workflow, signed by the OpenJS Foundation). It
> opens in the Microsoft Edge (or Chrome) already on your computer. Each
> [release page](https://github.com/markosharknz1/Session_Organiser/releases/latest)
> shows the exact commit, the packaging log, a SHA-256 checksum, and a
> **VirusTotal scan** of the ZIP. You can also drop the download, or this
> repository's address, into [virustotal.com](https://www.virustotal.com/)
> yourself. The app keeps all data on your own computer and makes no
> connections of its own - see [SECURITY.md](SECURITY.md) for exactly what it
> does.

A local desktop app for running a club's social session on courts - any sport
played as doubles or singles with a rotation of players: check players in,
take payments, put together the rounds (by hand or automatically, with skill
grades and gender-aware pairing), run the round timer with a horn, show the
courts on a TV, and keep the session's history and totals.

It doesn't have to run your courts at all. A session can be started in
**Social mode**, which is check-in and payment only - no rounds, no timer -
so a club can use it purely to record who came, what they paid, and the
night's totals, and still get the payment history, per-session counts, trends
and the emailed end-of-night summary.

Everything runs on the club's own computer. There are no accounts, no cloud,
and no data leaves the machine - see [SECURITY.md](SECURITY.md) for the full
picture.

## Install

1. Download `GameScheduler-vX.Y.Z.zip` from the
   [latest release](https://github.com/markosharknz1/Session_Organiser/releases/latest).
2. **Before extracting it**, right-click the ZIP > **Properties** > tick
   **Unblock** > **OK**. This tells Windows the download is one you trust.
   (Skip it and Windows shows a warning on first run - or, on a Windows 11 PC
   with Smart App Control on, refuses to run anything from the ZIP at all. See
   [SECURITY.md](SECURITY.md#windows-warnings-you-may-see).)
3. Extract it anywhere - it's only the download - and double-click
   **`Game Scheduler.cmd`** inside the extracted folder.

A setup window appears the first time: choose where to install (the default
is `C:\Apps\Game_Scheduler`; **not your Documents folder or anything
OneDrive syncs** - the live database changes constantly and syncing corrupts
it; backups go to `Documents\GameScheduler\backups` on their own), tick
whether you want a desktop shortcut, and click **Install and start**. Setup
copies the app there, creates the database, and opens the app. Nothing is
downloaded or installed on the computer - the app and its Node.js runtime are
all in the ZIP - and no admin rights are needed. You can delete the downloaded
folder afterwards; use the desktop shortcut from then on.

The app opens in its own window using the Microsoft Edge that comes with
Windows (or Chrome), with no address bar or tabs. Closing that window stops
the app.

**Upgrading:** extract the new ZIP, run its `Game Scheduler.cmd`, and choose
the folder the app is already installed in - it's upgraded in place and your
database (`game_scheduler.db`, the club's entire roster and history) is kept.

## Setting up a club

Open **Settings** (left menu):

- **Club details** - name and icon, date format, game/changeover lengths,
  whether to track payments, and your payment categories (Member, Non-Member,
  Concession, ...). A fresh install has no categories; add your own.
- **Courts** - which court numbers the venue has.
- **Session templates** - your regular nights: day, time, mode, format
  (doubles, or singles for a sport like squash - auto-generated rounds follow
  it), courts, prices.
- **Email** (optional) - SMTP2Go, Mailgun or Gmail for the end-of-night
  summary.

Players can be bulk-imported from a CSV on the Player Database page - there's a
"Download CSV template" button with the exact columns.

## Verifying a download

Releases are packaged by GitHub Actions from the tagged source. Each release
page lists the commit, the packaging log, a SHA-256 checksum, and a VirusTotal
scan. Details in [SECURITY.md](SECURITY.md#verifying-a-download).

## Running from source

Requires [Node.js](https://nodejs.org) (LTS) - a checkout has no `node`
folder, so `Game Scheduler.cmd` uses the Node.js installed on the computer.
No install step - dependencies are committed. Either double-click
`Game Scheduler.cmd`, or run the server on its own and use any browser:

```
node server.js
```

then open http://localhost:4000. `Stop.bat` stops a server the launcher
started.

Tests: `npm run csv:test`, `npm run autogen:test`, `npm run report:test`,
`npm run roundbuilder:test`, `npm run launcher:test`.

## License

[MIT](LICENSE).
