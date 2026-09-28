## Game Scheduler v1.0.14

### Installing

1. Download **`GameScheduler-v1.0.14.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. This tells Windows the download is one you trust; without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP at all, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Setup copies the app to that folder, prepares the database, and opens the app. Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards; use the desktop shortcut from then on.

**Upgrading from v1.0.13:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept. Upgrading from anything older: same, but if your existing copy is in your Documents folder, choose a new location and copy `game_scheduler.db` across from the old folder before launching.

### What's new

- **Fair rotation when more people than courts.** At a 50-player, 7-court night the same four A-graders played every round while everyone else waited for every second one, and kept landing on a court together. The spare slots after the sat-out players are now filled by whoever has had the fewest games tonight (sat-out priority and the women/men balance are unchanged), and a court whose four just played together is broken up next round. Over 8 simulated rounds everyone now gets 4 or 5 games instead of 4 for most and 8 for a few.
- **Games played tonight beside each name** on the Rounds page's "Currently on court" and "Up next" cards - `Alex Nguyen A (3)` means this is their third game.
- **Grade and gender badges are easier to read** - solid coloured chips with white letters (A red, B orange, C amber, D green, E blue; M blue, F pink) instead of pale fills.
- **Right-click a checked-in player** on the Check-in page to **change their payment** (category, amount, cash/card/voucher) if it was keyed wrong, or remove them from today. Right-click a booked player to mark them arrived or cancel the booking.
- **Settings > About** - version, release date, contact email and the project website.

### Notes

- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
