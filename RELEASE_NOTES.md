## Game Scheduler v1.0.23

An end-of-night summary, a list of regulars who have stopped coming, players in first-name order, and two new settings for how long auto-generate remembers who played with whom.

### Installing

1. Download **`GameScheduler-v1.0.23.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **End-of-night summary.** The box that appears when you click **Finish session** used to show the payment totals only. It now tells the whole night in one look:
  - **Players** - how many came and how that compares with the usual turnout for that session, visitors and new members, who left early, any injuries, and bookings that never arrived.
  - **Play** - rounds, games and courts used, how evenly the games were shared among the people who stayed to the end (and who had the fewest), and how many results were entered.
  - **Takings** - by category, and by cash, card and voucher, when the club records payments.

  The same summary can be opened for any past night: open the session on the **History** page and click **End-of-night summary**. The emailed summary carries the same Players and Play lines.
- **Lapsed players.** A new panel on the **History** page lists regulars who have stopped coming - when they were last in, how many weeks ago, how regular they were when they stopped, and their phone and email. Three settings decide who counts: not seen for so many weeks (4), came to at least so many sessions (3), and last came within so many months (12). Click a row for that player's history, or **Download CSV** to take the list away. It is worked out from the sessions people actually came to, not from the membership status on their record.
- **Players in first-name order.** First name is now the order everywhere - Check-in, Player Database, the Rounds pool, the display, reports and tallies. The **Surname / First name** switch on Check-in and Player Database is still there if you prefer surname, and the Rounds pool now follows it too (it used to ignore it). Because the default changed, the switch starts on First name after this upgrade even if you had set it to Surname before.
- **How long auto-generate remembers.** Auto-generate tries not to give a player the same partner, or the same people on court, as in recent rounds. That memory was fixed at 4 rounds. It is now two settings on each session template: **Rounds before the same partner** and **Rounds before the same players on court** (0 to 20; 0 turns that rule off). Both can be changed for one night from **Need to change something?** when starting a session, and they are on the one-off session form too.

### Notes

- The two memory settings make repeats less likely, not impossible. Grade compatibility and gender-aware pairing still come first, so on a small night, or one with only a couple of players in a grade, some pairs will meet again sooner than the setting asks.
- Existing templates and sessions keep behaving as before: both settings start at 4.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
