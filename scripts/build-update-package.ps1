[CmdletBinding()]
param(
  [string]$OutputDirectory = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ProjectRoot "release-artifacts" }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$AssetName = "QQ-Codex-Bridge-Windows-Update.zip"
$StageRoot = Join-Path $OutputDirectory "update-stage"
$ArchivePath = Join-Path $OutputDirectory $AssetName
$ChecksumPath = "$ArchivePath.sha256"

if (-not $SkipBuild) {
  Push-Location $ProjectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed." }
  } finally {
    Pop-Location
  }
}

Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $StageRoot "dist"), $OutputDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "dist\src") -Destination (Join-Path $StageRoot "dist\src") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "dist\scripts") -Destination (Join-Path $StageRoot "dist\scripts") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "webui") -Destination (Join-Path $StageRoot "dist\webui") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "scripts\extract-persona-document.py") -Destination (Join-Path $StageRoot "dist\scripts\extract-persona-document.py") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "tools") -Destination (Join-Path $StageRoot "tools") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "package.json"), (Join-Path $ProjectRoot "package-lock.json"), (Join-Path $ProjectRoot "update-channel.json") -Destination $StageRoot -Force

@{
  schemaVersion = 1
  version = $Version
  repository = "Akusative/QQ-Codex-Bridge"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  preserves = @(".env", "bridge-data", "data", "workspace", "memory-repo", "logs")
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $StageRoot "update-manifest.json") -Encoding UTF8

Remove-Item -LiteralPath $ArchivePath, $ChecksumPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $StageRoot "*") -DestinationPath $ArchivePath -CompressionLevel Optimal
$Hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
"$Hash  $AssetName" | Set-Content -LiteralPath $ChecksumPath -Encoding ASCII
Remove-Item -LiteralPath $StageRoot -Recurse -Force

Write-Output $ArchivePath
Write-Output $ChecksumPath
