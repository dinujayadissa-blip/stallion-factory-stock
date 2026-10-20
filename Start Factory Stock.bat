@echo off
title Factory Stock
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install --omit=dev
)
echo.
set NODE_ENV=production
node server.js
pause
