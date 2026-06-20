@echo off
cd /d "%~dp0.."
title QQ Codex Bridge - Cloud Runtime
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7897 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  if not defined HTTP_PROXY set HTTP_PROXY=http://127.0.0.1:7897
  if not defined HTTPS_PROXY set HTTPS_PROXY=http://127.0.0.1:7897
  set NODE_USE_ENV_PROXY=1
)
set NO_COLOR=1
node dist\src\index.js
echo.
echo Bridge stopped. Share error types and port status only, never credentials.
pause
