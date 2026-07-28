@echo off
REM ABSoft - install the latest version from GitHub without touching the shop's data.
REM Keep this file pure ASCII: batch runs in the console's OEM codepage.
REM Developed by Abbass Chokor.
setlocal
title ABSoft Update
cd /d "%~dp0"

echo.
echo   ABSoft update
echo   ==========================================
echo.
echo   Close the ABSoft window first, then press a key.
echo   Your data folder is never touched by this script.
echo.
pause
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js was not found. Install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

echo   [1/3] Backing up the database...
call node --no-warnings server/tools/backup.js
if errorlevel 1 (
  echo.
  echo   [X] Backup failed - stopping here so nothing is put at risk.
  echo.
  pause
  exit /b 1
)
echo.

echo   [2/3] Downloading the new version...
where git >nul 2>nul
if errorlevel 1 goto :nogit

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :noclone

git pull --ff-only
if errorlevel 1 (
  echo.
  echo   [X] Update could not be applied automatically.
  echo.
  echo       This usually means files here were edited locally. To throw those
  echo       local edits away and take the published version exactly as-is:
  echo.
  echo           git reset --hard
  echo           git pull
  echo.
  echo       Your database lives in the data folder and is NOT affected by either
  echo       command. A fresh backup was just written to data\backups.
  echo.
  pause
  exit /b 1
)
echo.

echo   [3/3] Done.
call :report
exit /b 0

:nogit
echo.
echo   [!] Git is not installed, so this script cannot download the update.
echo.
echo       Either install Git from https://git-scm.com and run this again,
echo       or update by hand:
goto :manual

:noclone
echo.
echo   [!] This folder is not a Git clone, so there is nothing to pull from.
echo.
echo       Update by hand instead:
goto :manual

:manual
echo.
echo         1. Download the latest ZIP from your GitHub repository.
echo         2. Unzip it over this folder, replacing the files.
echo         3. Keep the "data" folder exactly as it is - that is your shop.
echo.
echo       A fresh backup was just written to data\backups.
echo.
pause
exit /b 1

:report
for /f "tokens=*" %%v in ('node --no-warnings -p "require('./package.json').version"') do set NEWVER=%%v
echo.
echo   ==========================================
echo   ABSoft is now version %NEWVER%.
echo.
echo   Start it with start.cmd. The database upgrades
echo   itself automatically the first time it runs.
echo.
pause
exit /b 0
