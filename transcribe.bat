@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Error: Node.js was not found.
  echo Install Node.js 18 or newer, then run this file again.
  exit /b 1
)

node "%~dp0transcribe.js" %*
exit /b %errorlevel%
