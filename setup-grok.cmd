@echo off
chcp 65001 >nul
title Grok API setup
cd /d "%~dp0"
node scripts/setup-provider.mjs xai
pause
