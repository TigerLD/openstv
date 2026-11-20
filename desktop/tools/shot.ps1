# Captures the OpenSTV window to a PNG (used for smoke tests, not by the app).
param(
  [string]$Name = "electron",
  [int]$ProcessId = 0,
  [string]$Out = "$PSScriptRoot\..\shot.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

[WinCap]::SetProcessDPIAware() | Out-Null

$proc = $null
if ($ProcessId -ne 0) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
} else {
  $proc = Get-Process -Name $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}
if (-not $proc -or $proc.MainWindowHandle -eq 0) {
  "no window found (process '$Name' / id $ProcessId)"
  exit 1
}

$h = $proc.MainWindowHandle
[WinCap]::ShowWindow($h, 9) | Out-Null      # SW_RESTORE
[WinCap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1000

$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { "bad window rect"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

"saved $Out ($w x $ht)"
