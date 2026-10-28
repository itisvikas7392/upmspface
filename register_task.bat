@echo off
setlocal enabledelayedexpansion
title Windows Task Scheduler Registration
cd /d "%~dp0"

where node >nul 2>&1
if !errorlevel! neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
    if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%PATH%;%LocalAppData%\Programs\nodejs"
)

node register_schedule.js
pause

