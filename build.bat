@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo Packaging YamiBunko (Win64 ^& Linux64)
echo ===================================================

:: Set directory variables
set "BUILD_DIR=Builds"
set "WIN_DIR=%BUILD_DIR%\yamibunko-win"
set "LINUX_DIR=%BUILD_DIR%\yamibunko-linux"

:: 1. Clean up old build folder if it exists
if exist "%BUILD_DIR%" (
    echo Cleaning old build directory...
    rmdir /s /q "%BUILD_DIR%"
)

:: 2. Create the folder structure
echo Creating build directories...
mkdir "%WIN_DIR%\webapp"
mkdir "%LINUX_DIR%\webapp"

:: 3. Restore the C# Launcher
echo.
echo Restoring C# Launcher packages...
dotnet restore launcher\Launcher.csproj

:: 4. Publish for Windows x64 using the pubxml profile
echo.
echo Publishing C# Launcher for Win64...
dotnet publish launcher\Launcher.csproj /p:PublishProfile=Win64.pubxml -o "%WIN_DIR%"

:: 5. Publish for Linux x64 using the pubxml profile
echo.
echo Publishing C# Launcher for Linux64...
dotnet publish launcher\Launcher.csproj /p:PublishProfile=Linux64.pubxml -o "%LINUX_DIR%"

:: 6. Copy webapp files using Robocopy
echo.
echo Copying Next.js Webapp files to Windows build...
robocopy webapp "%WIN_DIR%\webapp" /E /XD node_modules .* /XF .* /NJH /NJS /NDL /NC /NS

if %ERRORLEVEL% GEQ 8 (
    echo [ERROR] Failed copying webapp to Windows build.
    exit /b %ERRORLEVEL%
)

echo Copying Next.js Webapp files to Linux build...
robocopy webapp "%LINUX_DIR%\webapp" /E /XD node_modules .* /XF .* /NJH /NJS /NDL /NC /NS

if %ERRORLEVEL% GEQ 8 (
    echo [ERROR] Failed copying webapp to Linux build.
    exit /b %ERRORLEVEL%
)

echo.
echo ===================================================
echo Packaging Complete! 
echo Check the '%BUILD_DIR%' folder for your outputs.
echo ===================================================
pause