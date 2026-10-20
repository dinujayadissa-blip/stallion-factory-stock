@echo off
rem Used by the "Factory Stock" start-at-boot task (see install-autostart.ps1). Runs the app with
rem no window, writes everything it prints to logs\server.log, and starts it again if it stops
rem because of an error. Stops for good if the app exits normally (for example because it is
rem already running).
cd /d "%~dp0.."
if not exist logs mkdir logs
set NODE_ENV=production
set NODE=node
if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"

:start
rem Keep the log from growing forever: over about 5 MB it becomes server.old.log.
if exist logs\server.log for %%F in (logs\server.log) do if %%~zF GTR 5000000 move /y logs\server.log logs\server.old.log >nul
%NODE% server.js >> logs\server.log 2>&1
if "%ERRORLEVEL%"=="0" goto :eof
echo %DATE% %TIME%  Factory Stock stopped (code %ERRORLEVEL%) - starting it again in 5 seconds >> logs\server.log
rem (ping is used as a 5 second wait because "timeout" doesn't work without a window)
ping -n 6 127.0.0.1 >nul
goto start
