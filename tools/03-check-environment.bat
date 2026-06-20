@echo off
cd /d "%~dp0.."
title QQ Codex Bridge - Environment Check
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7897 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  if not defined HTTP_PROXY set HTTP_PROXY=http://127.0.0.1:7897
  if not defined HTTPS_PROXY set HTTPS_PROXY=http://127.0.0.1:7897
)
node dist\scripts\check-env.js
echo.
echo Report only PASS or FAIL results. Never share .env contents.
pause
