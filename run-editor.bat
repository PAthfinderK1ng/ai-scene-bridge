@echo off
rem Start the SID editor: static server from repo root, then open the browser.
cd /d "%~dp0"
echo SID editor -> http://localhost:8765/app/
echo Press Ctrl+C in this window to stop the server.
start "" "http://localhost:8765/app/"
python -m http.server 8765 --bind 127.0.0.1
