@echo off
setlocal enabledelayedexpansion
title UPMSP Attendance Scheduler
cd /d "%~dp0"

:: 1. Add Node.js to PATH if available in standard paths
where node >nul 2>&1
if !errorlevel! neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
    if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%PATH%;%LocalAppData%\Programs\nodejs"
)

:: 2. Check if setup is needed
where node >nul 2>&1
set "HAS_NODE=!errorlevel!"
if not exist "node_modules" set "NEED_SETUP=1"
if !HAS_NODE! neq 0 set "NEED_SETUP=1"
if not exist ".env" set "NEED_SETUP=1"

if defined NEED_SETUP (
    echo [!] Missing dependencies or setup detected.
    echo [*] Running setup.bat first...
    call setup.bat
)

:: 3. Run the scheduler
node scheduler.js
pause

