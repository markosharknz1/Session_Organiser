## Game Scheduler v1.0.21

### Installing

1. Download **`GameScheduler-v1.0.21.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **Plays every 2nd game.** For players who want a rest after each game - older players pacing themselves. Tick it in the check-in box and, each time a round they are in goes on court, they sit out the next round: they can't be put on a court for it, auto-generate leaves them out of it, and they are back in the pool the round after. A blue *every 2nd game* tag shows beside their name on Check-in and Rounds. Right-click them on either page to switch it on or off part-way through the night. It is remembered the same way the payment category is: next week's check-in starts from whatever they did last time.
- **Sport / scoring.** Settings > Game defaults > *Sport / scoring* says what the club plays - badminton (to 21), squash (11 or 9), racquetball (15), table tennis (11), pickleball (11), tennis (sets to 6), or points only. It names the score rows (G1 or S1) and fills in the winner's score when just the loser's is typed (18 becomes 21-18, 7 becomes 11-7). Session templates follow it unless one plays something else; a one-off night starts from it too. Who wins is unchanged: more games or sets won, then more points, then the Won button.
- **Game results are now a switch.** Settings > Game defaults > *Record game results and scores* turns the whole feature on or off, the same way payment tracking does. Off, nothing about results appears anywhere. On, the start-of-day panel has a *Record game results tonight* tick (ticked by default - untick it for a night you can't be bothered), the templates get their Scoring choice, and the Rounds page gets the Won buttons and score boxes.
- **Winner only.** A scoring choice with no score boxes at all - just the Won buttons - for a club that wants a win-loss record without typing scores.
- **Threes records results too.** Three in a box (squash style) gets a score row per pair of players with a spare for the next game between them, and a Won button per player. The box winner follows from most games won, then points difference. History shows the box winner in bold and each player's page reads `W v Bob 11-7, v Cy 9-11`. Win-loss records count boxes like matches.

### Notes

- Upgrading rebuilds the game results table once on first start (existing results are kept) so threes results fit.
- Results entry is on the main computer; a device signed in with the check-in PIN sees the start-of-day tick but does not record results.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
