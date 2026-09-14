## Game Scheduler v1.0.13

### Installing

1. Download **`GameScheduler-v1.0.13.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. This tells Windows the download is one you trust; without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP at all, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Setup copies the app to that folder, prepares the database, and opens the app. Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards; use the desktop shortcut from then on.

If you skipped step 2 and Windows says **"Windows protected your PC"**: click *More info* > *Run anyway*. If it says **"Smart App Control blocked an app that may be unsafe"**: delete the extracted folder, do step 2 on the ZIP, and extract it again - Smart App Control can't be bypassed for one file, but an unblocked download isn't "from the internet" any more.

**Upgrading from an earlier version:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept. If your existing copy is in your Documents folder, choose a new location and copy `game_scheduler.db` across from the old folder before launching.

### What's new

- **Installs on a locked-down Windows 11 PC.** v1.0.12 was blocked outright on a PC with Smart App Control on: it blocks any `.cmd`, `.lnk` or script that came from the internet, and runs PowerShell in a restricted mode that can't show a window - which is what the old setup screen was. The launcher is now plain Node.js from start to finish: no PowerShell at all, no Windows Script Host, nothing compiled by this project. The download's only scripts are two one-screen batch files (start and stop) you can read in Notepad.
- **The official Node.js runtime is in the ZIP** (`node\node.exe`, signed by the OpenJS Foundation; the release workflow downloads it from nodejs.org and checks it against nodejs.org's published checksums - see the *Verify this download* section below). Setup no longer needs winget, an internet connection, or admin rights.
- **The setup screen is a page in the app window** (Edge or Chrome) instead of a PowerShell window - install location, desktop-shortcut tickbox, and progress as it goes. The desktop shortcut is written by the app itself rather than by a script.
- Setup **removes the "downloaded from the internet" mark** from the installed files, so the installed copy never triggers Windows' download warnings again.
- Edge's "we're now syncing your browsing data" prompt no longer appears over the app on a PC signed in with a Microsoft account.
- Everything from v1.0.12 is unchanged: singles sessions, the Settings menu, one-round-at-a-time Rounds view, "Games played today", history filters and trends, the CSV import template.

### Notes

- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
- The ZIP is bigger than v1.0.12's because the Node.js runtime is in it.
