@echo off
chcp 65001 >nul
title Publish RAG-BOT to GitHub
cd /d "%~dp0"
node scripts/publish-github.mjs
pause
