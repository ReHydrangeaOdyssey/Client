@echo off
setlocal
rem Set your development PC's LAN IPv4 address and allowed subnet below once.
rem Environment variables take priority over the values configured here.
if not defined REORSG_LAN_HOST set "REORSG_LAN_HOST="
if not defined REORSG_LAN_NETWORK set "REORSG_LAN_NETWORK="

if not defined REORSG_LAN_HOST set /p "REORSG_LAN_HOST=Development PC LAN IPv4 address: "
if not defined REORSG_LAN_NETWORK set /p "REORSG_LAN_NETWORK=Allowed LAN subnet (CIDR): "
if not defined REORSG_LAN_HOST goto missing_configuration
if not defined REORSG_LAN_NETWORK goto missing_configuration

python "%~dp0..\tools\serve_https.py" --mode lan --host "%REORSG_LAN_HOST%" --lan-network "%REORSG_LAN_NETWORK%" %*
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVER_EXIT_CODE%"=="0" (
    echo.
    echo HTTPS server exited with code %SERVER_EXIT_CODE%.
    pause
)
exit /b %SERVER_EXIT_CODE%

:missing_configuration
echo LAN IPv4 address and subnet are required.
pause
exit /b 1
