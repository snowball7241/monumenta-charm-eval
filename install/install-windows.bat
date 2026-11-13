@echo off
rem Double-click to install or update the Charm Evaluator. Runs the latest install-windows.ps1 from the project's releases.
title Charm Evaluator installer
set "MTCE_INSTALLER=%TEMP%\mtce-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/snowball7241/monumenta-charm-eval/releases/latest/download/install-windows.ps1' -OutFile $env:MTCE_INSTALLER"
if errorlevel 1 (
    echo.
    echo Could not download the installer. Check your internet connection.
    goto end
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%MTCE_INSTALLER%"
if errorlevel 1 (
    echo.
    echo The installation did not finish. See the message above.
)
:end
del "%MTCE_INSTALLER%" 2>nul
echo.
pause
