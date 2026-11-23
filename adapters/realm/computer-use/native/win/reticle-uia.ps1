# reticle-uia: the Windows helper of the computer-use realm. It reads an application through UI
# Automation and acts on it, and it answers in the same shape as the macOS helper (reticle-ax):
# the same commands, the same JSON, and the roles named as macOS names them (AXButton, AXTextField),
# so the realm reads both with one reader.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File reticle-uia.ps1 serve
#
# Each line on standard input is one command as a JSON list of words; each answer is one line.
#   apps
#   tree    <pid>
#   reach   <pid> <path> <role> <name>
#   act     <pid> <path> <role> <name> <kind> <value> <budgetMs> <delivery[:quietMs]> [folder...]
#   capture <pid> <file> [screen]
#
# Windows PowerShell 5.1 and PowerShell 7 both run it. It needs no install: UI Automation is part
# of Windows.
$ErrorActionPreference = 'Stop'
# WindowsBase holds System.Windows.Point, which the hit test of the reach check takes.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing
# The classic controls of Windows (an Edit box, a menu bar, a list view) are described to UI
# Automation by client-side providers in an assembly of their own. Without it they were plain
# panes with no value and no children: Notepad's text box had no ref in the first Windows run.
$script:Providers = 'not loaded'
foreach ($name in @('UIAutomationClientsideProviders', 'UIAutomationClientSideProviders')) {
  try {
    $loaded = [System.Reflection.Assembly]::Load(
      "$name, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35")
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly($loaded.GetName())
    $script:Providers = "loaded $($loaded.FullName)"
    break
  } catch {
    # ponytail: a Windows without the assembly still reads the controls that describe themselves.
    $script:Providers = "failed: $($_.Exception.Message)"
  }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ReticleWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime;
  }
}
'@

$AE = [System.Windows.Automation.AutomationElement]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$ReadLimit = 20000
$ShortList = 200
$QuietMs = 150

# UI Automation control types, named as macOS names them.
$RoleOf = @{
  'ControlType.Window' = 'AXWindow'; 'ControlType.Button' = 'AXButton'; 'ControlType.SplitButton' = 'AXMenuButton'
  'ControlType.Edit' = 'AXTextField'; 'ControlType.Document' = 'AXTextArea'; 'ControlType.Text' = 'AXStaticText'
  'ControlType.CheckBox' = 'AXCheckBox'; 'ControlType.RadioButton' = 'AXRadioButton'; 'ControlType.ComboBox' = 'AXComboBox'
  'ControlType.List' = 'AXList'; 'ControlType.ListItem' = 'AXRow'; 'ControlType.DataGrid' = 'AXTable'
  'ControlType.DataItem' = 'AXRow'; 'ControlType.Table' = 'AXTable'; 'ControlType.Tree' = 'AXOutline'
  'ControlType.TreeItem' = 'AXRow'; 'ControlType.Menu' = 'AXMenu'; 'ControlType.MenuBar' = 'AXMenuBar'
  'ControlType.MenuItem' = 'AXMenuItem'; 'ControlType.Tab' = 'AXTabGroup'; 'ControlType.TabItem' = 'AXRadioButton'
  'ControlType.Hyperlink' = 'AXLink'; 'ControlType.Image' = 'AXImage'; 'ControlType.Slider' = 'AXSlider'
  'ControlType.ScrollBar' = 'AXScrollBar'; 'ControlType.ProgressBar' = 'AXProgressIndicator'
  'ControlType.ToolBar' = 'AXToolbar'; 'ControlType.Group' = 'AXGroup'; 'ControlType.Pane' = 'AXGroup'
  'ControlType.Custom' = 'AXGroup'; 'ControlType.StatusBar' = 'AXGroup'; 'ControlType.TitleBar' = 'AXGroup'
  'ControlType.Header' = 'AXGroup'; 'ControlType.HeaderItem' = 'AXButton'; 'ControlType.Separator' = 'AXSplitter'
  'ControlType.Spinner' = 'AXIncrementor'; 'ControlType.Calendar' = 'AXGroup'; 'ControlType.ToolTip' = 'AXGroup'
  'ControlType.Thumb' = 'AXValueIndicator'
}

function Write-Answer($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 100 -Compress))
  [Console]::Out.Flush()
}

function Get-Pattern($el, $pattern) {
  $found = $null
  if ($el.TryGetCurrentPattern($pattern, [ref]$found)) { return $found }
  return $null
}

# The top windows of a process, in the order the read gives them. A window that is made small is
# counted and not read: it is not on the screen, as on macOS.
function Get-Windows([int]$procId) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
  $all = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  $shown = @(); $away = 0
  foreach ($w in $all) {
    $state = Get-Pattern $w ([System.Windows.Automation.WindowPattern]::Pattern)
    if ($null -ne $state -and $state.Current.WindowVisualState -eq 'Minimized') { $away += 1; continue }
    $shown += $w
  }
  return @{ shown = $shown; away = $away }
}

function Get-Children($el) {
  $kids = @()
  $child = $Walker.GetFirstChild($el)
  while ($null -ne $child) { $kids += $child; $child = $Walker.GetNextSibling($child) }
  return $kids
}

$script:Budget = $ReadLimit
function Read-Node($el, [int]$depth, [ref]$unread) {
  try { $c = $el.Current } catch { $unread.Value += 1; return @{ role = ''; children = @() } }
  $role = $RoleOf[$c.ControlType.ProgrammaticName]
  if ($null -eq $role) { $role = 'AXUnknown' }
  $node = [ordered]@{ role = $role }
  # What UI Automation said, for a check that has to see why an element is read as it is.
  if ($env:RETICLE_UIA_DEBUG) {
    $raw = 0; $r = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($el)
    while ($null -ne $r) { $raw += 1; $r = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetNextSibling($r) }
    $node.uia = "$($c.ControlType.ProgrammaticName) $($c.ClassName) kids:$((Get-Children $el).Count) raw:$raw"
  }
  if ($c.Name) { $node.title = $c.Name }
  if ($c.HelpText) { $node.help = $c.HelpText }
  if ($c.AutomationId) { $node.id = $c.AutomationId }
  $node.enabled = $c.IsEnabled
  $node.focused = $c.HasKeyboardFocus
  $r = $c.BoundingRectangle
  if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) { $node.frame = @($r.X, $r.Y, $r.Width, $r.Height) }
  $toggle = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
  $value = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
  $range = Get-Pattern $el ([System.Windows.Automation.RangeValuePattern]::Pattern)
  if ($null -ne $toggle) { $node.value = $(if ($toggle.Current.ToggleState -eq 'On') { '1' } else { '0' }) }
  elseif ($null -ne $value) { $node.value = [string]$value.Current.Value }
  elseif ($null -ne $range) { $node.value = [string]$range.Current.Value }
  $pick = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $pick -and $pick.Current.IsSelected) { $node.selected = $true }
  $kids = @()
  if ($depth -lt 80) { $kids = Get-Children $el }
  # A long list gives the items on the screen, with their places, and says how many it left out.
  $places = $null
  if ($kids.Count -gt $ShortList -and @('AXList', 'AXTable', 'AXOutline') -contains $role) {
    $places = @(); $shown = @()
    for ($k = 0; $k -lt $kids.Count; $k++) {
      try { if (-not $kids[$k].Current.IsOffscreen) { $places += $k; $shown += $kids[$k] } } catch { }
    }
    $node.notShown = $kids.Count - $shown.Count
    $kids = $shown
  }
  if ($script:Budget -le 0 -and $kids.Count -gt 0) {
    $node.notShown = [int]$node.notShown + $kids.Count
    $node.children = @()
    return $node
  }
  $script:Budget -= $kids.Count
  $children = @()
  for ($k = 0; $k -lt $kids.Count; $k++) {
    $one = Read-Node $kids[$k] ($depth + 1) $unread
    if ($null -ne $places) { $one.i = $places[$k] }
    $children += , $one
  }
  $node.children = $children
  return $node
}

function Read-App([int]$procId) {
  $script:Budget = $ReadLimit
  $unread = 0
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return $null }
  $windows = Get-Windows $procId
  $children = @()
  foreach ($w in $windows.shown) { $children += , (Read-Node $w 1 ([ref]$unread)) }
  return @{
    tree = [ordered]@{ role = 'AXApplication'; title = $proc.ProcessName; children = $children; uia = $(if ($env:RETICLE_UIA_DEBUG) { "providers: $script:Providers" } else { $null }) }
    unread = $unread
    windowsNotOnScreen = $windows.away
  }
}

# The element at a path of child places, from the application: the first place is a window.
function Find-Element([int]$procId, [string]$path) {
  $places = @($path.Split('.') | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
  if ($places.Count -eq 0) { return @{ app = $true } }
  $windows = (Get-Windows $procId).shown
  if ($places[0] -ge $windows.Count) { return $null }
  $el = $windows[$places[0]]
  for ($k = 1; $k -lt $places.Count; $k++) {
    $kids = Get-Children $el
    if ($places[$k] -ge $kids.Count) { return $null }
    $el = $kids[$places[$k]]
  }
  return @{ el = $el }
}

function Name-Of($el) { try { return [string]$el.Current.Name } catch { return '' } }

# Can a person click the element: is it the element at its middle, or inside it?
function Test-Reach($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { return @{ reach = 'unknown'; detail = 'the element has no place on the screen' } }
  $point = New-Object System.Windows.Point(($r.X + $r.Width / 2), ($r.Y + $r.Height / 2))
  try { $hit = $AE::FromPoint($point) } catch { return @{ reach = 'unknown'; detail = 'the hit test failed' } }
  $at = $hit
  for ($k = 0; $k -lt 8 -and $null -ne $at; $k++) {
    if ([System.Windows.Automation.Automation]::Compare($at, $el)) { return @{ reach = 'yes' } }
    $at = $Walker.GetParent($at)
  }
  $owner = ''
  try { $owner = (Get-Process -Id $hit.Current.ProcessId).ProcessName } catch { }
  return @{ reach = 'no'; detail = "a $($RoleOf[$hit.Current.ControlType.ProgrammaticName]) of $owner" }
}

function Wait-Quiet([int]$procId, [int]$budgetMs, [int]$quietMs) {
  $started = [DateTime]::UtcNow
  $last = (Read-App $procId | ConvertTo-Json -Depth 100 -Compress)
  $quietSince = [DateTime]::UtcNow
  while (([DateTime]::UtcNow - $started).TotalMilliseconds -lt $budgetMs) {
    Start-Sleep -Milliseconds 50
    $now = (Read-App $procId | ConvertTo-Json -Depth 100 -Compress)
    if ($now -ne $last) { $last = $now; $quietSince = [DateTime]::UtcNow; continue }
    if (([DateTime]::UtcNow - $quietSince).TotalMilliseconds -ge $quietMs) { return $true }
  }
  return $false
}

function Send-Click([int]$x, [int]$y, [int]$times, [bool]$right) {
  [ReticleWin32]::SetCursorPos($x, $y) | Out-Null
  $down = $(if ($right) { 0x0008 } else { 0x0002 }); $up = $(if ($right) { 0x0010 } else { 0x0004 })
  for ($k = 0; $k -lt $times; $k++) {
    [ReticleWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [ReticleWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  }
}

# SendKeys words for the key names the realm uses.
$KeyOf = @{ 'return' = '{ENTER}'; 'enter' = '{ENTER}'; 'escape' = '{ESC}'; 'tab' = '{TAB}'; 'backspace' = '{BACKSPACE}'
  'delete' = '{DELETE}'; 'arrowup' = '{UP}'; 'arrowdown' = '{DOWN}'; 'arrowleft' = '{LEFT}'; 'arrowright' = '{RIGHT}'
  'home' = '{HOME}'; 'end' = '{END}'; 'pageup' = '{PGUP}'; 'pagedown' = '{PGDN}'; 'space' = ' ' }
function Key-Words([string]$value) {
  $parts = $value.Split('+'); $key = $parts[-1]; $mods = ''
  foreach ($m in $parts[0..($parts.Count - 2)]) {
    switch ($m.ToLower()) { 'control' { $mods += '^' } 'meta' { $mods += '^' } 'shift' { $mods += '+' } 'alt' { $mods += '%' } }
  }
  if ($parts.Count -eq 1) { $mods = '' }
  $word = $KeyOf[$key.ToLower()]
  if ($null -eq $word) { $word = $(if ($key.Length -eq 1) { $key } else { "{$($key.ToUpper())}" }) }
  return $mods + $word
}

function Invoke-Act($words) {
  $procId = [int]$words[1]; $path = $words[2]; $role = $words[3]; $name = $words[4]; $kind = $words[5]
  $value = $words[6]; $budgetMs = [int]$words[7]; $how = $words[8].Split(':')
  $quiet = $(if ($how.Count -gt 1) { [int]$how[1] } else { $QuietMs })
  $foreground = $how[0] -eq 'foreground'; $direct = $how[0] -eq 'direct'
  if ($null -eq (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return @{ error = 'app-gone' } }
  $found = Find-Element $procId $path
  if ($null -eq $found) { return @{ refused = 'stale'; detail = 'no element at the path' } }
  $el = $found.el
  if ($null -ne $el) {
    $nowRole = $RoleOf[$el.Current.ControlType.ProgrammaticName]
    if ($nowRole -ne $role -or (Name-Of $el) -ne $name) { return @{ refused = 'stale'; detail = 'a different element is at the path' } }
    if (-not $el.Current.IsEnabled -and $kind -ne 'raise') { return @{ refused = 'disabled' } }
  }
  $pointer = @('click', 'dblclick', 'rightclick', 'hover', 'drag', 'wheel') -contains $kind
  if ($pointer -and -not $foreground) { return @{ refused = 'needs-foreground' } }
  if ($foreground -and [ReticleWin32]::IdleMs() -lt 800) {
    Start-Sleep -Milliseconds 800
    if ([ReticleWin32]::IdleMs() -lt 800) { return @{ refused = 'person-active'; detail = 'the person at the machine is typing or moving the pointer' } }
  }
  $reach = $(if ($null -ne $el) { Test-Reach $el } else { @{ reach = 'yes' } })
  if ($reach.reach -ne 'yes' -and -not $direct -and $kind -ne 'raise' -and $kind -ne 'window') {
    if ($reach.reach -eq 'no') { return @{ refused = 'unreachable'; detail = $reach.detail } }
    return @{ refused = 'reach-unknown'; detail = $reach.detail }
  }
  $before = Read-App $procId
  $delivered = $true
  try {
    switch ($kind) {
      'press' {
        $invoke = Get-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
        $toggle = Get-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
        $pick = Get-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $expand = Get-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -ne $invoke) { $invoke.Invoke() }
        elseif ($null -ne $toggle) { $toggle.Toggle() }
        elseif ($null -ne $pick) { $pick.Select() }
        elseif ($null -ne $expand) { if ($expand.Current.ExpandCollapseState -eq 'Collapsed') { $expand.Expand() } else { $expand.Collapse() } }
        else {
          # The words of a row: the row or the item that holds them is chosen, as a click chooses it.
          $up = $Walker.GetParent($el); $done = $false
          for ($k = 0; $k -lt 4 -and $null -ne $up -and -not $done; $k++) {
            $holder = Get-Pattern $up ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $holder) { $holder.Select(); $done = $true }
            $up = $Walker.GetParent($up)
          }
          $delivered = $done
        }
      }
      'set' {
        $valuePattern = Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
        $range = Get-Pattern $el ([System.Windows.Automation.RangeValuePattern]::Pattern)
        if ($null -ne $range -and $value -match '^-?[\d.]+$') { $range.SetValue([double]$value) }
        elseif ($null -ne $valuePattern) { $valuePattern.SetValue($value) }
        else { $delivered = $false }
      }
      'raise' {
        $proc = Get-Process -Id $procId
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { [ReticleWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null }
        if ($null -ne $el) { try { $el.SetFocus() } catch { } }
      }
      { $_ -eq 'type' -or $_ -eq 'key' } {
        $front = [IntPtr]::Zero; [uint32]$owner = 0
        $front = [ReticleWin32]::GetForegroundWindow(); [ReticleWin32]::GetWindowThreadProcessId($front, [ref]$owner) | Out-Null
        if (-not $foreground) {
          # A key in the background goes to a field as its value: Windows has no key for one window alone.
          if ($kind -eq 'type') { (Get-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($value) }
          else { $delivered = $false }
        } elseif ($owner -ne $procId) { return @{ refused = 'no-keyboard' } }
        elseif ($kind -eq 'type') { [System.Windows.Forms.SendKeys]::SendWait(($value -replace '([+^%~(){}\[\]])', '{$1}')) }
        else { [System.Windows.Forms.SendKeys]::SendWait((Key-Words $value)) }
      }
      { @('click', 'dblclick', 'rightclick', 'hover') -contains $_ } {
        $r = $el.Current.BoundingRectangle
        $xy = $value.Split(',') | Where-Object { $_ -ne '' }
        $x = $(if ($xy.Count -ge 2) { [int][double]$xy[0] } else { [int]($r.X + $r.Width / 2) })
        $y = $(if ($xy.Count -ge 2) { [int][double]$xy[1] } else { [int]($r.Y + $r.Height / 2) })
        if ($kind -eq 'hover') { [ReticleWin32]::SetCursorPos($x, $y) | Out-Null }
        else { Send-Click $x $y $(if ($kind -eq 'dblclick') { 2 } else { 1 }) ($kind -eq 'rightclick') }
      }
      'wheel' {
        $n = $value.Split(','); $r = $el.Current.BoundingRectangle
        $x = $(if ($n.Count -ge 3) { [int][double]$n[1] } else { [int]($r.X + $r.Width / 2) })
        $y = $(if ($n.Count -ge 3) { [int][double]$n[2] } else { [int]($r.Y + $r.Height / 2) })
        [ReticleWin32]::SetCursorPos($x, $y) | Out-Null
        [ReticleWin32]::mouse_event(0x0800, 0, 0, -120 * [int][Math]::Ceiling([double]$n[0] / 3), [UIntPtr]::Zero)
      }
      'window' {
        $top = $el
        while ($null -ne $top -and $top.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') { $top = $Walker.GetParent($top) }
        $win = Get-Pattern $top ([System.Windows.Automation.WindowPattern]::Pattern)
        $move = Get-Pattern $top ([System.Windows.Automation.TransformPattern]::Pattern)
        switch -Regex ($value) {
          '^minimize$' { $win.SetWindowVisualState('Minimized') }
          '^(zoom|fullscreen)$' { $win.SetWindowVisualState('Maximized') }
          '^restore$' { $win.SetWindowVisualState('Normal') }
          '^(left|right)$' {
            $area = [System.Windows.Forms.Screen]::FromPoint([System.Drawing.Point]::new([int]$top.Current.BoundingRectangle.X, [int]$top.Current.BoundingRectangle.Y)).WorkingArea
            $win.SetWindowVisualState('Normal'); $half = $area.Width / 2
            $move.Move($(if ($value -eq 'left') { $area.X } else { $area.X + $half }), $area.Y); $move.Resize($half, $area.Height)
          }
          '^frame:' { $f = $value.Substring(6).Split(','); $win.SetWindowVisualState('Normal'); $move.Move([double]$f[0], [double]$f[1]); $move.Resize([double]$f[2], [double]$f[3]) }
        }
      }
      default { return @{ error = "unknown-action $kind" } }
    }
  } catch {
    $delivered = $false
  }
  $settled = Wait-Quiet $procId $budgetMs $quiet
  $after = Read-App $procId
  if ($null -eq $after) {
    return @{ delivered = $delivered; reachable = $true; settled = $settled; appGone = $true; before = $before.tree; after = @{ role = 'AXApplication'; children = @() }; unreadBefore = $before.unread; unreadAfter = 0 }
  }
  return @{ delivered = $delivered; reachable = ($reach.reach -eq 'yes'); settled = $settled; before = $before.tree; after = $after.tree; unreadBefore = $before.unread; unreadAfter = $after.unread }
}

function Invoke-Capture($words) {
  $procId = [int]$words[1]; $file = $words[2]; $screen = $words.Count -gt 3 -and $words[3] -eq 'screen'
  $windows = (Get-Windows $procId).shown
  if ($windows.Count -eq 0) { return @{ ok = $false; reason = 'the application has no window on the screen' } }
  $r = $windows[0].Current.BoundingRectangle
  $area = $(if ($screen) { [System.Windows.Forms.Screen]::FromPoint([System.Drawing.Point]::new([int]$r.X, [int]$r.Y)).Bounds } else { [System.Drawing.Rectangle]::new([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) })
  $bitmap = New-Object System.Drawing.Bitmap($area.Width, $area.Height)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)
  $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bitmap.Dispose()
  $answer = @{ ok = $true; window = @($area.X, $area.Y, $area.Width, $area.Height); scale = 1 }
  if ($screen) { $answer.appWindow = @($r.X, $r.Y, $r.Width, $r.Height) }
  return $answer
}

function Invoke-ReticleCommand($words) {
  switch ($words[0]) {
    'apps' {
      return @{ apps = @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | ForEach-Object {
        @{ name = $(if ($_.MainWindowTitle) { $_.ProcessName } else { $_.ProcessName }); process = $_.ProcessName; pid = $_.Id; regular = $true } }) }
    }
    'tree' {
      $read = Read-App ([int]$words[1])
      if ($null -eq $read) { return @{ error = 'app-gone' } }
      return $read
    }
    'reach' {
      $found = Find-Element ([int]$words[1]) $words[2]
      if ($null -eq $found -or $null -eq $found.el) { return @{ refused = 'stale' } }
      return Test-Reach $found.el
    }
    'act' { return Invoke-Act $words }
    'capture' { return Invoke-Capture $words }
    default { return @{ error = 'usage' } }
  }
}

if ($args.Count -gt 0 -and $args[0] -eq 'serve') {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    # Windows PowerShell 5.1 gives a JSON list as one object; the pipe opens it on every version.
    try { Write-Answer (Invoke-ReticleCommand @((ConvertFrom-Json $line) | ForEach-Object { [string]$_ })) }
    catch { Write-Answer @{ error = [string]$_.Exception.Message } }
  }
} else {
  Write-Answer (Invoke-ReticleCommand $args)
}
