@echo off
cd /d "%~dp0.."
title QQ Codex Bridge - Local Config

if not exist ".env" copy /y ".env.example" ".env" >nul
echo The private .env file will open in Notepad.
echo Fill ONEBOT_ACCESS_TOKEN and ALLOWED_QQ_USER_ID only on this server.
echo Never copy, screenshot, or send the file. Press Ctrl+S, then close Notepad.
pause
start "" notepad.exe "%CD%\.env"
