param([string]$Plan = (Join-Path $PSScriptRoot 'update-plan.json'))
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$planData = [System.IO.File]::ReadAllText($Plan, $utf8) | ConvertFrom-Json
$localRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$root = [System.IO.Path]::GetFullPath($planData.root)
$installation = $planData.installation
if ($planData.version -ne 1 -or $root -ne [System.IO.Path]::GetFullPath((Join-Path $localRoot 'VansPod')) -or [System.IO.Path]::GetFullPath($Plan) -ne (Join-Path $root 'update-plan.json') -or $planData.target -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' -or $planData.from -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'Invalid update plan' }
if ($installation.kind -eq 'exe') {
  $file = [System.IO.Path]::GetFullPath($installation.file)
  if ([System.IO.Path]::GetExtension($file) -ne '.exe' -or [System.IO.Path]::GetFullPath($planData.download) -ne "$file.new") { throw 'Invalid update plan' }
} elseif ($installation.kind -ne 'npm') { throw 'Invalid update plan' }
[System.IO.File]::WriteAllText((Join-Path $root 'update-ready'), (@{pid = $PID} | ConvertTo-Json -Compress), $utf8)

function Write-Result([bool]$Ok, [string]$Message) {
  $value = [ordered]@{ ok = $Ok; from = $planData.from; target = $planData.target }
  if ($Message) { $value.message = $Message }
  [System.IO.File]::WriteAllText((Join-Path $root 'update-result.json'), ($value | ConvertTo-Json -Compress), $utf8)
}

function Read-Instance {
  try { return [System.IO.File]::ReadAllText((Join-Path $root 'runtime/instance.json'), $utf8) | ConvertFrom-Json } catch { return $null }
}

# 啟動指令等到 VansPod 就緒才結束；以結束碼與登記的版本判斷是否成功。
function Start-VansPod([string]$Expected) {
  $env:VANSPOD_RESTART = '1'
  # 工具是舊 worker 啟動的；帶著它的 token，launcher 會誤以為自己是 worker 而拒絕啟動。
  Remove-Item Env:VANSPOD_WORKER_TOKEN -ErrorAction SilentlyContinue
  $quoted = @($planData.start.args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $process = Start-Process -FilePath $planData.start.file -ArgumentList $quoted -WindowStyle Hidden -PassThru
  $null = $process.Handle  # 先取得 handle，結束後才讀得到 ExitCode。
  if (-not $process.WaitForExit(120000)) { try { $process.Kill() } catch {}; return $false }
  if ($process.ExitCode -ne 0) { return $false }
  $instance = Read-Instance
  return $instance -and $instance.version -eq $Expected
}

# 新版沒有就緒時，確保它的背景服務不會繼續佔用檔案。
function Stop-Target {
  $instance = Read-Instance
  if ($instance -and $instance.version -eq $planData.target) { Stop-Process -Id $instance.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  if ($installation.kind -eq 'exe') { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $file } | Stop-Process -Force -ErrorAction SilentlyContinue }
}

# 把 .old 換回原位；檔案可能還被剛結束的新版佔著，所以重試一陣子。學生不能因此失去 VansPod.exe。
function Restore-Exe {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
      Move-Item -LiteralPath "$file.old" -Destination $file
      return
    } catch { Start-Sleep -Milliseconds 250 }
  }
  throw "無法換回 v$($planData.from)，舊版保留在 $file.old。"
}

$restarted = $true
$stopped = $false
try {
  for ($attempt = 0; $attempt -lt 600 -and (Get-Process -Id $planData.pid -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id $planData.pid -ErrorAction SilentlyContinue) { throw '舊版 VansPod 沒有結束，更新已取消。' }
  $stopped = $true
  if ($installation.kind -eq 'exe') {
    $old = "$file.old"
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
    Move-Item -LiteralPath $file -Destination $old
    try { Move-Item -LiteralPath "$file.new" -Destination $file }
    catch { Restore-Exe; throw "新版 VansPod.exe 無法放到原位置（$($_.Exception.Message)）" }
    if (Start-VansPod $planData.target) { Remove-Item -LiteralPath $old -Force; Write-Result $true }
    else {
      Stop-Target
      Restore-Exe
      $restarted = Start-VansPod $planData.from
      Write-Result $false "v$($planData.target) 無法啟動，已換回 v$($planData.from)。"
    }
  } else {
    $ErrorActionPreference = 'Continue'
    $output = & $installation.node $installation.npmCli install --global --prefix $installation.prefix "vanspod@$($planData.target)" 2>&1
    $installed = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $installed) {
      $restarted = Start-VansPod $planData.from
      $reason = @($output | ForEach-Object { "$_" } | Where-Object { $_.Trim() }) | Select-Object -Last 1
      Write-Result $false "npm 安裝失敗（$reason）。已保留 v$($planData.from)。可改用：npm install -g vanspod@$($planData.target)"
    } elseif (Start-VansPod $planData.target) { Write-Result $true }
    else {
      Stop-Target
      $restarted = $false
      Write-Result $false "已安裝 v$($planData.target)，但無法啟動。請執行 vanspod start 查看錯誤，或用 npm install -g vanspod@$($planData.from) 換回舊版。"
    }
  }
} catch {
  Write-Result $false "更新未完成：$($_.Exception.Message)"
  # 舊版已經結束時，盡量讓學生回到原本的版本。
  $restarted = $stopped -and (Start-VansPod $planData.from)
  if ($installation.kind -eq 'exe') { Remove-Item -LiteralPath "$file.new" -Force -ErrorAction SilentlyContinue }
} finally {
  foreach ($name in @('update-plan.json', 'update-ready')) { Remove-Item -LiteralPath (Join-Path $root $name) -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
$result = [System.IO.File]::ReadAllText((Join-Path $root 'update-result.json'), $utf8) | ConvertFrom-Json
# VansPod 沒有重新啟動時，頁面看不到結果，改用 Windows 訊息告知。
if (-not $restarted -and -not $planData.headless) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($result.message, 'VansPod') | Out-Null }
if (-not $result.ok) { exit 1 }
