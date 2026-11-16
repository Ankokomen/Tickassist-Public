# TickAssist window reader. watcher.py starts PowerShell with a line that
# loads this file; its settings arrive in environment variables, never
# spliced into this text.
#   TA_MATCH        regex a window title must match to be read
#   TA_TOAST        regex a notification's text must match
#   TA_URL          regex for a call page's address
#   TA_INTERVAL_MS  pause between scans
#   TA_OWN          the folder of the browser profile "Open MAX" uses, if any
#   TA_PARENT       the process id of the TickAssist that started this reader
# Writes one JSON line per scan to stdout.
#
# The reader ends with the TickAssist that started it. Windows does not end a
# child with its parent, and a window closed or a process stopped leaves no
# chance to tidy up - so the reader looks for its parent before every scan.
# Readers left behind would each keep scanning, and slow one another down.
#
# A scan has to stay well under a second, or a call is noticed late. So:
#   * windows are listed by Windows itself (titles and classes cost nothing),
#     and UI Automation - the interface screen readers use - is only asked
#     about the few that matter;
#   * of a matching browser window only the page (its Document) is read. The
#     browser's own frame - tabs, toolbar, side panels - can take seconds to
#     walk and holds nothing of MAX's. The page and each address bar are
#     found once and then just read;
#   * an address bar is only looked for in real browsers. Other programs
#     built on the same engine share the window class and have none, and
#     searching one for it can take seconds;
#   * a window of the browser "Open MAX" started is not read here at all:
#     TickAssist reads that browser from the inside (browser.py), which is
#     quicker and works minimized. It is only reported, as "own";
#   * notifications are not in Windows' list of windows, and asking UI
#     Automation for them takes a second or more. That runs on its own thread
#     and hands over what it last saw, so it never holds a scan up.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$All = [System.Windows.Automation.Condition]::TrueCondition
$CT = [System.Windows.Automation.ControlType]
$match = New-Object System.Text.RegularExpressions.Regex($env:TA_MATCH)
$urlMatch = New-Object System.Text.RegularExpressions.Regex($env:TA_URL)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace TA {
  public class Win {
    public IntPtr H; public string Title; public string Class; public uint Pid; public bool Min;
    delegate bool Each(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(Each cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    // Every visible top-level window that has a title.
    public static List<Win> List() {
      var found = new List<Win>();
      EnumWindows(delegate(IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        var t = new StringBuilder(512);
        if (GetWindowText(h, t, t.Capacity) <= 0) return true;
        var c = new StringBuilder(256);
        GetClassName(h, c, c.Capacity);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        found.Add(new Win { H = h, Title = t.ToString(), Class = c.ToString(), Pid = pid, Min = IsIconic(h) });
        return true;
      }, IntPtr.Zero);
      return found;
    }
  }
}
'@
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)
$docCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
$barCond = New-Object System.Windows.Automation.AndCondition($editCond,
  (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Address and search bar')))
$browsers = @('msedge', 'chrome', 'firefox', 'brave', 'vivaldi', 'opera', 'chromium')
$procNames = @{}     # process id -> name; a window's process never changes
$ownProcs = @{}      # process id -> whether it is the browser Open MAX started
$barOf = @{}         # window -> its address bar (or $null: it has none)
$pageOf = @{}        # window -> the page in it
function Test-Browser([uint32]$procId) {
  if (-not $procNames.ContainsKey($procId)) {
    $n = ''
    try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower() } catch {}
    if ($procNames.Count -gt 400) { $procNames.Clear() }
    $procNames[$procId] = $n
  }
  return $browsers -contains $procNames[$procId]
}
# Whether a browser process is the one "Open MAX" started: it runs on that
# profile folder, which is on its command line.
function Test-Own([uint32]$procId) {
  if (-not $env:TA_OWN) { return $false }
  if (-not $ownProcs.ContainsKey($procId)) {
    $line = ''
    try { $line = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch {}
    if ($ownProcs.Count -gt 400) { $ownProcs.Clear() }
    $ownProcs[$procId] = ($line.IndexOf($env:TA_OWN, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
  return $ownProcs[$procId]
}
# The names of everything under $root, one per line: what a screen reader
# would say. Throws if $root is gone.
function Read-Names($root, [int]$cap) {
  $sb = New-Object System.Text.StringBuilder
  $n = 0; $named = 0
  foreach ($e in $root.FindAll($Scope::Descendants, $All)) {
    if ($n++ -ge $cap) { break }
    try { $t = $e.Current.Name; if ($t) { $named++; [void]$sb.Append($t).Append("`n") } } catch {}
  }
  return @{ text = $sb.ToString(); named = $named }
}

# ---- notifications, on their own thread ---------------------------------------
# MAX's "New Contact" toast. $shared.toasts is what is on screen now.
$shared = [hashtable]::Synchronized(@{ toasts = @(); ms = 0; err = $null })
$toastLoop = {
  param($shared, $toastPattern)
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $AE = [System.Windows.Automation.AutomationElement]
    $Scope = [System.Windows.Automation.TreeScope]
    $All = [System.Windows.Automation.Condition]::TrueCondition
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Windows.UI.Core.CoreWindow')
    $toastMatch = New-Object System.Text.RegularExpressions.Regex($toastPattern)
    $clock = New-Object System.Diagnostics.Stopwatch
    while ($true) {
      $clock.Restart()
      $now = New-Object System.Collections.ArrayList
      try {
        foreach ($w in $AE::RootElement.FindAll($Scope::Children, $cond)) {
          try { $name = [string]$w.Current.Name } catch { continue }
          if ($name -notmatch 'notification') { continue }
          $sb = New-Object System.Text.StringBuilder
          $n = 0; $named = 0
          foreach ($e in $w.FindAll($Scope::Descendants, $All)) {
            if ($n++ -ge 400) { break }
            try { $t = $e.Current.Name; if ($t) { $named++; [void]$sb.Append($t).Append("`n") } } catch {}
          }
          $text = $sb.ToString()
          if (-not $toastMatch.IsMatch($text)) { continue }
          [void]$now.Add(@{ k = 'toast'; id = [string]$w.Current.NativeWindowHandle; title = $name
                            text = $text; n = $named; doc = -1; min = $false })
        }
        $shared.err = $null
      } catch { $shared.err = $_.Exception.Message }
      $shared.toasts = $now.ToArray()
      $shared.ms = [int]$clock.ElapsedMilliseconds
      Start-Sleep -Milliseconds 500
    }
  } catch { $shared.err = $_.Exception.Message }
}
$toastThread = [powershell]::Create()
[void]$toastThread.AddScript($toastLoop).AddArgument($shared).AddArgument($env:TA_TOAST)
[void]$toastThread.BeginInvoke()

# ---- the scans --------------------------------------------------------------------
$interval = [int]$env:TA_INTERVAL_MS
$cap = 4000
$tick = 0
$clock = New-Object System.Diagnostics.Stopwatch
[Console]::Out.WriteLine('{"t":"ready"}')
[Console]::Out.Flush()
$parent = 0
[void][int]::TryParse($env:TA_PARENT, [ref]$parent)
while ($true) {
  if ($parent -gt 0) {
    try { $owner = [System.Diagnostics.Process]::GetProcessById($parent); if ($owner.HasExited) { exit } } catch { exit }
  }
  $clock.Restart()
  $found = New-Object System.Collections.ArrayList
  $titles = New-Object System.Collections.ArrayList
  $urls = New-Object System.Collections.ArrayList
  $addrs = New-Object System.Collections.ArrayList
  $seen = @{}
  $bars = 0
  $tBars = 0
  $tick++
  $err = $null
  # Windows that closed take what was found in them along; and a window with
  # no address bar is asked again now and then (an app window can become a
  # normal one).
  if (($tick % 60) -eq 0) { $barOf.Clear(); $pageOf.Clear() }
  try {
    foreach ($win in [TA.Win]::List()) {
      $name = $win.Title; $cls = $win.Class
      if ($titles.Count -lt 12) { [void]$titles.Add($name) }
      $isBrowser = (($cls -eq 'Chrome_WidgetWin_1' -or $cls -eq 'MozillaWindowClass') -and (Test-Browser $win.Pid))
      $matches = $match.IsMatch($name)
      $wantBar = $isBrowser -and -not $win.Min -and (($tick % 2) -eq 0)
      if (-not $matches -and -not $wantBar) { continue }
      if ($isBrowser -and (Test-Own $win.Pid)) {
        if ($matches) {
          [void]$found.Add(@{ k = 'window'; id = [string]$win.H.ToInt64(); title = $name; text = ''; n = 0
                              doc = -1; min = $win.Min; own = $true })
        }
        continue
      }
      $key = $win.H.ToInt64()
      try { $w = $AE::FromHandle($win.H) } catch { continue }
      # The call page's address (every other scan): it carries the CXone call
      # id, which MAX never shows.
      if ($wantBar) {
        $t0 = $clock.ElapsedMilliseconds
        for ($try = 0; $try -lt 2; $try++) {
          try {
            if (-not $barOf.ContainsKey($key)) { $barOf[$key] = $w.FindFirst($Scope::Descendants, $barCond) }
            $bar = $barOf[$key]
            if ($bar) {
              $v = $bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
              $bars++
              if ($addrs.Count -lt 3) { $a = [string]$v; if ($a.Length -gt 110) { $a = $a.Substring(0, 110) }; [void]$addrs.Add($a) }
              if ($v -and $urlMatch.IsMatch($v)) { [void]$urls.Add([string]$v) }
            }
            break
          } catch { $barOf.Remove($key) }      # the bar it knew is gone: look again, once
        }
        $tBars += $clock.ElapsedMilliseconds - $t0
      }
      if (-not $matches) { continue }
      $id = [string]$key
      # Windows hides a minimized window's contents from readers. Say that it
      # is there; there is nothing to read, and nothing is ever restored.
      if ($win.Min) {
        [void]$found.Add(@{ k = 'window'; id = $id; title = $name; text = ''; n = 0; doc = -1; min = $true })
        continue
      }
      # The page: found once, then read until it is gone or reads as nothing
      # (a tab that was closed, or went to the background).
      $read = $null
      $doc = 0          # 1 = the page is readable, 0 = only the browser's frame is
      for ($try = 0; $try -lt 2 -and -not $read; $try++) {
        try {
          if (-not $pageOf.ContainsKey($key)) { $pageOf[$key] = $w.FindFirst($Scope::Descendants, $docCond) }
          $page = $pageOf[$key]
          if (-not $page) { break }
          $got = Read-Names $page $cap
          if ($got.named -eq 0 -and $try -eq 0) { $pageOf.Remove($key); continue }
          $read = $got; $doc = 1
        } catch { $pageOf.Remove($key) }
      }
      $root = $w
      if ($read) { $root = $pageOf[$key] }
      else {
        $pageOf.Remove($key)
        try { $read = Read-Names $w $cap } catch { $read = @{ text = ''; named = 0 } }
      }
      $text = $read.text
      # MAX shows the call page's address in a side panel: a text box keeps
      # it in its value, not its name, so read those too.
      if (($tick % 2) -eq 0) {
        try {
          $k = 0
          foreach ($ed in $root.FindAll($Scope::Descendants, $editCond)) {
            if ($k++ -ge 12) { break }
            try {
              $ev = $ed.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
              if ($ev -and $urlMatch.IsMatch($ev)) { [void]$urls.Add([string]$ev) }
            } catch {}
          }
        } catch {}
      }
      # The same page listed twice (a browser can own two windows for one):
      # read once is enough.
      $same = $name + "`n" + $text
      if ($seen.ContainsKey($same)) { continue }
      $seen[$same] = $true
      [void]$found.Add(@{ k = 'window'; id = $id; title = $name; text = $text; n = $read.named; doc = $doc; min = $false })
    }
  } catch { $err = $_.Exception.Message }
  foreach ($toast in @($shared.toasts)) { [void]$found.Add($toast) }
  if (-not $err -and $shared.err) { $err = 'Notifications: ' + $shared.err }
  $snap = @{ t = 'snap'; w = $found.ToArray(); all = $titles.ToArray(); err = $err; urls = $urls.ToArray()
             bars = $bars; addrs = $addrs.ToArray(); ms = [int]$clock.ElapsedMilliseconds
             bars_ms = [int]$tBars; toast_ms = [int]$shared.ms }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 $snap))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
