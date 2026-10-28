@echo off
setlocal enabledelayedexpansion
title Face Attendance - Full Setup and Requirements Installer
cd /d "%~dp0"

echo ========================================================
echo   Face Attendance - Auto Setup and Requirements Installer
echo ========================================================
echo.

:: 1. Check and configure Node.js
echo [1/4] Checking Node.js installation...
set "NODE_FOUND=0"
where node >nul 2>&1
if !errorlevel! equ 0 set "NODE_FOUND=1"

if !NODE_FOUND! equ 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=%PATH%;C:\Program Files\nodejs"
        set "NODE_FOUND=1"
    ) else if exist "%LocalAppData%\Programs\nodejs\node.exe" (
        set "PATH=%PATH%;%LocalAppData%\Programs\nodejs"
        set "NODE_FOUND=1"
    )
)

if !NODE_FOUND! equ 0 (
    echo [!] Node.js is not found on this system.
    echo [*] Starting automatic download and installation of Node.js LTS...
    
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo [*] Installing Node.js via winget...
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    ) else (
        echo [*] Downloading Node.js LTS MSI installer via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi', 'node_setup.msi')"
        echo [*] Installing Node.js silently (please allow if Windows prompts)...
        start /wait msiexec /i node_setup.msi /quiet /qn
        if exist "node_setup.msi" del "node_setup.msi"
    )
    set "PATH=%PATH%;C:\Program Files\nodejs"
)

:: Verify Node.js and NPM
node -v >nul 2>&1
if !errorlevel! neq 0 (
    echo [!] Node.js could not be started automatically.
    echo [!] Please install Node.js manually from: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js is ready: %%v
for /f "tokens=*" %%v in ('call npm -v') do echo [OK] NPM is ready: %%v
echo.

:: 2. Check and initialize .env file
echo [2/4] Checking .env configuration file...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [INFO] Created .env file from .env.example template.
    ) else (
        echo PORTAL_USER=>.env
        echo PORTAL_PASS=>>.env
        echo SHEET_URL=https://script.google.com/macros/s/AKfycbw8Ehd-0ssiaaJ0i9yrvy2r7_c67Wx1qH7cZHGHny0VR9C3PZRO2C9gsw0PAy_hQSk/exec>>.env
        echo SHEET_TOKEN=>>.env
        echo [INFO] Created new .env file.
    )
    echo [!] Please verify your PORTAL_USER and PORTAL_PASS in .env
) else (
    echo [OK] .env configuration file found.
)
echo.

:: 3. Install NPM packages
echo [3/4] Installing NPM packages (Playwright, etc.)...
call npm install
if !errorlevel! neq 0 (
    echo [!] npm install encountered an error.
    pause
    exit /b 1
)
echo [OK] NPM packages installed successfully.
echo.

:: 4. Install Playwright Chromium browser
echo [4/4] Installing Playwright Chromium browser...
call npx playwright install chromium
if !errorlevel! neq 0 (
    echo [!] Playwright Chromium installation encountered an error.
    pause
    exit /b 1
)
echo [OK] Playwright Chromium browser installed successfully.
echo.

echo ========================================================
echo     ALL REQUIREMENTS INSTALLED SUCCESSFULLY!
echo ========================================================
echo.
echo Everything is set up and ready to run.
echo.
set /p "RUN_NOW=Do you want to run the UPMSP attendance bot now? (Y/N): "
if /i "!RUN_NOW!"=="Y" (
    cls
    node open.js
)
pause

