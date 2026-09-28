@echo off
title Bridge Register server (close this window to stop)
cd /d "%~dp0server"
echo Bridge Register - keep this window open while using the app.
echo Open http://localhost:3000 in your browser.
echo.
"C:\Program Files\nodejs\node.exe" --env-file=.env server.js
echo.
echo The server stopped. Press any key to close.
pause >nul
