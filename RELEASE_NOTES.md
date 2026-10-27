## Game Scheduler v1.0.20

### Installing

1. Download **`GameScheduler-v1.0.20.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **Game results - optional.** Settings > Game defaults > *Record game results* sets the default for a new tick on the start-of-day panel, *Record game results tonight*, so Club Champs can record and social Friday can skip it. On a recording night each court on the Rounds page gets a **Won** button under each side once the game is on court or played; tap again to clear. "2 of 5 results entered" is a reminder, never a gate. Threes (no sides) is left out. Nothing changes a grade and auto-generate ignores results - it is evidence for the club's own grading decisions.
- **Scores, any number of games per court.** Under the Won buttons, a pair of score boxes per game (G1, G2, ...) with a spare pair for the next - a timed round often fits more than one game. The winner follows from the scores (more games won, then more points); if that's level the Won buttons decide, and they carry the typed scores with them. Scores are not capped at 21.
- **History shows it.** A recorded night's round shows the same buttons and boxes (fill it in the next day if you like), the winning pair in bold, and each player's page gets Won / Lost totals and a Result column - `W 21-18, 19-21, 21-15` with their own side first.
- **Committee report.** History > *Committee report*: pick a date range and get sessions held, attendances, different players, average per session, the membership split, how many players were new (first ever session in the range) and how many of them came back - 1 session only, 2-3, 4-5, 6 or more - plus one row per player with sessions attended, matches played, won and lost. Counts only, no dates per player. **Download CSV** for the committee pack.
- **Try another mix.** After *Auto-generate round* on the Rounds page, a *Try another mix* button re-rolls the courts auto-generate just filled with a fresh shuffle. The fairness rules - who sat out, who has had the fewest games, grades, avoid pairs - are untouched; only the tiebreaks and court order change. (Running auto-generate twice used to give the identical lineup.)
- The *Round played* panel now stays on the round you're looking at across refreshes, so last round's scores can be typed in while the next round is on court.

### Notes

- Results entry is on the main computer; a device signed in with the check-in PIN sees the start-of-day tick but does not record results.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
