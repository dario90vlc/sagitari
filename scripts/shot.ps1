param([string]$Out = "shot.png", [string]$Bg = "#0b0f14")

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match '^(electron|SAGITARI)$') } |
  Where-Object { $p = $_.MainWindowTitle; $p -match 'SAGITARI' } | Select-Object -First 1
if (-not $proc) { Write-Error "SAGITARI window not found"; exit 1 }

$h = $proc.MainWindowHandle
[Win32Shot]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400

$r = New-Object Win32Shot+RECT
[Win32Shot]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { Write-Error "Bad window rect"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pw = $g.GetHdc()
$ok = [Win32Shot]::PrintWindow($h, $pw, 2)   # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($pw); $g.Dispose()

if ($ok) {
  # composite onto solid background so rounded/transparent corners look right on GitHub
  $canvas = New-Object System.Drawing.Bitmap $w, $hh
  $cg = [System.Drawing.Graphics]::FromImage($canvas)
  $c = [System.Drawing.ColorTranslator]::FromHtml($Bg)
  $cg.Clear($c)
  $cg.DrawImage($bmp, 0, 0, $w, $hh)
  $cg.Dispose()
  $canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}
$bmp.Dispose()
if ($ok) { Write-Output "OK $w x $hh -> $Out" } else { Write-Error "PrintWindow failed"; exit 1 }
