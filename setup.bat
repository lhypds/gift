@echo off
rem Preparation for install.bat on Windows: check Node.js >= 18, check the tools
rem the functions need, and create config.json and hooks.json.
rem Does not install the global `gift` command - run install.bat after this.
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
cd /d "%ROOT_DIR%"

set "MIN_NODE_MAJOR=18"

rem NODE_BIN if it is new enough, otherwise the first node on PATH.
set "NODE="
if defined NODE_BIN call :try_node "%NODE_BIN%"
if not defined NODE for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE call :try_node "%%n"

if not defined NODE (
    echo error: need Node.js ^>= %MIN_NODE_MAJOR% for this project. 1>&2
    echo   winget:        winget install OpenJS.NodeJS.LTS 1>&2
    echo   nvm-windows:   nvm install lts 1>&2
    echo   or point at one explicitly: set NODE_BIN=C:\path\to\node.exe 1>&2
    exit /b 1
)

for /f "delims=" %%v in ('call "%NODE%" --version') do echo ==^> Using %%v ^(%NODE%^)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo error: pnpm is required. Install it with: npm install -g pnpm  ^(or corepack enable pnpm^) 1>&2
    exit /b 1
)

rem The full dependency set, not just production ones: the dashboard is a React
rem app built by Vite, and building it locally is how `gift update` ends up with
rem a working one.
echo ==^> Installing dependencies and building the dashboard (pnpm i ^&^& pnpm run build)
call pnpm i
if errorlevel 1 exit /b 1
call pnpm run build
if errorlevel 1 exit /b 1

echo ==^> Checking the tools the functions use
call :check_tool git "pull-repos, repo-master  (winget install Git.Git)"
call :check_tool gh "gift create, weekly-prs, repo-master  (winget install GitHub.cli, then gh auth login)"
call :check_tool jq "weekly-prs  (winget install jqlang.jq)"
rem The .sh functions run through bash, which Git for Windows provides.
call :check_tool bash "the .sh functions: pull-repos, weekly-prs  (comes with Git for Windows)"

rem The clipboard trigger reads the clipboard through PowerShell.
where powershell >nul 2>nul
if errorlevel 1 (
    echo     missing  powershell - clipboard hooks will not fire
) else (
    echo     ok       powershell  ^(clipboard hooks^)
)

rem Installed is not enough for gh: `gift create` creates the repository webhook
rem through `gh api`, so a signed-out gh means the hook is written to hooks.json
rem while GitHub is never told about it.
where gh >nul 2>nul
if not errorlevel 1 (
    gh auth status >nul 2>nul
    if errorlevel 1 (
        echo     warning  gh is installed but not signed in - run: gh auth login
        echo              until then `gift create` adds the local hook only, and the GitHub
        echo              webhook has to be added under the repository's Settings ^> Webhooks
    ) else (
        echo     ok       gh is signed in
    )
)

rem One file, created here with every setting the functions declare so that
rem `gift config` opens a list to work from rather than a blank page.
for /f "delims=" %%f in ('call "%NODE%" "%ROOT_DIR%\utils\config.js" ensure') do set "CONFIG_FILE=%%f"
echo ==^> Settings live in %CONFIG_FILE%

set "SECRET="
for /f "delims=" %%s in ('call "%NODE%" "%ROOT_DIR%\utils\config.js" get GITHUB_WEBHOOK_SECRET') do set "SECRET=%%s"
if "%SECRET%"=="""" set "SECRET="
if "%SECRET%"=="''" set "SECRET="
if defined SECRET (
    echo ==^> Keeping existing github_webhook_secret
    goto webhook_url
)
for /f "delims=" %%s in ('call "%NODE%" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"') do set "SECRET=%%s"
call "%NODE%" "%ROOT_DIR%\utils\config.js" set github github_webhook_secret "%SECRET%"
echo ==^> Generated github_webhook_secret in config.json (under triggers.github)

:webhook_url
set "SECRET="
set "WEBHOOK_URL="
for /f "delims=" %%u in ('call "%NODE%" "%ROOT_DIR%\utils\config.js" get GIFT_WEBHOOK_URL') do set "WEBHOOK_URL=%%u"
echo.

:ask_url
set "CANDIDATE_URL="
if defined WEBHOOK_URL (
    set /p "CANDIDATE_URL=Public webhook URL [%WEBHOOK_URL%]: "
) else (
    set /p "CANDIDATE_URL=Public webhook URL (include /hooks/github; leave blank to skip): "
)
if not defined CANDIDATE_URL set "CANDIDATE_URL=%WEBHOOK_URL%"
if not defined CANDIDATE_URL goto url_empty

rem The URL goes to node through the environment, so whatever was typed is never
rem read as part of a command line.
call "%NODE%" -e "try { const url = new URL(process.env.CANDIDATE_URL); const valid = ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.hash; process.exit(valid ? 0 : 1); } catch { process.exit(1); }"
if errorlevel 1 (
    echo Invalid URL - use a complete public http:// or https:// URL without credentials or a fragment. 1>&2
    goto ask_url
)
call "%NODE%" "%ROOT_DIR%\utils\config.js" set github webhook_url "%CANDIDATE_URL%"
echo ==^> Saved webhook_url in config.json (under triggers.github)
goto hooks_file

:url_empty
echo ==^> webhook_url left empty

:hooks_file
if exist "hooks.json" (
    echo ==^> Keeping existing hooks.json
) else (
    > hooks.json (
        echo {
        echo   "log": "hooks.log",
        echo   "hooks": []
        echo }
    )
    echo ==^> Created hooks.json with no hooks - see hooks.example.json for the format
)

echo.
echo Setup complete - ready for install.bat
echo.
echo Next step (installs the global `gift` command):
echo     install.bat
exit /b 0

:try_node
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= %MIN_NODE_MAJOR% ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE=%~1"
exit /b 0

rem The note may hold parentheses, so it is echoed outside any ( ) block.
:check_tool
where %1 >nul 2>nul
if not errorlevel 1 (
    echo     ok       %1
    exit /b 0
)
echo     missing  %1
echo              needed by: %~2
exit /b 0
