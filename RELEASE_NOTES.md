## Game Scheduler v1.0.22

**Please upgrade.** A recent Microsoft Edge update changed how Edge starts, and with it earlier versions of Game Scheduler can open their window and then stop working straight away. This release fixes that.

### Installing

1. Download **`GameScheduler-v1.0.22.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's fixed

- **The app stopping the moment it opened.** Newer versions of Microsoft Edge (seen with Edge 158, November 2026) start, hand their window to a second copy of themselves and exit. Game Scheduler took that as "the window was closed" and shut itself down behind a window that was still on screen - pages that would not load or save, a setup window whose *Install and start* did nothing, an error window with nothing in it. It now watches the browser itself rather than the process it started, so the app stays up for as long as any of its windows is open, and stops when the last one closes - on old and new Edge, and Chrome, alike.
- **"Game Scheduler could not start" on a computer that had only just been switched on.** The app was given 15 seconds to start and was stopped if it took longer, which a cold computer can. It now gets a minute.

### What's new

- **A window from the first second.** Double-click and the app's window opens straight away on a *Starting Game Scheduler* page, then becomes the app. No more wondering whether the click registered - and a second double-click while it is starting no longer starts a second copy.
- **A failed start says why.** If the app can't start, the same window says so, shows what the app itself reported, and has a **Try again** button. Starting it again from the shortcut does the same thing as the button.
- **The reason is kept.** Every failed start is written into `logs\run.log` in the app's folder with the app's own error, and the previous start's `server.err.log` is kept as `server.err.prev.log` rather than being wiped by the next start. If you ever need to send a log, `run.log` is the one.
- **Stopped under an open window?** If the app's server is stopped while a window is still open (Stop.bat, or a fault), starting Game Scheduler again now brings it back.

### Notes

- Nothing about the club's data changes in this release - it is all in how the app starts and stops.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
