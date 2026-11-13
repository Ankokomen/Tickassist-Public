# TickAssist window reader. Started by watcher.py with -EncodedCommand; its
# settings arrive in environment variables, never spliced into this text.
#   TA_MATCH        regex a window title must match to be read
#   TA_TOAST        regex a notification's text must match
#   TA_URL          regex for a call page's address
#   TA_INTERVAL_MS  pause between scans
# Lists top-level windows each scan and reads the full text only of those that
# match, so the cost scales with the MAX window, not the whole desktop. Writes
# one JSON line per scan to stdout.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$All = [System.Windows.Automation.Condition]::TrueCondition
$match = New-Object System.Text.RegularExpressions.Regex($env:TA_MATCH)
$toastMatch = New-Object System.Text.RegularExpressions.Regex($env:TA_TOAST)
$urlMatch = New-Object System.Text.RegularExpressions.Regex($env:TA_URL)
$tick = 0
Add-Type -Namespace TA -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$interval = [int]$env:TA_INTERVAL_MS
$cap = 4000
[Console]::Out.WriteLine('{"t":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $found = New-Object System.Collections.ArrayList
  $titles = New-Object System.Collections.ArrayList
  $urls = New-Object System.Collections.ArrayList
  $bars = 0
  $addrs = New-Object System.Collections.ArrayList
  $tick++
  $err = $null
  try {
    $wins = $AE::RootElement.FindAll($Scope::Children, $All)
    foreach ($w in $wins) {
      try { $name = [string]$w.Current.Name; $cls = [string]$w.Current.ClassName }
      catch { continue }
      if ($name -and $titles.Count -lt 12) { [void]$titles.Add($name) }
      # The call page's address (browser windows only, every other scan): it
      # carries the CXone call id, which MAX never shows.
      if (($tick % 2) -eq 0 -and ($cls -eq 'Chrome_WidgetWin_1' -or $cls -eq 'MozillaWindowClass')) {
        try {
          $ec = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
          $nc = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Address and search bar')
          $bar = $w.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.AndCondition($ec, $nc)))
          if (-not $bar) { $bar = $w.FindFirst($Scope::Descendants, $ec) }
          if ($bar) {
            $bars++
            $v = $bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
            if ($addrs.Count -lt 3) { $a = [string]$v; if ($a.Length -gt 110) { $a = $a.Substring(0, 110) }; [void]$addrs.Add($a) }
            if ($v -and $urlMatch.IsMatch($v)) { [void]$urls.Add([string]$v) }
          }
        } catch {}
      }
      $isToast = ($cls -eq 'Windows.UI.Core.CoreWindow' -and $name -match 'notification')
      if (-not $isToast -and -not $match.IsMatch($name)) { continue }
      # A minimized window hides its contents from readers; note it so the
      # status can say why nothing was read. Nothing is ever restored.
      $min = $false
      if (-not $isToast) {
        try { $min = [TA.W]::IsIconic([IntPtr][int]$w.Current.NativeWindowHandle) } catch {}
      }
      $sb = New-Object System.Text.StringBuilder
      $n = 0
      $named = 0
      try {
        foreach ($e in $w.FindAll($Scope::Descendants, $All)) {
          if ($n++ -ge $cap) { break }
          try { $t = $e.Current.Name; if ($t) { $named++; [void]$sb.Append($t).Append("`n") } } catch {}
        }
      } catch {}
      $text = $sb.ToString()
      # MAX shows the call page's address in a side panel: a text box keeps
      # it in its value, not its name, so read those too.
      if (-not $isToast -and ($tick % 2) -eq 0) {
        try {
          $k = 0
          foreach ($ed in $w.FindAll($Scope::Descendants, $editCond)) {
            if ($k++ -ge 12) { break }
            try {
              $ev = $ed.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
              if ($ev -and $urlMatch.IsMatch($ev)) { [void]$urls.Add([string]$ev) }
            } catch {}
          }
        } catch {}
      }
      # Diagnostics only: does this window expose a web page (Document)?
      # 1 = yes, 0 = only the browser frame, -1 = could not tell.
      $doc = -1
      if (-not $isToast) {
        try {
          $docCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
          $doc = 0
          if ($w.FindFirst($Scope::Descendants, $docCond)) { $doc = 1 }
        } catch { $doc = -1 }
      }
      if ($isToast -and -not $toastMatch.IsMatch($text)) { continue }
      $kind = 'window'; if ($isToast) { $kind = 'toast' }
      [void]$found.Add(@{ k = $kind; id = [string]$w.Current.NativeWindowHandle;
                          title = $name; text = $text; n = $named; doc = $doc; min = $min })
    }
  } catch { $err = $_.Exception.Message }
  $snap = @{ t = 'snap'; w = $found.ToArray(); all = $titles.ToArray(); err = $err; urls = $urls.ToArray(); bars = $bars; addrs = $addrs.ToArray() }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 $snap))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
