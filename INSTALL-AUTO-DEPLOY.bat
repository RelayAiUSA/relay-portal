@echo off
cd /d "%~dp0"
echo.
echo =================================================
echo   RELAY AUTO-DEPLOY - one-time setup
echo =================================================
echo.
echo This registers a background task that checks once a
echo minute for a deploy request from Claude, and ships it.
echo.
echo You will never need to run anything again.
echo.

schtasks /create /tn "RelayAutoDeploy" /tr "\"C:\Users\kings\relay-portal\relay-auto-deploy.bat\"" /sc minute /mo 1 /f

if errorlevel 1 (
  echo.
  echo *************************************************
  echo   SETUP FAILED - send this window to Claude.
  echo *************************************************
) else (
  echo.
  echo =================================================
  echo   DONE. Deploys are now automatic.
  echo   Nothing else to run, ever.
  echo =================================================
)
echo.
pause
