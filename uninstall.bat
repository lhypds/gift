@echo off
rem Remove the global gift launcher installed by install.bat. Nothing inside this
rem checkout is touched.
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

set "LAUNCHER=%USERPROFILE%\.local\bin\gift.cmd"
set "MARKER=gift-launcher:REPO=%ROOT_DIR%"

if not exist "%LAUNCHER%" (
    echo ^(no launcher at %LAUNCHER%^)
    goto done
)

find /i "%MARKER%" "%LAUNCHER%" >nul 2>nul
if errorlevel 1 (
    echo warning: %LAUNCHER% exists but is not this repo's launcher; left unchanged. 1>&2
    goto done
)
echo ==^> Removing %LAUNCHER%
del "%LAUNCHER%"

:done
echo.
echo Uninstall complete.
echo.
echo Local files kept (delete them by hand if you want them gone):
echo     %ROOT_DIR%\config.json
echo     %ROOT_DIR%\hooks.json
echo     %ROOT_DIR%\hooks.log
exit /b 0
