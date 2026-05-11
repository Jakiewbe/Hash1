param(
  [int]$CheckSeconds = $(if ($env:EQUIUM_WATCH_CHECK_SECONDS) { [int]$env:EQUIUM_WATCH_CHECK_SECONDS } else { 60 }),
  [int]$MaxRestarts = $(if ($env:EQUIUM_WATCH_MAX_RESTARTS) { [int]$env:EQUIUM_WATCH_MAX_RESTARTS } else { 0 }),
  [int]$BackoffSeconds = $(if ($env:EQUIUM_WATCH_BACKOFF_SECONDS) { [int]$env:EQUIUM_WATCH_BACKOFF_SECONDS } else { 20 })
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$LogRoot = Join-Path $RepoRoot ".equium-watch"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$WatchLog = Join-Path $LogRoot "watch.log"

function Write-Watch([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $WatchLog -Value $line
  Write-Host $line
}

function Managed-Miners {
  Get-CimInstance Win32_Process -Filter "name = 'equium-miner.exe' OR name = 'equium-miner'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*equium-miner*' -and $_.CommandLine -like '*--keypair*' }
}

function Start-Miners {
  Write-Watch "starting Equium miner wrapper"
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "run-equium.ps1") 2>&1
  $exit = $LASTEXITCODE
  foreach ($line in $out) {
    Add-Content -LiteralPath $WatchLog -Value ("  " + $line)
  }
  if ($exit -ne 0) {
    Write-Watch "wrapper exited with code $exit"
  }
}

$restarts = 0
Write-Watch "watchdog started; check=${CheckSeconds}s maxRestarts=${MaxRestarts}"

while ($true) {
  $miners = @(Managed-Miners)
  if ($miners.Count -eq 0) {
    if ($MaxRestarts -gt 0 -and $restarts -ge $MaxRestarts) {
      Write-Watch "max restarts reached; watchdog exiting"
      exit 1
    }
    $restarts += 1
    Write-Watch "no managed miners found; restart #$restarts"
    Start-Miners
    Start-Sleep -Seconds $BackoffSeconds
  } else {
    Write-Watch "miners running: $($miners.Count) pid(s): $($miners.ProcessId -join ',')"
    Start-Sleep -Seconds $CheckSeconds
  }
}
