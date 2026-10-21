## Game Scheduler v1.0.19

### Installing

1. Download **`GameScheduler-v1.0.19.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **Right-click a player on the Check-in page to edit them.** *Edit player...* on all three tables - not yet here, Here, and Booked - opens a small box for first and last name, grade, gender and membership status, so a wrong grade spotted on the Here list or a misspelt name is fixed on the spot, without starting a check-in. The row (and tonight's courts) update straight away. Contact details and notes stay in the Player Database.
- The not-yet-here table's right-click menu also offers *Arrived - check in...* and *Book for today*.

### Notes

- A second computer signed in with the check-in PIN can edit players this way too (it already could from the check-in box).
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
