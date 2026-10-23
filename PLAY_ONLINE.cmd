@echo off
setlocal
title SUNSET RUSH - Online Host

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules\ws\package.json" (
  echo Installing the online server dependencies...
  call npm install
  if errorlevel 1 goto install_failed
)

echo.
echo Starting SUNSET RUSH online host...
echo.
echo The server will open in a second window.
echo Leave that server window open while you and your friends race.
echo.

start "SUNSET RUSH Server" cmd /k "node tools\serve.mjs"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo Your browser is opening the game now.
echo.
echo IMPORTANT FOR FRIENDS:
echo   They must open one of the LAN addresses printed in the server window.
echo   Do not send them 127.0.0.1 - that always means their own computer.
echo.
echo In the game: ONLINE -^> create or join a private room.
echo The room host presses START RACE after every guest presses READY UP.
echo.
echo Press any key to close this helper window. The server keeps running.
pause >nul
exit /b 0

:no_node
echo.
echo Node.js was not found.
echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1

:install_failed
echo.
echo The online dependencies could not be installed.
echo Check your internet connection and run "npm install" inside this folder.
echo.
pause
exit /b 1
