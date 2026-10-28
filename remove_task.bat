@echo off
title Remove Scheduled Task
cd /d "%~dp0"

echo Removing UPMSP_FaceAttendance from Windows Task Scheduler...
schtasks /delete /tn "UPMSP_FaceAttendance" /f

if %errorlevel% equ 0 (
    echo [SUCCESS] Scheduled task removed successfully.
) else (
    echo [INFO] No task was found or already removed.
)
pause

