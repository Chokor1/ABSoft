@echo off
REM ABSoft - double-click this file to run the point of sale system.
REM Keep this file pure ASCII: batch runs in the console's OEM codepage.
REM Developed by Abbass Chokor.
title ABSoft POS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install it from https://nodejs.org  ^(version 22.5 or newer^), then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting ABSoft...  keep this window open while you work.
echo   Close it (or press Ctrl+C) to shut the system down.
echo.

start "" http://127.0.0.1:4321
node --no-warnings server/index.js

echo.
echo   ABSoft has stopped.
pause
