@echo off
cd /d "%~dp0"
if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%PATH%;%LocalAppData%\Programs\nodejs"

node auto_runner.js

