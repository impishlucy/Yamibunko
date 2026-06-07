@echo off
setlocal

echo ===================================================
echo Packaging YamiBunko (Win64 ^& Linux64)
echo ===================================================

set "BUILD_DIR=Builds"
set "OBJ_DIR=launcher\obj"
set "BIN_DIR=launcher\bin"
set "WIN_DIR=%BUILD_DIR%\yamibunko-win"
set "LINUX_DIR=%BUILD_DIR%\yamibunko-linux"

if exist "%BUILD_DIR%" (
    echo Cleaning old Build directory...
    rmdir /s /q "%BUILD_DIR%" 2>nul
)

set "cleanup=0"
if exist "%OBJ_DIR%" set "cleanup=1"
if exist "%BIN_DIR%" set "cleanup=1"

if %cleanup%==1 (
    echo Cleaning old net directorys...
    rmdir /s /q "%OBJ_DIR%" 2>nul
    rmdir /s /q "%BIN_DIR%" 2>nul
)

echo Creating build directories...
mkdir "%WIN_DIR%\webapp"
if errorlevel 1 goto :fail
mkdir "%LINUX_DIR%\webapp"
if errorlevel 1 goto :fail

echo.
echo Restoring C# Launcher packages...
dotnet restore launcher\Launcher.csproj
if errorlevel 1 goto :fail

echo.
echo Publishing C# Launcher for Win64...
dotnet publish launcher\Launcher.csproj /p:PublishProfile=Win64.pubxml -o "%WIN_DIR%"
if errorlevel 1 goto :fail

echo.
echo Publishing C# Launcher for Linux64...
dotnet publish launcher\Launcher.csproj /p:PublishProfile=Linux64.pubxml -o "%LINUX_DIR%"
if errorlevel 1 goto :fail

echo.
echo Copying Next.js Webapp files to Windows build...
robocopy webapp "%WIN_DIR%\webapp" /E /XD node_modules .* /XF .* /NJH /NJS /NDL /NC /NS
if errorlevel 8 goto :fail

echo Copying Next.js Webapp files to Linux build...
robocopy webapp "%LINUX_DIR%\webapp" /E /XD node_modules .* /XF .* /NJH /NJS /NDL /NC /NS
if errorlevel 8 goto :fail

echo.
echo ===================================================
echo Packaging Complete!
echo Check the '%BUILD_DIR%' folder for your outputs.
echo ===================================================
pause
exit /b 0

:fail
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [ERROR] Packaging failed. Aborting.
echo [ERROR] Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
