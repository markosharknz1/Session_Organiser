## Game Scheduler v1.0.17

### Installing

1. Download **`GameScheduler-v1.0.17.zip`** below.
2. **Before extracting it:** right-click the ZIP > **Properties** > tick **Unblock** (bottom right) > **OK**. Without it, a Windows 11 PC with Smart App Control turned on refuses to run anything from the ZIP, and other PCs show a warning.
3. Extract the ZIP anywhere - it's only the download - and double-click **`Game Scheduler.cmd`** inside the extracted folder.
4. A setup window opens: choose where to install (the default is `C:\Apps\Game_Scheduler` - anywhere is fine **except your Documents folder or anything OneDrive syncs**), tick whether you want a desktop shortcut, and click **Install and start**.

Nothing is downloaded and nothing is installed on the computer - the app and its Node.js runtime are all in the ZIP. You can delete the downloaded folder afterwards.

**Upgrading:** run the new `Game Scheduler.cmd` and choose the folder your existing copy is in (`C:\Apps\Game_Scheduler` unless you changed it) - it's upgraded in place and your `game_scheduler.db` (the club's entire roster and history) is kept.

### What's new

- **Email a report from History.** *Email a report...* (or *Email this session's tally...* inside a session) sends a tally to any address you type, for one session or a whole month: payments by category and by cash/card/voucher, how many were pre-booked against how many arrived on the day, who left injured or early, session notes, and the list of players with grade, booking and payment. The box shows exactly what will be sent before you send it.
- **Say why a player is leaving.** Double-clicking a checked-in player on the Check-in page (or right-click > *Leaving / remove...*) now asks: **Left early** (the default), **Left injured**, or **Checked in by mistake**. The first two keep them in the night's count with their payment; the third clears the payment details and takes them out of the night. Choosing *Left injured* lets you note what happened.
- **Injury log.** History lists every injury with its date, session, player and note; click a note to add to it later. Injury notes also appear in the emailed reports.
- **Restore a backup from inside the app.** Player Database > Database backups: **Restore** beside any backup, or **Restore from a file...** for a database kept elsewhere (also how to move the club to a new computer). It shows what's in the backup, saves your current data as one more backup first so a restore can be undone, and only works on the main computer.
- **Backups include the club icon and round-end sound.** Each backup now carries them, and a restore puts them back as they were. Backups made by earlier versions restore the data and leave the current icon and sound alone.
- **A check-in PIN.** Settings > Club details > Other computers now has two PINs. A device that signs in with the **check-in PIN** can start the day's session, check players in, book them, take payments, mark people as leaving and show the External Display - and nothing else: no Settings, player database, history, rounds or finishing the session, and it never receives the club's email passwords. The **full access PIN** works as before. The two must differ.
- **Email settings show a Default flag per provider.** One tab each for SMTP2Go, Mailgun and Gmail, with the vendor's website and what each needs (SMTP2Go and Mailgun: the club's own domain and access to its DNS; Gmail: 2-Step Verification and an App Password). Fill in more than one; the one flagged Default is used to send.

### Notes

- Pre-booked figures and the leaving reasons start from this version - earlier sessions show arrivals as "on the day" and no leavers.
- Your roster and history live in one local file (`game_scheduler.db`) - not included in this release, but backed up automatically to `Documents\GameScheduler\backups` every time the app opens.
