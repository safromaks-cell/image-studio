@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable Phone Access.ps1"
if errorlevel 1 echo Run this file as administrator to allow access from your Wi-Fi network.
pause
