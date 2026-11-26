# reticle-uia: the Windows helper of the computer realm. It reads an application through UI
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
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint IdleMs() {
    LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime;
  }
}
'@

# Pictures of a window, made small, and what changed between them. In C#: a loop over the pixels
# in PowerShell takes seconds.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class ReticlePicture { public byte[] Bytes; public int W; public int H; }
public static class ReticlePixels {
  const int Width = 240; const int Step = 24;
  public static ReticlePicture Shot(int x, int y, int w, int h) {
    if (w <= 0 || h <= 0) return null;
    using (Bitmap full = new Bitmap(w, h)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(x, y, 0, 0, full.Size);
      int pw = Math.Min(Width, w); int ph = Math.Max(1, h * pw / w);
      using (Bitmap small = new Bitmap(pw, ph, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.Bilinear; g.DrawImage(full, 0, 0, pw, ph);
        }
        BitmapData data = small.LockBits(new Rectangle(0, 0, pw, ph), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] bytes = new byte[pw * ph * 4];
        for (int row = 0; row < ph; row++) Marshal.Copy(data.Scan0 + row * data.Stride, bytes, row * pw * 4, pw * 4);
        small.UnlockBits(data);
        ReticlePicture p = new ReticlePicture(); p.Bytes = bytes; p.W = pw; p.H = ph; return p;
      }
    }
  }
  static bool[] Moved(ReticlePicture a, ReticlePicture b) {
    if (a == null || b == null || a.W != b.W || a.H != b.H) return null;
    bool[] moved = new bool[a.W * a.H];
    for (int p = 0; p < moved.Length; p++)
      for (int c = 0; c < 3; c++) if (Math.Abs(a.Bytes[p * 4 + c] - b.Bytes[p * 4 + c]) > Step) moved[p] = true;
    return moved;
  }
  // What moved between the two pictures of each pair moves by itself (a video, a spinner): it is
  // made a little wider, and left out of the change.
  public static Hashtable Change(ReticlePicture earlier, ReticlePicture before, ReticlePicture after, ReticlePicture later,
      double wx, double wy, double ww, double wh) {
    Hashtable answer = new Hashtable();
    bool[] moved = Moved(before, after);
    if (moved == null) { answer["changed"] = 1.0; answer["box"] = new double[] { wx, wy, ww, wh }; return answer; }
    int w = before.W, h = before.H;
    bool[] mask = new bool[w * h];
    foreach (bool[] self in new bool[][] { Moved(earlier, before), Moved(after, later) }) {
      if (self == null) continue;
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        if (!self[y * w + x]) continue;
        for (int yy = Math.Max(0, y - 2); yy <= Math.Min(h - 1, y + 2); yy++)
          for (int xx = Math.Max(0, x - 2); xx <= Math.Min(w - 1, x + 2); xx++) mask[yy * w + xx] = true;
      }
    }
    int count = 0, moving = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int p = y * w + x;
      if (mask[p]) { moving++; continue; }
      if (!moved[p]) continue;
      count++; minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
    }
    if (moving > 0) answer["moving"] = Math.Round((double)moving / (w * h), 4);
    answer["changed"] = Math.Round((double)count / (w * h), 4);
    if (count > 0) {
      double sx = ww / w, sy = wh / h;
      answer["box"] = new double[] { Math.Round(wx + minX * sx), Math.Round(wy + minY * sy),
        Math.Round((maxX - minX + 1) * sx), Math.Round((maxY - minY + 1) * sy) };
    }
    return answer;
  }
}
'@

# The keys a pointer action holds: the names the realm sends, as virtual keys. Meta is Control on
# Windows, as in Key-Words.
$VkOf = @{ 'shift' = 0x10; 'control' = 0x11; 'ctrl' = 0x11; 'meta' = 0x11; 'alt' = 0x12; 'option' = 0x12 }

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
  elseif (@('AXTextField', 'AXTextArea') -contains $role) {
    # A multi-line Edit box (the text of Notepad) has no value pattern: its text is in the text
    # pattern. Without it the realm read the box as empty after it wrote to it.
    $text = Get-Pattern $el ([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $text) { try { $node.value = [string]$text.DocumentRange.GetText(4000) } catch { } }
  }
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

function Send-Click([int]$x, [int]$y, [int]$times, [bool]$right, [int]$holdMs = 0, [bool]$middle = $false) {
  [ReticleWin32]::SetCursorPos($x, $y) | Out-Null
  $down = $(if ($right) { 0x0008 } elseif ($middle) { 0x0020 } else { 0x0002 })
  $up = $(if ($right) { 0x0010 } elseif ($middle) { 0x0040 } else { 0x0004 })
  for ($k = 0; $k -lt $times; $k++) {
    [ReticleWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
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
  # A pointer value is its points, then the hand: "x,y|mods=shift+alt|hold=300|pixels=1".
  $hand = @{}
  if ($pointer) {
    $parts = "$value".Split('|'); $value = $parts[0]
    foreach ($part in $parts | Select-Object -Skip 1) {
      $pair = $part.Split('=', 2); if ($pair.Count -eq 2) { $hand[$pair[0]] = $pair[1] }
    }
  }
  $mods = @(("$($hand['mods'])").Split('+') | ForEach-Object { $VkOf[$_.ToLower()] } | Where-Object { $null -ne $_ })
  $holdMs = [Math]::Min(10000, [Math]::Max(0, [int]("0$($hand['hold'])")))
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
  # A canvas shows its effect only in pixels: two pictures of the window before the action, a
  # moment apart, so what moves by itself is known. Only when the realm asks (a point of a picture,
  # an image, a window): a button shows its effect in its elements.
  $shots = $null
  if ($pointer -and $kind -ne 'hover' -and $hand['pixels'] -eq '1') {
    $top = (Get-Windows $procId).shown
    if ($top.Count -gt 0) {
      $wr = $top[0].Current.BoundingRectangle
      $shots = @{ rect = $wr; earlier = [ReticlePixels]::Shot([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height) }
      Start-Sleep -Milliseconds 100
      $shots.before = [ReticlePixels]::Shot([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height)
    }
  }
  foreach ($vk in $mods) { [ReticleWin32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
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
        $set = $false
        try {
          if ($null -ne $range -and $value -match '^-?[\d.]+$') { $range.SetValue([double]$value); $set = $true }
          elseif ($null -ne $valuePattern) { $valuePattern.SetValue($value); $set = $true }
        } catch {
          $script:LastError = $_.Exception.Message
        }
        # UI Automation refuses a value for a multi-line Edit box (the text of Notepad). The control
        # of Windows takes its text from WM_SETTEXT, also in the background, as it took it before
        # UI Automation existed.
        $handle = $el.Current.NativeWindowHandle
        if (-not $set -and $handle -ne 0) {
          [ReticleWin32]::SendMessage([IntPtr]$handle, 0x000C, [IntPtr]::Zero, $value) | Out-Null
          $set = $true
        }
        $delivered = $set
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
        else {
          # "count=3" is a triple-click, "button=middle" the middle button.
          $times = $(if ($kind -eq 'dblclick') { 2 } else { [Math]::Min(3, [Math]::Max(1, [int]("0$($hand['count'])"))) })
          Send-Click $x $y $times ($kind -eq 'rightclick') $holdMs ($hand['button'] -eq 'middle')
        }
      }
      'drag' {
        # Two numbers: the end, from the middle of the element. Four or more: a path, from its first
        # point. The pointer walks each part in small steps, as a hand moves.
        $n = @("$value".Split(',') | Where-Object { $_ -ne '' } | ForEach-Object { [double]$_ })
        $r = $el.Current.BoundingRectangle
        $way = [System.Collections.ArrayList]::new()
        if ($n.Count -eq 2) { [void]$way.Add(@(($r.X + $r.Width / 2), ($r.Y + $r.Height / 2))) }
        for ($k = 0; $k + 1 -lt $n.Count; $k += 2) { [void]$way.Add(@($n[$k], $n[$k + 1])) }
        if ($way.Count -lt 2) { return @{ error = 'a drag needs an end' } }
        [ReticleWin32]::SetCursorPos([int]$way[0][0], [int]$way[0][1]) | Out-Null
        [ReticleWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
        for ($k = 1; $k -lt $way.Count; $k++) {
          $a = $way[$k - 1]; $b = $way[$k]
          $steps = [Math]::Max(4, [Math]::Min(40, [int]([Math]::Sqrt([Math]::Pow($b[0] - $a[0], 2) + [Math]::Pow($b[1] - $a[1], 2)) / 6)))
          for ($s = 1; $s -le $steps; $s++) {
            [ReticleWin32]::SetCursorPos([int]($a[0] + ($b[0] - $a[0]) * $s / $steps), [int]($a[1] + ($b[1] - $a[1]) * $s / $steps)) | Out-Null
            Start-Sleep -Milliseconds 8
          }
        }
        [ReticleWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      'wheel' {
        $n = $value.Split(','); $r = $el.Current.BoundingRectangle
        $x = $(if ($n.Count -ge 3) { [int][double]$n[1] } else { [int]($r.X + $r.Width / 2) })
        $y = $(if ($n.Count -ge 3) { [int][double]$n[2] } else { [int]($r.Y + $r.Height / 2) })
        [ReticleWin32]::SetCursorPos($x, $y) | Out-Null
        if ([double]$n[0] -ne 0) { [ReticleWin32]::mouse_event(0x0800, 0, 0, -120 * [int][Math]::Ceiling([double]$n[0] / 3), [UIntPtr]::Zero) }
        # "across=5" turns the wheel to the side: more than 0 is to the right.
        $across = [int]("0$($hand['across'])".Replace('0-', '-'))
        if ($across -ne 0) { [ReticleWin32]::mouse_event(0x01000, 0, 0, 120 * [Math]::Sign($across) * [int][Math]::Ceiling([Math]::Abs($across) / 3), [UIntPtr]::Zero) }
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
    $script:LastError = $_.Exception.Message
    $delivered = $false
  } finally {
    foreach ($vk in $mods) { [ReticleWin32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
  }
  $settled = Wait-Quiet $procId $budgetMs $quiet
  $after = Read-App $procId
  # The pixels, each time the realm asked for them: not only when the tree is the same. A press on
  # a window that was not active changes its tree (the focus), and the stroke on the canvas was then
  # not compared. Two pictures after, too, for a motion that started with the action or is slow.
  $pixels = $null
  if ($null -ne $shots -and $null -ne $after) {
    $wr = $shots.rect
    $seen = [ReticlePixels]::Shot([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height)
    Start-Sleep -Milliseconds 100
    $later = [ReticlePixels]::Shot([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height)
    $pixels = [ReticlePixels]::Change($shots.earlier, $shots.before, $seen, $later, $wr.X, $wr.Y, $wr.Width, $wr.Height)
  }
  if ($null -eq $after) {
    return @{ delivered = $delivered; reachable = $true; settled = $settled; appGone = $true; before = $before.tree; after = @{ role = 'AXApplication'; children = @() }; unreadBefore = $before.unread; unreadAfter = 0 }
  }
  $answer = @{ delivered = $delivered; reachable = ($reach.reach -eq 'yes'); settled = $settled; before = $before.tree; after = $after.tree; unreadBefore = $before.unread; unreadAfter = $after.unread }
  if ($null -ne $pixels) { $answer.pixels = $pixels }
  if ($env:RETICLE_UIA_DEBUG -and $script:LastError) { $answer.uiaError = $script:LastError }
  return $answer
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
