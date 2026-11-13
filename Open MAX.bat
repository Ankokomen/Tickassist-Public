@echo off
REM Opens MAX in Chrome or Edge in a window TickAssist can read even when it is
REM minimized or behind other windows. Sign in to MAX there once.
setlocal
cd /d "%~dp0"
if exist "%~dp0installed.txt" set "TICKASSIST_DATA=%APPDATA%\TickAssist"
if exist "%~dp0runtime\python.exe" (
    "%~dp0runtime\python.exe" "%~dp0app\server.py" --open-max
) else (
    where py >nul 2>nul && (py -3 "%~dp0app\server.py" --open-max) || (python "%~dp0app\server.py" --open-max)
)
if errorlevel 1 pause
