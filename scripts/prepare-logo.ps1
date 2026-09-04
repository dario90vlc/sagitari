param(
  [string]$Src = "C:\Users\dario\Desktop\sagitari_logo_transparente.png",
  [string]$OutDir = "C:\Users\dario\Desktop\sagitari\renderer\assets",
  [string]$TmpDir = "C:\Users\dario\Desktop\sagitari\scripts\tmp_ico"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

$src = [System.Drawing.Bitmap]::FromFile($Src)
$W = $src.Width; $H = $src.Height
$hasAlpha = ($src.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::Alpha) -ne 0

# corners alpha (sampled)
function GetA($bmp, $x, $y) { return $bmp.GetPixel($x, $y).A }
$cornerA = @( (GetA $src 2 2), (GetA $src ($W-3) 2), (GetA $src 2 ($H-3)), (GetA $src ($W-3) ($H-3)) )

# per-row content detection (sampled every 6 px horizontally)
$rows = New-Object int[] $H
for ($y = 0; $y -lt $H; $y += 2) {
  $maxA = 0
  for ($x = 0; $x -lt $W; $x += 6) {
    $a = $src.GetPixel($x, $y).A
    if ($a -gt $maxA) { $maxA = $a }
  }
  $rows[$y] = $maxA
}
# find biggest run of empty rows between content blocks (mark vs wordmark)
$bestStart = -1; $bestLen = 0; $curStart = -1; $curLen = 0
$lastContentY = -1
for ($y = 0; $y -lt $H; $y += 2) {
  if ($rows[$y] -gt 10) {
    if ($lastContentY -ge 0) {
      $gap = $y - $lastContentY
      if ($gap -gt $bestLen) { $bestLen = $gap; $bestStart = $lastContentY }
    }
    $lastContentY = $y
  }
}
$gapCenter = if ($bestStart -ge 0) { $bestStart + [int]($bestLen / 2) } else { $H }
$markBottom = [Math]::Min($H, $gapCenter)
"$($W)x$($H) alpha=$hasAlpha cornersA=[$($cornerA -join ',')] gapAt=$bestStart len=$bestLen markBottom=$markBottom"

# bounding box of content in the mark region (top part)
$minX = $W; $minY = $H; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $markBottom; $y += 2) {
  for ($x = 0; $x -lt $W; $x += 2) {
    if ($src.GetPixel($x, $y).A -gt 10) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
"markBox=($minX,$minY)-($maxX,$maxY)"
$pad = [int](($maxX - $minX) * 0.04) + 4
$cropX = [Math]::Max(0, $minX - $pad); $cropY = [Math]::Max(0, $minY - $pad)
$cropW = [Math]::Min($W - $cropX, ($maxX - $minX) + 2 * $pad)
$cropH = [Math]::Min($H - $cropY, ($maxY - $minY) + 2 * $pad)
# square-ify
if ($cropW -gt $cropH) { $cropY = [Math]::Max(0, $cropY - [int](($cropW - $cropH) / 2)); $cropH = $cropW }
else { $cropX = [Math]::Max(0, $cropX - [int](($cropH - $cropW) / 2)); $cropW = $cropH }

$mark = New-Object System.Drawing.Bitmap $cropW, $cropH
$g = [System.Drawing.Graphics]::FromImage($mark)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $cropW, $cropH), $cropX, $cropY, $cropW, $cropH, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$mark.Save("$OutDir\sagitari-mark.png", [System.Drawing.Imaging.ImageFormat]::Png)
"markSaved=$OutDir\sagitari-mark.png ($cropW x $cropH)"

# full logo copy for branding/splash uses
$src.Save("$OutDir\logo-full.png", [System.Drawing.Imaging.ImageFormat]::Png)

# resize chain for ICO
foreach ($s in 256, 128, 64, 48, 32, 16) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g2.DrawImage($mark, 0, 0, $s, $s)
  $g2.Dispose()
  $bmp.Save("$TmpDir\mark_$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
"resizes done -> $TmpDir"
$src.Dispose(); $mark.Dispose()
