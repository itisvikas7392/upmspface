@echo off
setlocal enabledelayedexpansion
title UPMSP Face Attendance Bot
cd /d "%~dp0"

:: 1. Add Node.js to PATH if available in standard paths
where node >nul 2>&1
if !errorlevel! neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
    if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%PATH%;%LocalAppData%\Programs\nodejs"
)

:: 2. Check if setup is needed (missing node, node_modules, or .env)
set "NEED_SETUP=0"
where node >nul 2>&1
if !errorlevel! neq 0 set "NEED_SETUP=1"
if not exist "node_modules" set "NEED_SETUP=1"
if not exist ".env" set "NEED_SETUP=1"

if !NEED_SETUP! equ 1 (
    echo [!] Missing dependencies or initial setup detected.
    echo [*] Starting automatic setup...
    call setup.bat
    exit /b
)

:: 3. Run the attendance automation bot
node open.js
pause
