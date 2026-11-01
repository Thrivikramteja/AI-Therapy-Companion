@echo off
setlocal
echo ========================================================
echo  Starting Suzie Virtual Therapy Companion Backend
echo ========================================================

REM Check if Node is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js 20 or higher from https://nodejs.org/
    pause
    exit /b 1
)

REM Display Node version
node -v

REM Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] First-time setup: installing dependencies...
    if exist "package-lock.json" (
        call npm ci
    ) else (
        call npm install
    )
)

if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Creating .env from .env.example...
        copy .env.example .env >nul
    )
)

echo [INFO] Launching backend server on http://127.0.0.1:3000...
call npm start
pause
