## Game Scheduler v1.0.18

### Installing

1. Download **`GameScheduler-v1.0.18.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **A player who leaves comes off the courts ahead - with a red box where they were.** Marking someone as leaving now takes them off every court that hasn't been played yet. Their place shows as their name, struck through, in a red box, and the court is flagged *needs a player* - on saved courts, on courts you're still building, and in the *Up next* panel. Drop a replacement in and the box goes. Courts already on court or played are never touched.
- **"I'm off after the next one."** *Left early* now asks **when**: now, after the round on court, or after the next round. Pick a round and the player stays on the list and on their court until that round ends (a red *leaving after R*N tag beside their name), can't be put on a later court by hand or by auto-generate, and is marked as having left early the moment that round finishes. Right-click > *Staying after all* undoes it.
- **Break for 1 game.** Right-click a player - on court, in the player pool, on a court being built, or on their Check-in row - and choose *Break for 1 game*. They sit out the next round: off that round's court (their place shown in an amber box), skipped by auto-generate, and listed under **On break this round** at the bottom of the player pool in their own look. *Back in play* ends the break early; otherwise it ends by itself once the round has been played.
- **Right-click works on the Rounds page.** The same *Leaving / remove...* menu and box as the Check-in page, on names in the player pool, on courts being built and on the courts playing now or up next.
- **A note about today when you start the session.** The start panel asks *Anything to note about today?* - Club Champs, public holiday, school holidays. It's kept as the session's notes (so it goes out with the emailed tally and can be edited with the Notes button) and History shows it under the session, so an unusual night's numbers come with their explanation.

### Notes

- A second computer signed in with the check-in PIN gets the *after round N* choice, the break, and the start-of-day note too.
- In auto mode, if a player leaves during the break after the next round has already been generated, that court is left one short and the round waits until someone fills it (as before) - the red box now shows you where.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
