## Game Scheduler v1.0.15

### Installing

1. Download **`GameScheduler-v1.0.15.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards; use the desktop shortcut from then on.

**Upgrading from v1.0.13 or v1.0.14:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept. The first start after upgrading makes a small one-time change to the database so it can record the new Threes format; it has been checked against real club databases and keeps every row.

### What's new

- **Threes - three on a court, no sides.** For squash-style "three in the box" where three players take turns. Pick **Threes** as the Format on a session template (or when starting a session), alongside Doubles and Singles. The round builder shows one "On court" box of three, the TV display and history show the three names with no "versus", and auto-generate fills courts in threes - keeping grades as close as the players present allow (a repeat trio is avoided only by swaps that keep the courts just as tight), sat-out players first, fewest games tonight next, and never an avoid-pair on the same court. Singles sessions get the same grade-first grouping.
- **Your own round-end sound.** Settings > Club details > **Round-end sound**: upload a `.wav` (up to 5MB; anything over 15 seconds is cut off), hear it or the built-in horn, or go back to the built-in horn. An open Rounds page or TV display picks up a change straight away.
- **A second computer, or a TV, over the club network.** Settings > Club details > **Other computers** now holds the "allow other devices" switch, says whether it is active yet (it takes effect after a restart), shows this computer's name to type in, and links to the new **Game Scheduler Companion** - a small launcher for the second computer that opens this one's Game Scheduler in its own window. Nothing is copied: this computer keeps the only database, and a check-in on either screen appears on the other at once. While the switch is on, anyone on the same network can open the app, so use it on the club's own network. Get the Companion at https://github.com/markosharknz1/Session_Organiser_Companion/releases/latest
- **Player lists: choose the order.** The Check-in and Player Database lists were sorted by surname while showing first names first, which read as unsorted. Both now have a **Sort by: Surname / First name** switch (remembered on that computer), and sorting ignores case and stray spaces. Names are trimmed of spaces when saved, and any already stored with spaces around them are tidied on first start.

### Notes

- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
- An uploaded round-end sound is kept in the app folder (`public\sounds`), not in the database backup - keep a copy of the original file.
