@echo off
cd /d "%~dp0"
node launch.mjs
if errorlevel 1 pause
