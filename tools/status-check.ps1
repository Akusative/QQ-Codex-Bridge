$ErrorActionPreference = "SilentlyContinue"

Write-Host "QQ Codex Bridge low-resource status" -ForegroundColor Cyan
$volume = Get-Volume -DriveLetter C
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  FreeDiskGB = [math]::Round($volume.SizeRemaining / 1GB, 2)
  TotalMemoryGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
  FreeMemoryGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
  MemoryUsedPercent = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
} | Format-Table -AutoSize | Out-Host

Write-Host "`nPorts" -ForegroundColor Cyan
$ports = foreach ($port in 7897, 3000, 3001, 3080) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1
  [pscustomobject]@{
    Port = $port
    State = if ($listener) { "LISTEN" } else { "OFF" }
    Process = if ($listener) { (Get-Process -Id $listener.OwningProcess).ProcessName } else { "-" }
  }
}
$ports | Format-Table -AutoSize | Out-Host

Write-Host "`nProcess memory" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -match "node|codex|QQ|NapCat|verge|mihomo" } |
  Select-Object ProcessName, Id, @{N="MemoryMB";E={[math]::Round($_.WorkingSet64 / 1MB, 1)}} |
  Sort-Object MemoryMB -Descending |
  Format-Table -AutoSize | Out-Host
