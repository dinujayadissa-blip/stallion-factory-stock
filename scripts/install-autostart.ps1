# Makes Factory Stock start by itself when the office PC starts (even before anyone logs in), and
# start again if it stops because of an error. Run once, as administrator:
#   powershell -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1" -BackupDir "E:\Factory Stock backups"
# -BackupDir (optional) also adds a backup every day at 5:30 pm to that folder (another drive,
# USB stick or cloud-synced folder - not this disk).
# To take it all off again:  ... install-autostart.ps1 -Remove
param([string]$BackupDir = '', [switch]$Remove)
$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this as administrator (right-click PowerShell > Run as administrator).'; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
$task = 'Factory Stock'
$backupTask = 'Factory Stock backup'
$rule = 'Factory Stock'

if ($Remove) {
  foreach ($t in @($task, $backupTask)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
    }
  }
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host 'Auto-start, daily backup and firewall rule removed. (Stop any running copy with Task Manager > node.exe.)'
  exit 0
}

# The task runs as SYSTEM, so Node must be installed for all users (the normal Node.js installer).
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { Write-Host "Node.js not found at $node - install Node.js 24 LTS with the normal installer first."; exit 1 }
if (-not (Test-Path (Join-Path $root 'node_modules'))) { Write-Host 'node_modules is missing - run "npm install --omit=dev" in the app folder first.'; exit 1 }
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null

if ($BackupDir) {
  # Tidy the folder name: stray spaces/quotes, and no "\" at the end - on the task's command line
  # "E:\" would end with \" and Node would read a quote instead of the end of the folder name.
  $BackupDir = $BackupDir.Trim().Trim('"').Trim()
  $BackupDir = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $BackupDir)).TrimEnd('\')
  if ($BackupDir -match '^[A-Za-z]:' -and [IO.DriveInfo]::new($BackupDir.Substring(0, 1)).DriveType -eq 'Network') {
    Write-Host "$($BackupDir.Substring(0, 2)) is a mapped network drive - the daily backup can't see those."
    Write-Host 'Use a USB stick, a second disk, a cloud-synced folder, or the full \\server\share\folder address.'
    exit 1
  }
  try {
    if ($BackupDir -match '^[A-Za-z]:$') {   # a drive root such as E:\ is passed on as E:\.
      if (-not (Test-Path ($BackupDir + '\'))) { throw 'no drive' }
      $BackupDir += '\.'
    } else { New-Item -ItemType Directory -Force $BackupDir | Out-Null }
  } catch {
    Write-Host "Can't use the backup folder $BackupDir - is the drive plugged in? (Mapped network drive letters"
    Write-Host "don't work here.) Nothing was set up."
    exit 1
  }
  # Make one backup now with the exact command the daily task will use, so a wrong folder shows up now.
  $bArgs = '/c ""' + $node + '" scripts\backup.js "' + $BackupDir + '" >> logs\backup.log 2>&1"'
  $logFile = Join-Path $root 'logs\backup.log'
  $before = @(if (Test-Path $logFile) { Get-Content $logFile }).Count
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $bArgs -WorkingDirectory $root -NoNewWindow -Wait -PassThru
  $newLines = @(if (Test-Path $logFile) { Get-Content $logFile }) | Select-Object -Skip $before
  $newLines | Where-Object { $_ -match 'Backup saved|Already backed up|Backup FAILED|Note:|cloud-synced' } | ForEach-Object { Write-Host $_ }
  if ($p.ExitCode -ne 0 -or -not ($newLines -match 'Backup saved|Already backed up')) {
    Write-Host "The test backup to $BackupDir did not work (details in logs\backup.log). Nothing was set up -"
    Write-Host 'fix the folder and run this again.'
    exit 1
  }
}

# Never stopped for running too long (the default stops a task after 3 days), runs on battery,
# is restarted by Windows too if the whole loop ever fails, and runs at normal priority (the default
# for tasks is below normal, which makes the app slow when the PC is busy).
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew -Priority 4
# Note for when login / remote access is added: this runs as SYSTEM (full control of the PC). Then
# consider a standard local account with Modify rights on the app folder only.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $root 'scripts\run-forever.bat') + '"') -WorkingDirectory $root
Register-ScheduledTask -TaskName $task -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Added: '$task' starts the app when the PC starts."

if ($BackupDir) {
  $bSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $bAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $bArgs -WorkingDirectory $root
  Register-ScheduledTask -TaskName $backupTask -Action $bAction -Trigger (New-ScheduledTaskTrigger -Daily -At '17:30') -Settings $bSettings -Principal $principal -Force | Out-Null
  Write-Host "Added: '$backupTask' backs up to $($BackupDir -replace '\\\.$', '\') every day at 5:30 pm (log: logs\backup.log)."
}

# A task running as SYSTEM never gets the "allow through firewall" question, so allow port 3000 here
# (private networks only - set the office network to Private).
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow | Out-Null
}
Write-Host "Added: firewall rule '$rule' (port 3000, private networks)."

Start-ScheduledTask -TaskName $task
Write-Host 'Started. Open http://localhost:3000 in a minute. Log: logs\server.log'
