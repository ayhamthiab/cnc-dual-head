@echo off
cd /d "%~dp0"
set "PROJECT_ROOT=%~dp0"
set "VENV_DIR=%PROJECT_ROOT%.venv"
if not exist "%VENV_DIR%\Scripts\python.exe" set "VENV_DIR=C:\gp\.venv"
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo.
    echo Virtual environment not found.
    echo Searched:
    echo   %PROJECT_ROOT%.venv\Scripts\python.exe
    echo   C:\gp\.venv\Scripts\python.exe
    echo.
    echo Please create it first with:
    echo   py -m venv .venv
    echo or restore the project environment.
    pause
    exit /b 1
)

set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VIRTUAL_ENV=%VENV_DIR%"
set "PYTHONPATH=%PROJECT_ROOT%;%PYTHONPATH%"
set "PATH=%VENV_DIR%\Scripts;%PATH%"

cls
echo =====================================================
echo DMHC Local Startup
echo =====================================================
echo Starting local services using project virtual environment...

echo Using Python: %VENV_PYTHON%
"%VENV_PYTHON%" "%PROJECT_ROOT%local_desktop_app.py"
if errorlevel 1 (
    echo.
    echo Something failed while starting the project.
    echo Please check Python and project dependencies.
    pause
    exit /b 1
)

echo.
echo =====================================================
echo IMPORTANT: Agent Token
echo =====================================================
echo Look in the Machine Agent console output above for:
	echo Agent token: <YOUR_TOKEN_HERE>

echo Copy that token and paste it into the Machine Controller page.

echo =====================================================
pause
