param([string]$Plan = (Join-Path $PSScriptRoot 'uninstall-plan.json'))
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$planSource = [System.IO.File]::ReadAllText($Plan, $utf8)
$toolSource = [System.IO.File]::ReadAllText($PSCommandPath, $utf8)
$planData = $planSource | ConvertFrom-Json
$localRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $localRoot 'VansPod'))
$root = [System.IO.Path]::GetFullPath($planData.root)
$dataRoot = [System.IO.Path]::GetFullPath($planData.dataRoot)
if ($planData.version -ne 1 -or $root -ne $expectedRoot -or $dataRoot -ne [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.vanspod')) -or [System.IO.Path]::GetFullPath($Plan) -ne (Join-Path $root 'uninstall-plan.json')) { throw 'Invalid removal plan' }
[System.IO.File]::WriteAllText((Join-Path $root 'uninstall-ready'), 'ready', $utf8)

function Assert-NoLinks([string]$Target) {
  if (Test-Path -LiteralPath $Target) {
    $item = Get-Item -LiteralPath $Target -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "拒絕移除連結：$Target" }
    if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $Target -Force) { Assert-NoLinks $child.FullName } }
  }
}

function Remove-Owned([string]$Name, [string]$Directory = $root) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $Directory $Name))
  if (-not $target.StartsWith($Directory + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Removal target escaped VansPod data directory' }
  Assert-NoLinks $target
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

$failedTarget = $root
try {
  Assert-NoLinks $root
  Assert-NoLinks $dataRoot
  foreach ($processId in @($planData.pid, $planData.waitForPid)) {
    if ($processId) {
      for ($attempt = 0; $attempt -lt 300 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 100 }
      if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw 'VansPod 尚未退出，請結束後重試。' }
    }
  }
  foreach ($name in @('connection.json', 'settings.json', 'vscode-route-journal.json')) { $failedTarget = Join-Path $dataRoot $name; Remove-Owned $name $dataRoot }
  $legacyRoot = [System.IO.Path]::GetFullPath((Join-Path $localRoot 'classroom-app'))
  $failedTarget = Join-Path $legacyRoot 'connection.json'
  if (Test-Path -LiteralPath $legacyRoot) {
    if ((Get-Item -LiteralPath $legacyRoot -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw '拒絕清理舊憑證資料夾連結。' }
    Remove-Owned 'connection.json' $legacyRoot
    if (-not @(Get-ChildItem -LiteralPath $legacyRoot -Force).Count) { Remove-Item -LiteralPath $legacyRoot -Force }
  }
  if (Test-Path -LiteralPath $dataRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $dataRoot -File -Force) {
      if ($file.Name -match '^(connection\.json|settings\.json|vscode-route-journal\.json)\..*tmp$') { $failedTarget = $file.FullName; Remove-Owned $file.Name $dataRoot }
    }
    if (-not @(Get-ChildItem -LiteralPath $dataRoot -Force).Count) { Remove-Item -LiteralPath $dataRoot -Force }
  }
  foreach ($name in @('runtime', 'desktop-assets', 'logs', 'installations.lock', 'installations.json.tmp', 'removal-result.json', 'startup-error.json')) {
    $failedTarget = Join-Path $root $name
    Remove-Owned $name
  }
  foreach ($installation in $planData.installations) {
    if ($installation.kind -eq 'exe') {
      $failedTarget = $installation.file
      $target = [System.IO.Path]::GetFullPath($installation.file)
      if ([System.IO.Path]::GetExtension($target) -ne '.exe' -or $installation.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid executable registration' }
      Assert-NoLinks $target
      if (Test-Path -LiteralPath $target) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $actualHash = [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($target))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($actualHash -ne $installation.sha256) { throw '檔案內容已改變，請重新開啟該 VansPod 後重試移除。' }
        Remove-Item -LiteralPath $target -Force
      }
    } elseif ($installation.kind -eq 'npm') {
      $failedTarget = $installation.root
      $prefix = [System.IO.Path]::GetFullPath($installation.prefix)
      $packageRoot = [System.IO.Path]::GetFullPath($installation.root)
      if ($packageRoot -ne (Join-Path $prefix 'node_modules/vanspod')) { throw 'Invalid npm registration' }
      Assert-NoLinks $packageRoot
      if (Test-Path -LiteralPath $packageRoot) {
        $package = [System.IO.File]::ReadAllText((Join-Path $packageRoot 'package.json'), $utf8) | ConvertFrom-Json
        if ($package.name -ne 'vanspod' -or $package.bin.vanspod -ne 'bin/vanspod.cjs') { throw 'Registered package is not VansPod' }
        & $installation.node $installation.npmCli uninstall --global --prefix $prefix vanspod --ignore-scripts 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $packageRoot)) { throw 'npm 移除失敗。' }
      }
    } else { throw 'Unknown installation kind' }
  }
  foreach ($name in @('installations.json', 'uninstall-plan.json', 'uninstall-ready')) { $failedTarget = Join-Path $root $name; Remove-Owned $name }
  $failedTarget = $PSCommandPath
  Remove-Owned 'uninstall-tool.ps1'
  if (-not @(Get-ChildItem -LiteralPath $root -Force).Count) { Remove-Item -LiteralPath $root -Force }
  if (-not $planData.headless) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('VansPod 已完整移除。學生專案與獨立工具已保留；未登記的其他 exe 副本請自行刪除。', 'VansPod') | Out-Null }
} catch {
  # A late cleanup error may have already removed a control file. Re-create
  # the exact plan and tool so partial removal always remains retryable.
  if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
  Assert-NoLinks $root
  [System.IO.File]::WriteAllText((Join-Path $root 'uninstall-plan.json'), $planSource, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $root 'uninstall-tool.ps1'), $toolSource, (New-Object System.Text.UTF8Encoding($true)))
  $message = "移除未完成：$failedTarget`n$($_.Exception.Message)`n請重試完整移除；也可執行保留的 uninstall-tool.ps1，指定 uninstall-plan.json。"
  [System.IO.File]::WriteAllText((Join-Path $root 'removal-result.json'), (@{ok = $false; message = $message; remaining = $failedTarget} | ConvertTo-Json), $utf8)
  if (-not $planData.headless) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, 'VansPod') | Out-Null }
  exit 1
}
