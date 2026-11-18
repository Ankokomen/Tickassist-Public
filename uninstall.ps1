# TickAssist uninstaller. Run from the install folder (or Settings > Apps).
param([switch]$Quiet)
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath (Join-Path $Dir "app\server.py"))) {
    throw "$Dir is not a TickAssist folder - nothing was removed."
}
# A copy put in a folder of your choosing (the installer's -Dir) has no
# shortcuts, no entry in Settings > Apps and its data inside it: removing it
# must leave the installed copy's alone.
$installed = Test-Path -LiteralPath (Join-Path $Dir "installed.txt")

Write-Host ""
Write-Host "  Remove TickAssist from $Dir ?" -ForegroundColor Cyan
if (-not $Quiet) {
    $ok = Read-Host "  Type Y to continue"
    if ($ok.Trim().ToLower() -ne "y") { Write-Host "  Cancelled."; exit 0 }
}

$prefix = $Dir.TrimEnd("\") + "\"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($installed) {
    foreach ($folder in "Programs", "Desktop") {
        foreach ($link in "TickAssist.lnk", "TickAssist - Open MAX.lnk") {
            Remove-Item (Join-Path ([Environment]::GetFolderPath($folder)) $link) -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TickAssist" -Recurse -Force -ErrorAction SilentlyContinue
}

$data = Join-Path $env:APPDATA "TickAssist"
if ($installed -and (Test-Path $data) -and -not $Quiet) {
    $wipe = Read-Host "  Also delete your saved settings, lists and macros in $data ? (y/N)"
    if ($wipe.Trim().ToLower() -eq "y") { Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue }
}

# This script lives inside the folder it removes, so a helper deletes it after we exit.
$cmd = 'ping 127.0.0.1 -n 3 >nul & rmdir /s /q "{0}"' -f $Dir
# Started elsewhere: a folder that is someone's working directory cannot be removed.
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WindowStyle Hidden -WorkingDirectory $env:TEMP
Write-Host "  TickAssist was removed." -ForegroundColor Green
Write-Host "  To install it again, download the installer from https://github.com/Ankokomen/Tickassist-Public/releases/latest" -ForegroundColor Green
