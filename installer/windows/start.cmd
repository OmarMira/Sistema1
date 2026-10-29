@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0launcher.cjs" --start --open
if errorlevel 1 pause
