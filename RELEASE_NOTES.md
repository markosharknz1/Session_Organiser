## Game Scheduler v1.0.16

**If you are on v1.0.15, please upgrade** - its Settings page is broken (see the first fix below).

### Installing

1. Download **`GameScheduler-v1.0.16.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **Fixed: Settings windows squashed under the left-hand menu.** In v1.0.15, Session templates, Courts, Skill compatibility, Email, Payments and Payment categories opened as a narrow strip beneath the menu instead of beside it. One stray tag in the page was the cause. The release build now checks every page's structure so this can't ship again. On a narrow window the menu also no longer sits on top of the content while scrolling.
- **Access PIN for other devices.** If you let a second computer or a TV connect (Settings > Club details > **Other computers**), every other device must now enter the club's PIN once before it can open anything; it then stays signed in until the PIN is changed or you click *Sign out other devices now*. This computer is never asked. **If you already had "Allow other devices" turned on, set a PIN on that page after upgrading - other devices are refused until one exists.** Five wrong guesses lock a device out for 30 seconds, doubling each time.
- **A shortcut in the app folder.** The install folder now always contains its own **Game Scheduler** shortcut with the club icon - double-click it there, or copy it to the taskbar, Start menu or another desktop. It is put back automatically if deleted.

### Notes

- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
- For a second computer, get the Companion at https://github.com/markosharknz1/Session_Organiser_Companion/releases/latest
