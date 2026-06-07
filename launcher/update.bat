@echo off
setlocal
set "INSTALL_ROOT=%~dp0"
set "THIS_SCRIPT=%~f0"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$content = Get-Content -LiteralPath $env:THIS_SCRIPT -Raw; $marker = '# POWERSHELL_SCRIPT'; $index = $content.LastIndexOf($marker); if ($index -lt 0) { Write-Host 'Update failed: embedded script was not found.'; exit 1 }; $script = $content.Substring($index + $marker.Length); Invoke-Expression $script"

set "UPDATE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %UPDATE_EXIT%

# POWERSHELL_SCRIPT
$ErrorActionPreference = "Stop"

$installRoot = [System.IO.Path]::GetFullPath($env:INSTALL_ROOT).TrimEnd("\")
$webappRoot = [System.IO.Path]::Combine($installRoot, "webapp")
$pidFile = [System.IO.Path]::Combine($installRoot, "server.pid")
$releaseUrl = "https://github.com/impishlucy/Yamibunko/releases/latest/download/yamibunko-win.zip"

function TextValue($value) {
    if ($null -eq $value) {
        return ""
    }

    return [string]$value
}

function IsUnderRoot($path, $root) {
    if ([string]::IsNullOrWhiteSpace($path)) {
        return $false
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($path).TrimEnd("\")
        $fullRoot = [System.IO.Path]::GetFullPath($root).TrimEnd("\")

        return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Is-YamibunkoProcess($process) {
    if ($null -eq $process -or $process.ProcessId -eq $PID) {
        return $false
    }

    $name = TextValue $process.Name
    $commandLine = TextValue $process.CommandLine
    $executablePath = TextValue $process.ExecutablePath
    $lowerName = $name.ToLowerInvariant()
    $lowerCommandLine = $commandLine.ToLowerInvariant()

    if ($lowerName -eq "launcher.exe" -and (IsUnderRoot $executablePath $installRoot)) {
        return $true
    }

    if (@("bun.exe", "node.exe", "next.exe") -contains $lowerName) {
        if ($commandLine.IndexOf($webappRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }

        $hasYamibunkoMarker = $lowerCommandLine.Contains("yamibunko")
        $hasServerMarker = $lowerCommandLine.Contains("next") -or
            $lowerCommandLine.Contains("bun") -or
            $lowerCommandLine.Contains("node") -or
            $lowerCommandLine.Contains("run start")

        if ($hasYamibunkoMarker -and $hasServerMarker) {
            return $true
        }
    }

    return $false
}

function Get-RunningYamibunkoProcess {
    if (Test-Path -LiteralPath $pidFile) {
        $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        if ($rawPid -match "^\d+$") {
            $pidProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $rawPid) -ErrorAction SilentlyContinue
            if (Is-YamibunkoProcess $pidProcess) {
                return $pidProcess
            }
        }
    }

    $processes = Get-CimInstance Win32_Process
    foreach ($process in $processes) {
        if (Is-YamibunkoProcess $process) {
            return $process
        }
    }

    return $null
}

$runningProcess = Get-RunningYamibunkoProcess
if ($null -ne $runningProcess) {
    Write-Host ("Yamibunko is still running (PID " + $runningProcess.ProcessId + "). Close the launcher/server before updating.")
    exit 2
}

$tempRoot = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    "yamibunko-update-" + [System.Guid]::NewGuid().ToString("N")
)
$zipPath = [System.IO.Path]::Combine($tempRoot, "yamibunko-win.zip")
$extractRoot = [System.IO.Path]::Combine($tempRoot, "extracted")

try {
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

    Write-Host "Downloading latest Yamibunko Windows release..."
    Invoke-WebRequest -Uri $releaseUrl -OutFile $zipPath -UseBasicParsing

    Write-Host "Extracting release..."
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

    $sourceRoot = [System.IO.Path]::Combine($extractRoot, "yamibunko-win")
    if (!(Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        $entries = @(Get-ChildItem -LiteralPath $extractRoot -Force)
        if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
            $sourceRoot = $entries[0].FullName
        } else {
            $sourceRoot = $extractRoot
        }
    }

    Write-Host "Updating files..."
    Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Recurse -Force
    }

    $nextDir = [System.IO.Path]::Combine($webappRoot, ".next")
    if (Test-Path -LiteralPath $nextDir) {
        Remove-Item -LiteralPath $nextDir -Recurse -Force
    }

    Write-Host "Update done."
    exit 0
} catch {
    Write-Host ("Update failed: " + $_.Exception.Message)
    exit 1
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
