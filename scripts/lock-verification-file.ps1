# Shared reads permit inspecting the original data while replacement/deletion are denied.
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::In.ReadToEnd() | Out-Null
} finally { $handle.Dispose() }
