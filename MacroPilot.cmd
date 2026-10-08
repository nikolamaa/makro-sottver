@echo off
rem Double-click to start MacroPilot (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Download it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node scripts\launch.mjs
if errorlevel 1 pause
