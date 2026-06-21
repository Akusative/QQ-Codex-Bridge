[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$Repository = "Akusative/QQ-Codex-Bridge",
  [string]$ExpectedVersion = "",
  [int]$ParentProcessId = 0,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$AssetName = "QQ-Codex-Bridge-Windows-Update.zip"
$ChecksumName = "$AssetName.sha256"
$UpdateRoot = Join-Path $InstallRoot "data\updates"
$StatusPath = Join-Path $InstallRoot "data\update-status.json"
$LogPath = Join-Path $UpdateRoot "latest-update.log"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$DownloadRoot = Join-Path $UpdateRoot "download-$Timestamp"
$StagingRoot = Join-Path $UpdateRoot "staging-$Timestamp"
$BackupRoot = Join-Path $UpdateRoot "backup-$Timestamp"
$ProgramItems = @("dist", "tools", "package.json", "package-lock.json", "update-channel.json")
$BridgeWasStopped = $false

function Save-UpdateStatus {
  param([string]$State, [string]$Message, [string]$Version = "")
  $parent = Split-Path -Parent $StatusPath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$StatusPath.tmp"
  @{
    state = $State
    message = $Message
    version = $Version
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StatusPath -Force
}

function Get-BridgeWebUiPort {
  $port = 3080
  $envPath = Join-Path $InstallRoot ".env"
  if (Test-Path -LiteralPath $envPath) {
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*WEBUI_PORT\s*=\s*(\d+)\s*$' } | Select-Object -Last 1
    if ($line -and $line -match '^\s*WEBUI_PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
  }
  return $port
}

function Test-WebUiEnabled {
  $envPath = Join-Path $InstallRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return $true }
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*WEBUI_ENABLED\s*=' } | Select-Object -Last 1
  return -not ($line -match '^\s*WEBUI_ENABLED\s*=\s*false\s*$')
}

function Get-ProxyUri {
  if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
  try {
    $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 7897 -State Listen -ErrorAction Stop
    if ($listener) { return "http://127.0.0.1:7897" }
  } catch { }
  return $null
}

function Get-WebOptions {
  $options = @{
    Headers = @{
      Accept = "application/vnd.github+json"
      "User-Agent" = "QQ-Codex-Bridge-Updater"
      "X-GitHub-Api-Version" = "2022-11-28"
    }
    UseBasicParsing = $true
  }
  $proxy = Get-ProxyUri
  if ($proxy) { $options.Proxy = $proxy }
  return $options
}

function Convert-ToVersion {
  param([string]$Value)
  $normalized = $Value.Trim().TrimStart("v").Split("-")[0]
  if ($normalized -notmatch '^\d+\.\d+\.\d+$') { throw "Release version is invalid." }
  return [version]$normalized
}

function Stop-RunningBridge {
  if ($ParentProcessId -gt 0) {
    $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($parent) {
      Stop-Process -Id $ParentProcessId -Force
      $parent.WaitForExit()
    }
    return
  }

  $port = Get-BridgeWebUiPort
  $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return }
  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  if (-not $process -or $process.ProcessName -ne "node") {
    throw "The WebUI port is owned by another program; update stopped without changing files."
  }
  Stop-Process -Id $process.Id -Force
  $process.WaitForExit()
}

function Migrate-LegacyWebUiAuth {
  $legacyPath = Join-Path $InstallRoot "dist\data\webui-auth.json"
  $persistentPath = Join-Path $InstallRoot "data\webui-auth.json"
  if ((Test-Path -LiteralPath $legacyPath) -and -not (Test-Path -LiteralPath $persistentPath)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $persistentPath) -Force | Out-Null
    Copy-Item -LiteralPath $legacyPath -Destination $persistentPath
  }
}

function Copy-ProgramItems {
  param([string]$Source, [string]$Destination, [switch]$Replace)
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in $ProgramItems) {
    $sourcePath = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
    $destinationPath = Join-Path $Destination $name
    if ($Replace -and (Test-Path -LiteralPath $destinationPath)) {
      Remove-Item -LiteralPath $destinationPath -Recurse -Force
    }
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
  }
}

function Start-BridgeRuntime {
  $startScript = Join-Path $InstallRoot "tools\04-start-bridge.bat"
  if (-not (Test-Path -LiteralPath $startScript)) { throw "Bridge start script is missing." }
  return Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$startScript`"") -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
}

function Test-BridgeHealth {
  param([System.Diagnostics.Process]$StartedProcess)
  if (-not (Test-WebUiEnabled)) {
    Start-Sleep -Seconds 5
    return -not $StartedProcess.HasExited
  }
  $port = Get-BridgeWebUiPort
  for ($index = 0; $index -lt 30; $index++) {
    if ($StartedProcess.HasExited) { return $false }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/bootstrap" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "package.json"))) {
    throw "Install root does not contain package.json."
  }
  New-Item -ItemType Directory -Path $DownloadRoot, $StagingRoot, $BackupRoot -Force | Out-Null
  Save-UpdateStatus "checking" "Checking the latest stable GitHub Release."

  $package = Get-Content -LiteralPath (Join-Path $InstallRoot "package.json") -Raw | ConvertFrom-Json
  $currentVersion = Convert-ToVersion ([string]$package.version)
  $releaseUri = if ($ExpectedVersion) {
    "https://api.github.com/repos/$Repository/releases/tags/v$ExpectedVersion"
  } else {
    "https://api.github.com/repos/$Repository/releases/latest"
  }
  $webOptions = Get-WebOptions
  $release = Invoke-RestMethod -Uri $releaseUri @webOptions
  if ($release.draft -or $release.prerelease) { throw "Only stable GitHub Releases can be installed." }
  $releaseVersion = Convert-ToVersion ([string]$release.tag_name)
  if ($releaseVersion -le $currentVersion) {
    Save-UpdateStatus "current" "The installed version is already current." ([string]$currentVersion)
    exit 0
  }

  $archiveAsset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  $checksumAsset = $release.assets | Where-Object { $_.name -eq $ChecksumName } | Select-Object -First 1
  if (-not $archiveAsset -or -not $checksumAsset) { throw "Release assets are incomplete." }

  Save-UpdateStatus "downloading" "Downloading and verifying the update package." ([string]$releaseVersion)
  $archivePath = Join-Path $DownloadRoot $AssetName
  $checksumPath = Join-Path $DownloadRoot $ChecksumName
  Invoke-WebRequest -Uri $archiveAsset.browser_download_url -OutFile $archivePath @webOptions
  Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath @webOptions
  $checksumMatch = [regex]::Match((Get-Content -LiteralPath $checksumPath -Raw), '(?i)\b([a-f0-9]{64})\b')
  if (-not $checksumMatch.Success) { throw "Release checksum file is invalid." }
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  if ($actualHash -ne $checksumMatch.Groups[1].Value.ToUpperInvariant()) {
    throw "Update package checksum did not match."
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $StagingRoot -Force
  $manifestPath = Join-Path $StagingRoot "update-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Update manifest is missing." }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.repository -ne $Repository -or (Convert-ToVersion ([string]$manifest.version)) -ne $releaseVersion) {
    throw "Update manifest does not match this repository or version."
  }
  $allowedTopLevel = @("dist", "tools", "package.json", "package-lock.json", "update-channel.json", "update-manifest.json")
  foreach ($entry in Get-ChildItem -LiteralPath $StagingRoot -Force) {
    if ($allowedTopLevel -notcontains $entry.Name) { throw "Update package contains an unexpected top-level item." }
  }
  foreach ($required in @("dist", "tools", "package.json", "package-lock.json", "update-channel.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagingRoot $required))) { throw "Update package is incomplete." }
  }

  Save-UpdateStatus "installing" "Backing up program files and installing the update." ([string]$releaseVersion)
  Stop-RunningBridge
  $BridgeWasStopped = $true
  Migrate-LegacyWebUiAuth
  Copy-ProgramItems -Source $InstallRoot -Destination $BackupRoot
  Copy-ProgramItems -Source $StagingRoot -Destination $InstallRoot -Replace

  Push-Location $InstallRoot
  try {
    & npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund *> $LogPath
    if ($LASTEXITCODE -ne 0) { throw "Production dependency installation failed." }
  } finally {
    Pop-Location
  }

  if ($Restart) {
    $started = Start-BridgeRuntime
    if (-not (Test-BridgeHealth -StartedProcess $started)) { throw "Updated Bridge did not pass its health check." }
  }
  Save-UpdateStatus "succeeded" "Update installed successfully." ([string]$releaseVersion)
  Remove-Item -LiteralPath $DownloadRoot, $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  $failure = $_.Exception.Message
  if ($BridgeWasStopped -and (Test-Path -LiteralPath $BackupRoot)) {
    try {
      Copy-ProgramItems -Source $BackupRoot -Destination $InstallRoot -Replace
      if ($Restart) { Start-BridgeRuntime | Out-Null }
      $failure = "$failure Previous program files were restored."
    } catch {
      $failure = "$failure Automatic rollback also failed; use the backup under data\updates."
    }
  }
  Save-UpdateStatus "failed" $failure $ExpectedVersion
  Write-Error $failure
  exit 1
}
