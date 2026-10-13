param(
  [Parameter(Mandatory = $true)]
  [string]$Exe,
  [Parameter(Mandatory = $true)]
  [string]$Blob,
  [string]$Icon
)

$bytes = [System.IO.File]::ReadAllBytes($Blob)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SeaResource {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool discard);
}
"@

$handle = [SeaResource]::BeginUpdateResource($Exe, $false)
if ($handle -eq [IntPtr]::Zero) {
  Write-Error "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 1
}
$name = [Runtime.InteropServices.Marshal]::StringToHGlobalUni("NODE_SEA_BLOB")
try {
  $updated = [SeaResource]::UpdateResource($handle, [IntPtr]10, $name, 0, $bytes, [uint32]$bytes.Length)
  if (-not $updated) {
    Write-Error "UpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    [SeaResource]::EndUpdateResource($handle, $true) | Out-Null
    exit 1
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($name)
}
if ($Icon) {
  try {
    $iconBytes = [System.IO.File]::ReadAllBytes($Icon)
    $count = [BitConverter]::ToUInt16($iconBytes, 4)
    $groupStream = New-Object System.IO.MemoryStream
    $groupWriter = New-Object System.IO.BinaryWriter($groupStream)
    $groupWriter.Write([uint16]0); $groupWriter.Write([uint16]1); $groupWriter.Write([uint16]$count)
    for ($index = 0; $index -lt $count; $index++) {
      $entry = 6 + 16 * $index
      $length = [BitConverter]::ToUInt32($iconBytes, $entry + 8)
      $offset = [BitConverter]::ToUInt32($iconBytes, $entry + 12)
      $frame = New-Object byte[] $length
      [Array]::Copy($iconBytes, $offset, $frame, 0, $length)
      $resourceId = 1001 + $index
      if (-not [SeaResource]::UpdateResource($handle, [IntPtr]3, [IntPtr]$resourceId, 0, $frame, $length)) { throw 'Icon resource injection failed' }
      $groupWriter.Write($iconBytes, $entry, 12)
      $groupWriter.Write([uint16]$resourceId)
    }
    $groupWriter.Flush()
    $group = $groupStream.ToArray()
    foreach ($language in @(0, 1033)) {
      if (-not [SeaResource]::UpdateResource($handle, [IntPtr]14, [IntPtr]1, $language, $group, [uint32]$group.Length)) { throw 'Icon group injection failed' }
    }
    $groupWriter.Dispose(); $groupStream.Dispose()
  } catch {
    [SeaResource]::EndUpdateResource($handle, $true) | Out-Null
    throw
  }
}
if (-not [SeaResource]::EndUpdateResource($handle, $false)) {
  Write-Error "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 1
}
