@echo off
rem Run setup.bat first. Adds %USERPROFILE%\.local\bin\gift.cmd, a wrapper around
rem bin\gift.js in this checkout.
rem
rem   install.bat
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
cd /d "%ROOT_DIR%"

set "MIN_NODE_MAJOR=18"
set "LAUNCHER_DIR=%USERPROFILE%\.local\bin"
set "LAUNCHER=%LAUNCHER_DIR%\gift.cmd"
set "MARKER=gift-launcher:REPO=%ROOT_DIR%"

if "%~1"=="-h" goto help
if "%~1"=="--help" goto help
if not "%~1"=="" (
    echo unknown option: %1 1>&2
    exit /b 2
)

set "NODE="
if defined NODE_BIN call :try_node "%NODE_BIN%"
if not defined NODE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE call :try_node "%%n"

if not defined NODE (
    echo error: need Node.js ^>= %MIN_NODE_MAJOR%. Run setup.bat first. 1>&2
    exit /b 1
)

if not exist "%LAUNCHER_DIR%" mkdir "%LAUNCHER_DIR%"

if exist "%LAUNCHER%" (
    find /i "%MARKER%" "%LAUNCHER%" >nul 2>nul
    if errorlevel 1 (
        find "gift-launcher:REPO=" "%LAUNCHER%" >nul 2>nul
        if errorlevel 1 (
            echo error: %LAUNCHER% already exists and was not created by gift. 1>&2
            echo   Remove it yourself first if you want gift to take that name. 1>&2
            exit /b 1
        )
        echo ==^> Replacing a gift launcher that pointed at another checkout
    )
)

echo ==^> Writing %LAUNCHER%
rem %ROOT_DIR% and %NODE% are baked in now; the doubled %% stay literal for runtime.
> "%LAUNCHER%" (
    echo @echo off
    echo rem %MARKER%
    echo setlocal
    echo rem Prefer whatever node is on PATH ^(nvm users switch versions^); fall back to the
    echo rem interpreter found at install time.
    echo set "NODE_BIN=%NODE%"
    echo where node ^>nul 2^>nul ^&^& set "NODE_BIN=node"
    echo "%%NODE_BIN%%" "%ROOT_DIR%\bin\gift.js" %%*
    echo exit /b %%ERRORLEVEL%%
)

echo.
echo Install complete. `gift` runs from:
echo   %LAUNCHER%
echo.

rem Is the launcher folder on PATH already? Look for it between semicolons.
echo ;%PATH%; | find /i ";%LAUNCHER_DIR%;" >nul
if errorlevel 1 (
    echo %LAUNCHER_DIR% is not on your PATH. Add it for your user ^(PowerShell^):
    echo.
    echo   [Environment]::SetEnvironmentVariable^('Path', [Environment]::GetEnvironmentVariable^('Path', 'User'^) + ';%LAUNCHER_DIR%', 'User'^)
    echo.
    echo and open a new terminal, or for this cmd window only:
    echo.
    echo   set "PATH=%LAUNCHER_DIR%;%%PATH%%"
    echo.
)

echo Try it:
echo   gift help
echo   gift run
exit /b 0

:help
echo Run setup.bat first. Adds %%USERPROFILE%%\.local\bin\gift.cmd, a wrapper around
echo bin\gift.js in this checkout.
echo.
echo   install.bat
exit /b 0

:try_node
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= %MIN_NODE_MAJOR% ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE=%~1"
exit /b 0
