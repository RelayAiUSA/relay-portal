@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  RELAY DEPLOY v2
REM  Identity is passed inline with -c, so it cannot fail on a
REM  missing git config. Verifies the REMOTE moved before
REM  claiming anything shipped.
REM ============================================================
cd /d "%~dp0"

echo.
echo ===========================================
echo   RELAY DEPLOY  v2
echo ===========================================
echo.
echo Folder: %CD%
echo.

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set BEFORE=%%i
echo Local commit before: !BEFORE!
echo.

echo --- Changes to be deployed -----------------
git status --short
echo --------------------------------------------
echo.

git add -A

REM Identity supplied inline - no global config needed, cannot fail.
git -c user.name="Clyde Pryor" -c user.email="pryorpropertysolutions269@gmail.com" commit -m "TCPA: remove the bulk consent button; add a nationwide safe send window"

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set AFTER=%%i
echo.
echo Local commit after : !AFTER!

if "!BEFORE!"=="!AFTER!" (
  echo.
  echo ******************************************
  echo   NO COMMIT WAS CREATED - nothing shipped.
  echo   Send the text above to Claude.
  echo ******************************************
  echo.
  pause
  exit /b 1
)

echo.
echo Pushing to GitHub...
echo.
git push origin main

echo.
echo Verifying against GitHub...
set REMOTE=
for /f "tokens=1" %%i in ('git ls-remote origin refs/heads/main 2^>nul') do set REMOTE=%%i
echo Remote commit now  : !REMOTE!

if "!REMOTE!"=="!AFTER!" (
  echo.
  echo ===========================================
  echo   DEPLOYED - VERIFIED ON GITHUB.
  echo   Netlify builds in about 2 minutes.
  echo ===========================================
) else (
  echo.
  echo ******************************************
  echo   PUSH DID NOT LAND. Nothing deployed.
  echo   Send this whole window to Claude.
  echo ******************************************
)

echo.
pause
