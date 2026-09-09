@echo off
REM ============================================================
REM  Relay - one-click deploy
REM  Commits every pending change and pushes to GitHub.
REM  Netlify builds automatically about 2 minutes after the push.
REM ============================================================
cd /d "%~dp0"
echo.
echo ===========================================
echo   RELAY DEPLOY
echo ===========================================
echo.
echo Folder: %CD%
echo.
echo --- Changes to be deployed -----------------
git status --short
echo --------------------------------------------
echo.
git add -A
git commit -m "TCPA: remove the bulk consent button; add a nationwide safe send window"
if errorlevel 1 (
  echo.
  echo Nothing new to commit - checking for unpushed work...
)
echo.
echo Pushing to GitHub...
git push
if errorlevel 1 (
  echo.
  echo ******************************************
  echo   PUSH FAILED - nothing was deployed.
  echo   Copy the message above and send it to Claude.
  echo ******************************************
) else (
  echo.
  echo ===========================================
  echo   DEPLOYED. Netlify builds in ~2 minutes.
  echo ===========================================
)
echo.
pause
