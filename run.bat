@echo off
chcp 65001 > nul
set "NVM_HOME=C:\Users\Zane\.workbuddy\binaries\node\versions\22.12.0"
set "PATH=%NVM_HOME%;%PATH%"

echo ====================================
echo   Bing Rewards - Auto Search
echo ====================================
echo.

if not exist "node_modules\" (
  echo [!] Dependencies not found. Running npm install...
  call npm install
)

node index.js %*
pause
