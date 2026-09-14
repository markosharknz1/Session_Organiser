@echo off
REM Game Scheduler - double-click to start. Hands straight over to Node.js
REM (the official runtime in this folder's node\ subfolder - or, if that's
REM missing, the Node.js installed on this computer) running launcher.js:
REM first-run setup, then the app in its own window. conhost --headless
REM gives it no console window; this window closes immediately.
REM
REM This is the only script in the download. Everything else is run by
REM node.exe (signed by the OpenJS Foundation) and the Microsoft Edge or
REM Google Chrome already on the computer.
setlocal
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" (
    echo Game Scheduler needs Node.js, and neither the node\ folder of this
    echo download nor an installed Node.js was found.
    echo.
    echo Download the full GameScheduler ZIP from the Releases page, or
    echo install Node.js LTS from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)
start "" "%SystemRoot%\System32\conhost.exe" --headless "%NODE%" "%~dp0launcher.js"
