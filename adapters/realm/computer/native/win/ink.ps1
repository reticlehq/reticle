# A canvas for uiacheck.mjs, as a photo editor has one: a drag on "Ink" draws a line, and no
# element says so. A red bar beside it moves by itself all the time, as a video that plays: its
# pixels must not count as the effect of an action.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/win/ink.ps1
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ink'
$form.ClientSize = New-Object System.Drawing.Size(420, 300)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(120, 120)
$form.TopMost = $true

$canvas = New-Object System.Windows.Forms.PictureBox
$canvas.Location = New-Object System.Drawing.Point(20, 20)
$canvas.Size = New-Object System.Drawing.Size(260, 200)
$canvas.BackColor = [System.Drawing.Color]::White
$canvas.AccessibleName = 'Ink'
$canvas.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Graphic
$canvas.Image = New-Object System.Drawing.Bitmap(260, 200)
$script:last = $null
$canvas.Add_MouseDown({ param($s, $e) $script:last = $e.Location })
$canvas.Add_MouseMove({
    param($s, $e)
    if ($null -eq $script:last -or $e.Button -ne 'Left') { return }
    $g = [System.Drawing.Graphics]::FromImage($canvas.Image)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 4)
    $g.DrawLine($pen, $script:last, $e.Location); $g.Dispose(); $pen.Dispose()
    $script:last = $e.Location
    $canvas.Invalidate()
  })
$canvas.Add_MouseUp({ $script:last = $null })
$form.Controls.Add($canvas)

# Painted on the form, not a control: a control would be an element whose frame changes, and the
# bar must change only pixels.
$script:step = 0
$form.Add_Paint({
    param($s, $e)
    $e.Graphics.FillRectangle([System.Drawing.Brushes]::Red, 300 + $script:step * 3, 40, 8, 20)
  })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({ $script:step = ($script:step + 1) % 30; $form.Invalidate() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
