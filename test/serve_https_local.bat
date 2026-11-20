@echo off
setlocal
rem Resolve the server relative to this launcher, regardless of the working directory.
python "%~dp0..\tools\serve_https.py" --mode local %*
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVER_EXIT_CODE%"=="0" (
    echo.
    echo HTTPS server exited with code %SERVER_EXIT_CODE%.
    pause
)
exit /b %SERVER_EXIT_CODE%
