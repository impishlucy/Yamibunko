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
$latestReleaseApi = "https://api.github.com/repos/impishlucy/Yamibunko/releases/latest"
$releaseUrl = "https://github.com/impishlucy/Yamibunko/releases/latest/download/yamibunko-win.zip"
$requestHeaders = @{ "User-Agent" = "Yamibunko-Updater"; "Accept" = "application/vnd.github+json" }

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

function Get-PackageJsonVersion($path) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Could not read the installed version from webapp\package.json."
    }

    $packageJson = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $version = TextValue $packageJson.version

    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "Could not read the installed version from webapp\package.json."
    }

    return $version
}

function Normalize-VersionText($versionText) {
    $match = [System.Text.RegularExpressions.Regex]::Match((TextValue $versionText), "\d+(?:\.\d+)*")
    if (!$match.Success) {
        throw "Version is invalid: $versionText"
    }

    return $match.Value
}

function Compare-VersionText($left, $right) {
    $leftParts = @((Normalize-VersionText $left).Split("."))
    $rightParts = @((Normalize-VersionText $right).Split("."))
    $max = [System.Math]::Max($leftParts.Count, $rightParts.Count)

    for ($index = 0; $index -lt $max; $index++) {
        $leftPart = 0
        $rightPart = 0

        if ($index -lt $leftParts.Count) {
            $leftPart = [int]$leftParts[$index]
        }

        if ($index -lt $rightParts.Count) {
            $rightPart = [int]$rightParts[$index]
        }

        if ($leftPart -gt $rightPart) {
            return 1
        }

        if ($leftPart -lt $rightPart) {
            return -1
        }
    }

    return 0
}

$runningProcess = Get-RunningYamibunkoProcess
if ($null -ne $runningProcess) {
    Write-Host ("Yamibunko is still running (PID " + $runningProcess.ProcessId + "). Close the launcher/server before updating.")
    exit 2
}

try {
    $currentVersion = Get-PackageJsonVersion ([System.IO.Path]::Combine($webappRoot, "package.json"))

    Write-Host "Checking latest Yamibunko version..."
    $latestRelease = Invoke-RestMethod -Uri $latestReleaseApi -Headers $requestHeaders -UseBasicParsing
    $latestVersion = TextValue $latestRelease.tag_name

    if ([string]::IsNullOrWhiteSpace($latestVersion)) {
        throw "Could not read the latest GitHub release version."
    }

    Write-Host ("Installed version: " + $currentVersion)
    Write-Host ("Latest version: " + $latestVersion)

    if ((Compare-VersionText $latestVersion $currentVersion) -le 0) {
        Write-Host "Yamibunko is already up to date."
        exit 0
    }
} catch {
    Write-Host ("Update failed: " + $_.Exception.Message)
    exit 1
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
    Invoke-WebRequest -Uri $releaseUrl -OutFile $zipPath -UseBasicParsing -Headers @{ "User-Agent" = "Yamibunko-Updater" }

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
