@echo off
cd /d "%~dp0.."
title QQ Codex Bridge - GitHub Update
if not exist "data\updates" mkdir "data\updates"
copy /y "tools\update-bridge.ps1" "data\updates\update-runner.ps1" >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "data\updates\update-runner.ps1" -InstallRoot "%CD%" -Repository "Akusative/QQ-Codex-Bridge" -Restart
echo.
echo Update process finished. Check data\update-status.json for the final state.
pause
