@echo off
rem Start the demo club on this laptop, for showing in person (see scripts\demo.ps1).
rem Double-click it, or run: demo.cmd -Reset / -Detach / -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\demo.ps1" %*
if errorlevel 1 pause
