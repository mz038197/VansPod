param([string]$Source = "$PSScriptRoot/../media/brand-logo.png", [string]$Output = "$PSScriptRoot/../media/brand-icon.ico")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath($Source))
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)
$frames = @()
try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
      $width = [int]($sourceImage.Width * $scale)
      $height = [int]($sourceImage.Height * $scale)
      $graphics.DrawImage($sourceImage, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames += ,$stream.ToArray()
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
  $outputStream = [System.IO.File]::Create([System.IO.Path]::GetFullPath($Output))
  $writer = New-Object System.IO.BinaryWriter($outputStream)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $encodedSize = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
      $writer.Write([byte]$encodedSize); $writer.Write([byte]$encodedSize)
      $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$frames[$index].Length); $writer.Write([uint32]$offset)
      $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
  } finally { $writer.Dispose(); $outputStream.Dispose() }
} finally { $sourceImage.Dispose() }
