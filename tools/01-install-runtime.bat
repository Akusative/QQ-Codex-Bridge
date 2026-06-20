@echo off
cd /d "%~dp0.."
title QQ Codex Bridge - Install Runtime

echo [1/4] Creating runtime directories...
if not exist "workspace" mkdir "workspace"
if not exist "bridge-data" mkdir "bridge-data"
if not exist "dist\data" mkdir "dist\data"
if not exist "memory-repo\approved\preferences" mkdir "memory-repo\approved\preferences"
if not exist "memory-repo\approved\people" mkdir "memory-repo\approved\people"
if not exist "memory-repo\approved\projects" mkdir "memory-repo\approved\projects"
if not exist "memory-repo\approved\events" mkdir "memory-repo\approved\events"
if not exist "memory-repo\approved\rules" mkdir "memory-repo\approved\rules"

echo [2/4] Installing production dependencies only...
call npm.cmd install --omit=dev
if errorlevel 1 goto :failed

echo [3/4] Initializing the local-only memory repository...
if not exist "memory-repo\.git" (
  git -C "memory-repo" init -b main
  if errorlevel 1 goto :failed
  git -C "memory-repo" config user.name "QQ Codex Bridge"
  git -C "memory-repo" config user.email "bridge@localhost"
  git -C "memory-repo" add .
  git -C "memory-repo" commit -m "Initialize local private memory repository"
  if errorlevel 1 goto :failed
)

echo [4/4] Verifying Node.js and Codex CLI...
node --version
call codex.cmd --version
echo.
echo INSTALL_OK
echo Configure NapCat before opening the private .env file.
pause
exit /b 0

:failed
echo.
echo INSTALL_FAILED
echo Keep this window open and report only the error lines. Never share credentials.
pause
exit /b 1
