param(
  [string]$RpcUrl = $env:EQUIUM_RPC_URL,
  [string]$KeypairsFile = $env:EQUIUM_KEYPAIRS_FILE,
  [int]$WorkersPerKeypair = -1,
  [long]$MaxBlocks = -1,
  [long]$MaxNoncesPerRound = -1,
  [int]$CuLimit = -1,
  [switch]$Update,
  [switch]$BuildOnly,
  [switch]$ValidateKeypairs,
  [switch]$Foreground,
  [switch]$Status,
  [switch]$Stop
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$CacheDir = if ($env:EQUIUM_CACHE_DIR) { $env:EQUIUM_CACHE_DIR } elseif (Test-Path "D:\") { "D:\equium-miner-cache" } else { Join-Path $RepoRoot ".equium-miner" }
$SourceParent = Join-Path $CacheDir "upstream"
$ZipPath = Join-Path $CacheDir "equium-master.zip"
$LogsDir = Join-Path $CacheDir "logs"
$SourceDir = Join-Path $SourceParent "equium-master"
$ExeName = if ($IsWindows -or $env:OS -eq "Windows_NT") { "equium-miner.exe" } else { "equium-miner" }
$BinaryPath = Join-Path $SourceDir "target\release\$ExeName"
$RepoZipUrl = "https://codeload.github.com/HannaPrints/equium/zip/refs/heads/master"

function Load-DotEnv([string]$File) {
  if (-not (Test-Path $File)) { return }
  foreach ($raw in Get-Content -LiteralPath $File) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

Load-DotEnv (Join-Path $RepoRoot ".env")

$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $CargoBin) -and ($env:Path -notlike "*$CargoBin*")) {
  $env:Path = "$CargoBin;$env:Path"
}
$OpenSslRootCandidates = @(
  $env:OPENSSL_DIR,
  "C:\Program Files\OpenSSL-Win64",
  "D:\OpenSSL-Win64"
) | Where-Object { $_ -and (Test-Path $_) }
if ($OpenSslRootCandidates.Count -gt 0) {
  $OpenSslRoot = $OpenSslRootCandidates[0]
  if (-not $env:OPENSSL_DIR) {
    $env:OPENSSL_DIR = $OpenSslRoot
  }
  $OpenSslLib = Join-Path $OpenSslRoot "lib\VC\x64\MD"
  $OpenSslInclude = Join-Path $OpenSslRoot "include"
  if ((Test-Path $OpenSslLib) -and -not $env:OPENSSL_LIB_DIR) {
    $env:OPENSSL_LIB_DIR = $OpenSslLib
  }
  if ((Test-Path $OpenSslInclude) -and -not $env:OPENSSL_INCLUDE_DIR) {
    $env:OPENSSL_INCLUDE_DIR = $OpenSslInclude
  }
  $OpenSslBin = Join-Path $OpenSslRoot "bin"
  if ((Test-Path $OpenSslBin) -and ($env:Path -notlike "*$OpenSslBin*")) {
    $env:Path = "$OpenSslBin;$env:Path"
  }
}

if (-not $RpcUrl) {
  $RpcUrl = if ($env:EQUIUM_RPC_URL) { $env:EQUIUM_RPC_URL } else { "https://api.mainnet-beta.solana.com" }
}
if (-not $KeypairsFile) {
  $KeypairsFile = if ($env:EQUIUM_KEYPAIRS_FILE) { $env:EQUIUM_KEYPAIRS_FILE } else { Join-Path $ScriptDir "keypairs.txt" }
}
if ($WorkersPerKeypair -lt 0) {
  $WorkersPerKeypair = if ($env:EQUIUM_WORKERS_PER_KEYPAIR) { [int]$env:EQUIUM_WORKERS_PER_KEYPAIR } else { 1 }
}
if ($MaxBlocks -lt 0) {
  $MaxBlocks = if ($env:EQUIUM_MAX_BLOCKS) { [long]$env:EQUIUM_MAX_BLOCKS } else { 0 }
}
if ($MaxNoncesPerRound -lt 0) {
  $MaxNoncesPerRound = if ($env:EQUIUM_MAX_NONCES_PER_ROUND) { [long]$env:EQUIUM_MAX_NONCES_PER_ROUND } else { 4096 }
}
if ($CuLimit -lt 0) {
  $CuLimit = if ($env:EQUIUM_CU_LIMIT) { [int]$env:EQUIUM_CU_LIMIT } else { 1400000 }
}

function Write-Step([string]$Message) {
  Write-Host "[equium] $Message"
}

function Resolve-RepoPath([string]$PathValue) {
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return (Resolve-Path -LiteralPath $PathValue).Path
  }
  return (Resolve-Path -LiteralPath (Join-Path $RepoRoot $PathValue)).Path
}

function Decode-Base58([string]$Value) {
  $alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  $bytes = New-Object System.Collections.Generic.List[byte]
  $bytes.Add(0)
  foreach ($ch in $Value.ToCharArray()) {
    $carry = $alphabet.IndexOf($ch)
    if ($carry -lt 0) {
      throw "invalid base58 keypair character"
    }
    for ($i = 0; $i -lt $bytes.Count; $i++) {
      $carry += [int]$bytes[$i] * 58
      $bytes[$i] = [byte]($carry -band 0xff)
      $carry = [math]::Floor($carry / 256)
    }
    while ($carry -gt 0) {
      $bytes.Add([byte]($carry -band 0xff))
      $carry = [math]::Floor($carry / 256)
    }
  }
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '1') {
      $bytes.Add(0)
    } else {
      break
    }
  }
  $arr = $bytes.ToArray()
  [array]::Reverse($arr)
  return $arr
}

function Materialize-Keypair([string]$Value, [int]$Index) {
  $line = ($Value -split "#", 2)[0].Trim()
  if (-not $line) { return $null }

  if ((Test-Path $line) -or [System.IO.Path]::IsPathRooted($line) -or $line.StartsWith(".")) {
    return (Resolve-RepoPath $line)
  }

  $keypairDir = Join-Path $CacheDir "keypairs"
  New-Item -ItemType Directory -Force -Path $keypairDir | Out-Null
  $dest = Join-Path $keypairDir ("keypair-{0}.json" -f $Index)

  if ($line.StartsWith("[")) {
    try {
      $items = $line | ConvertFrom-Json
      if ($items.Count -ne 64) {
        throw "Solana keypair JSON must contain 64 bytes"
      }
      Set-Content -LiteralPath $dest -Encoding ascii -Value ($items | ConvertTo-Json -Compress)
      return $dest
    } catch {
      throw "invalid inline Solana keypair JSON in keypairs file"
    }
  }

  if ($line -match '^[1-9A-HJ-NP-Za-km-z]{80,}$') {
    $decoded = Decode-Base58 $line
    if ($decoded.Length -ne 64) {
      throw "base58 Solana keypair decoded to $($decoded.Length) bytes; expected 64"
    }
    Set-Content -LiteralPath $dest -Encoding ascii -Value (($decoded | ForEach-Object { [int]$_ }) | ConvertTo-Json -Compress)
    return $dest
  }

  throw "keypairs file entry is not an existing path, JSON array, or base58 Solana keypair"
}

function Ensure-UpstreamSource {
  New-Item -ItemType Directory -Force -Path $CacheDir, $SourceParent, $LogsDir | Out-Null
  if ($Update -and (Test-Path $SourceDir)) {
    Remove-Item -Recurse -Force -LiteralPath $SourceDir
  }
  if (Test-Path $SourceDir) {
    return
  }

  Write-Step "downloading official Equium source"
  if (Test-Path $ZipPath) {
    Remove-Item -Force -LiteralPath $ZipPath
  }
  Invoke-WebRequest -Uri $RepoZipUrl -OutFile $ZipPath
  $tmp = Join-Path $CacheDir "extract"
  if (Test-Path $tmp) {
    Remove-Item -Recurse -Force -LiteralPath $tmp
  }
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $tmp
  $expanded = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $expanded) {
    throw "Downloaded archive did not contain a source directory."
  }
  if (Test-Path $SourceDir) {
    Remove-Item -Recurse -Force -LiteralPath $SourceDir
  }
  Move-Item -LiteralPath $expanded.FullName -Destination $SourceDir
  Remove-Item -Recurse -Force -LiteralPath $tmp
}

function Ensure-Binary {
  Ensure-UpstreamSource
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargo) {
    throw "Rust/Cargo is not installed. Install Rust from https://rustup.rs or run: winget install Rustlang.Rustup"
  }
  if ($Update -or -not (Test-Path $BinaryPath)) {
    Write-Step "building official CLI miner"
    Push-Location $SourceDir
    try {
      & cargo build -p equium-cli-miner --release
      if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed with exit code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  }
  if (-not (Test-Path $BinaryPath)) {
    throw "Miner binary was not produced at $BinaryPath"
  }
}

function Read-Keypairs {
  $items = @()
  if ($env:EQUIUM_KEYPAIRS) {
    $items += ($env:EQUIUM_KEYPAIRS -split "[;`r`n]+")
  }
  if (Test-Path $KeypairsFile) {
    $items += (Get-Content -LiteralPath $KeypairsFile)
  }

  $out = New-Object System.Collections.Generic.List[string]
  $index = 1
  foreach ($raw in $items) {
    $line = ($raw -split "#", 2)[0].Trim()
    if (-not $line) { continue }
    if ($line.StartsWith("[") -or $line -match '^[1-9A-HJ-NP-Za-km-z]{80,}$') {
      $out.Add((Materialize-Keypair $line $index))
      $index += 1
      continue
    }
    foreach ($part in ($line -split "[,\s]+")) {
      $materialized = Materialize-Keypair $part $index
      if ($materialized) {
        $out.Add($materialized)
        $index += 1
      }
    }
  }
  return $out
}

function Get-EquiumProcesses {
  $needle = [System.IO.Path]::GetFullPath($BinaryPath)
  Get-CimInstance Win32_Process -Filter "name = 'equium-miner.exe' OR name = 'equium-miner'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $needle)
    }
}

if ($Status) {
  $procs = @(Get-EquiumProcesses)
  if (-not $procs.Count) {
    Write-Step "no managed Equium miner processes are running"
    exit 0
  }
  $procs | Select-Object ProcessId, CommandLine
  exit 0
}

if ($Stop) {
  $procs = @(Get-EquiumProcesses)
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force
  }
  Write-Step "stopped $($procs.Count) managed Equium miner process(es)"
  exit 0
}

if ($ValidateKeypairs) {
  $keypairs = @(Read-Keypairs)
  if (-not $keypairs.Count) {
    throw "No Solana keypair files found. Add one path, JSON array, or base58 keypair per line to $KeypairsFile or set EQUIUM_KEYPAIRS."
  }
  Write-Step "validated $($keypairs.Count) keypair entry/entries"
  exit 0
}

Ensure-Binary
if ($BuildOnly) {
  Write-Step "binary ready: $BinaryPath"
  exit 0
}

$keypairs = @(Read-Keypairs)
if (-not $keypairs.Count) {
  throw "No Solana keypair files found. Add one path per line to $KeypairsFile or set EQUIUM_KEYPAIRS."
}
if ($WorkersPerKeypair -lt 1) {
  $WorkersPerKeypair = 1
}

Write-Step "RPC: $RpcUrl"
Write-Step "keypairs: $($keypairs.Count), workers per keypair: $WorkersPerKeypair"

if ($Foreground) {
  if ($keypairs.Count -ne 1 -or $WorkersPerKeypair -ne 1) {
    throw "-Foreground supports exactly one keypair and one worker."
  }
  & $BinaryPath --rpc-url $RpcUrl --keypair $keypairs[0] --max-blocks $MaxBlocks --max-nonces-per-round $MaxNoncesPerRound --cu-limit $CuLimit
  exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$started = 0
for ($i = 0; $i -lt $keypairs.Count; $i++) {
  for ($w = 0; $w -lt $WorkersPerKeypair; $w++) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outLog = Join-Path $LogsDir ("miner-{0}-w{1}-{2}.out.log" -f ($i + 1), ($w + 1), $stamp)
    $errLog = Join-Path $LogsDir ("miner-{0}-w{1}-{2}.err.log" -f ($i + 1), ($w + 1), $stamp)
    $args = @(
      "--rpc-url", $RpcUrl,
      "--keypair", $keypairs[$i],
      "--max-blocks", "$MaxBlocks",
      "--max-nonces-per-round", "$MaxNoncesPerRound",
      "--cu-limit", "$CuLimit"
    )
    $proc = Start-Process -FilePath $BinaryPath -ArgumentList $args -WorkingDirectory $SourceDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $started += 1
    Write-Step ("started keypair #{0} worker #{1}: pid {2}, log {3}" -f ($i + 1), ($w + 1), $proc.Id, $outLog)
  }
}

Write-Step "started $started miner process(es)"
