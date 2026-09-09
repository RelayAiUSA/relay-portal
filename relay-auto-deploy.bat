@echo off
setlocal enabledelayedexpansion
cd /d "C:\Users\kings\relay-portal"

REM Do nothing at all unless Claude has dropped a trigger file.
if not exist ".deploy-trigger" exit /b 0

set LOG=deploy-log.txt
echo ============================================ > "%LOG%"
echo RELAY AUTO-DEPLOY  %DATE% %TIME%            >> "%LOG%"
echo ============================================ >> "%LOG%"

REM The trigger file's first line is the commit message.
set MSG=Automated deploy
for /f "usebackq delims=" %%m in (".deploy-trigger") do (
  if not "%%m"=="" set MSG=%%m
  goto :gotmsg
)
:gotmsg

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set BEFORE=%%i
echo Local before: !BEFORE! >> "%LOG%"

git status --short >> "%LOG%" 2>&1
git add -A >> "%LOG%" 2>&1
git -c user.name="Clyde Pryor" -c user.email="pryorpropertysolutions269@gmail.com" commit -m "!MSG!" >> "%LOG%" 2>&1

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set AFTER=%%i
echo Local after : !AFTER! >> "%LOG%"

if "!BEFORE!"=="!AFTER!" (
  echo RESULT: NO_COMMIT_CREATED >> "%LOG%"
  del ".deploy-trigger"
  exit /b 0
)

git push origin main >> "%LOG%" 2>&1

set REMOTE=
for /f "tokens=1" %%i in ('git ls-remote origin refs/heads/main 2^>nul') do set REMOTE=%%i
echo Remote now  : !REMOTE! >> "%LOG%"

if "!REMOTE!"=="!AFTER!" (
  echo RESULT: DEPLOYED >> "%LOG%"
) else (
  echo RESULT: PUSH_FAILED >> "%LOG%"
)

del ".deploy-trigger"
exit /b 0
