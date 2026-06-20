[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][int]$ParentProcessId
)

$ErrorActionPreference = "Stop"
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$StartScript = Join-Path $InstallRoot "tools\04-start-bridge.bat"
$StatusPath = Join-Path $InstallRoot "data\restart-status.json"

function Save-RestartStatus {
  param([string]$State, [string]$Message)
  $parent = Split-Path -Parent $StatusPath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  @{
    state = $State
    message = $Message
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding UTF8
}

try {
  if (-not (Test-Path -LiteralPath $StartScript)) {
    throw "Bridge start script is missing."
  }
  Save-RestartStatus "scheduled" "Bridge restart was requested from WebUI."
  Start-Sleep -Milliseconds 1200
  $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
  if ($parent) {
    Stop-Process -Id $ParentProcessId -Force
    $parent.WaitForExit()
  }
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$StartScript`"") -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
  Save-RestartStatus "started" "Bridge restart process was launched."
} catch {
  Save-RestartStatus "failed" "Bridge restart failed."
  exit 1
}
