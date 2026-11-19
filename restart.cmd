@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $botLockPath=Join-Path (Get-Location).Path 'data\bot.lock'; if (Test-Path -LiteralPath $botLockPath) { $botLockInfo=Get-Item -LiteralPath $botLockPath; $botPidText=(Get-Content -LiteralPath $botLockPath -Raw).Trim(); if ($botPidText -notmatch '^[1-9]\d*$') { throw 'Invalid bot lock PID' }; $botProcessId=[int]$botPidText; $botProcess=Get-Process -Id $botProcessId -ErrorAction SilentlyContinue; if ($botProcess) { if ($botProcess.ProcessName -ne 'node') { throw 'Lock PID is not Node.js' }; $botStartDelay=($botLockInfo.LastWriteTimeUtc-$botProcess.StartTime.ToUniversalTime()).TotalSeconds; if ($botStartDelay -lt -1 -or $botStartDelay -gt 30) { throw 'Process does not match bot lock' }; if ((Get-Content -LiteralPath $botLockPath -Raw).Trim() -ne $botPidText) { throw 'Bot lock changed' }; Stop-Process -Id $botProcessId -ErrorAction Stop; Start-Sleep -Milliseconds 500; if (Get-Process -Id $botProcessId -ErrorAction SilentlyContinue) { throw 'Bot is still stopping; try again' } } }; exit 0"
if errorlevel 1 (
  echo Could not stop the old bot safely. Close its window and run start.cmd.
  pause
  exit /b 1
)
node src/main.mjs
pause

