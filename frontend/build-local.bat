@echo off
setlocal

powershell -ExecutionPolicy Bypass -File "%~dp0build-local.ps1" %*
exit /b %errorlevel%