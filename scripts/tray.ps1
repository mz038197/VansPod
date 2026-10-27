param(
  [Parameter(Mandatory = $true)]
  [string]$Url,
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$StateFile
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:OpenUrl = $Url
$openPage = { Start-Process $script:OpenUrl }.GetNewClosure()

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Object System.Drawing.Icon($IconPath)
$notify.Text = "VansPod"
$notify.Visible = $true
$notify.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { & $openPage } }.GetNewClosure())

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("開啟 VansPod")
$open.add_Click($openPage)
$stop = $menu.Items.Add("結束 VansPod")
$stop.add_Click({
  try {
    $state = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $headers = @{Authorization = 'Bearer ' + $state.token}
    $result = Invoke-RestMethod -Uri ($state.origin + '/_vanspod/stop') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 20
    if ($result.confirmation) {
      $answer = [System.Windows.Forms.MessageBox]::Show($result.message, 'VansPod', [System.Windows.Forms.MessageBoxButtons]::YesNo)
      if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { $result = Invoke-RestMethod -Uri ($state.origin + '/_vanspod/stop') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"confirmed":true}' -TimeoutSec 20 }
    }
    if (-not $result.ok -and -not $result.confirmation) { [System.Windows.Forms.MessageBox]::Show($result.message, 'VansPod') | Out-Null }
  } catch { [System.Windows.Forms.MessageBox]::Show('無法結束 VansPod，請開啟畫面後重試。', 'VansPod') | Out-Null }
})
$notify.ContextMenuStrip = $menu

try { [System.Windows.Forms.Application]::Run() }
finally { $notify.Visible = $false; $notify.Icon.Dispose(); $notify.Dispose(); $menu.Dispose() }

