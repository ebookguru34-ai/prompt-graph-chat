@echo off
setlocal
cd /d "%~dp0"
title Prompt Graph Chat
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist logs mkdir logs
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install > logs\install.log 2>&1
  if errorlevel 1 (
    echo npm install failed. See logs\install.log
    pause
    exit /b 1
  )
)
echo Starting. KoboldCPP should be running at http://localhost:5001
echo Open http://localhost:5173 in your browser. Logs go to logs\run.log
start "" http://localhost:5173
call npm run dev > logs\run.log 2>&1
echo App stopped. Send logs\install.log and logs\run.log if something broke.
pause
