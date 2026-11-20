# Draws app/icon.ico for OpenSTV: dark rounded square with an OTDR trace.
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$bg = New-RoundedPath 6 6 244 244 46
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 35, 61))
$g.FillPath($bgBrush, $bg)

# subtle top highlight
$hl = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
$g.FillPath($hl, (New-RoundedPath 6 6 244 122 46))

# reflectogram trace
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 92, 168, 255), 13)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pts = @(
  (New-Object System.Drawing.PointF(34, 92)),
  (New-Object System.Drawing.PointF(78, 120)),
  (New-Object System.Drawing.PointF(112, 148)),
  (New-Object System.Drawing.PointF(140, 168)),
  (New-Object System.Drawing.PointF(152, 96)),
  (New-Object System.Drawing.PointF(168, 168)),
  (New-Object System.Drawing.PointF(198, 186)),
  (New-Object System.Drawing.PointF(222, 194))
)
$g.DrawLines($pen, [System.Drawing.PointF[]]$pts)

# end-of-fiber marker
$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 78, 214, 140))
$g.FillEllipse($dot, 206, 178, 30, 30)

$g.Dispose()
$bgBrush.Dispose()
$hl.Dispose()
$pen.Dispose()
$dot.Dispose()

$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$dir = Join-Path $PSScriptRoot '..\app'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$dest = Join-Path $dir 'icon.ico'
$fs = [System.IO.File]::Create($dest)
$icon.Save($fs)
$fs.Close()
$fs.Dispose()
$icon.Dispose()
$bmp.Dispose()

"icon: $((Get-Item $dest).Length) bytes"
