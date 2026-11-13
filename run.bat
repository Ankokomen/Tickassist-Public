@echo off
REM ============================================================
REM  TickAssist - portable ticket handling tool
REM  Double-click to start. No installation, no admin rights.
REM  Runs from any location, including paths that contain spaces.
REM ============================================================
setlocal
cd /d "%~dp0"

REM An installed copy (made by the installer) keeps its data, settings and lists
REM in %APPDATA%\TickAssist so updating or reinstalling never touches them.
if exist "%~dp0installed.txt" set "TICKASSIST_DATA=%APPDATA%\TickAssist"

set "PY="
set "PYARGS="

REM 1) Prefer the vendored, self-contained runtime (no admin needed).
if exist "%~dp0runtime\python.exe" (
    set "PY=%~dp0runtime\python.exe"
    goto :launch
)

REM 2) Fall back to the Python launcher, if a real Python is installed.
where py >nul 2>nul && (
    set "PY=py"
    set "PYARGS=-3"
    goto :launch
)

REM 3) Fall back to python on PATH (skip the Microsoft Store stub).
for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | find /i "WindowsApps" >nul || set "PY=%%P"
)
if defined PY goto :launch

echo.
echo  ERROR: No Python runtime found next to this file ^(runtime\python.exe^).
echo  See README.md to restore the portable runtime.
echo.
pause
exit /b 1

:launch
echo Starting TickAssist...
REM Quote the executable so spaces in the folder path are handled; PYARGS is
REM only set for the "py" launcher and is empty otherwise.
"%PY%" %PYARGS% "%~dp0app\server.py" %*

REM Keep the window open if the server exits with an error.
if errorlevel 1 pause
endlocal
