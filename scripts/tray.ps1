param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:OpenUrl = $Url
$openPage = { Start-Process $script:OpenUrl }.GetNewClosure()

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "VansPod"
$notify.Visible = $true
$notify.add_Click($openPage)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("開啟 VansPod")
$open.add_Click($openPage)
$notify.ContextMenuStrip = $menu

[System.Windows.Forms.Application]::Run()

