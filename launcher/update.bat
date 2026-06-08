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
$ProgressPreference = "SilentlyContinue"

$installRoot = [System.IO.Path]::GetFullPath($env:INSTALL_ROOT).TrimEnd("\")
$webappRoot = [System.IO.Path]::Combine($installRoot, "webapp")
$latestReleaseApi = "https://api.github.com/repos/impishlucy/Yamibunko/releases/latest"
$releaseUrl = "https://github.com/impishlucy/Yamibunko/releases/latest/download/yamibunko-win.zip"
$requestHeaders = @{ "User-Agent" = "Yamibunko-Updater"; "Accept" = "application/vnd.github+json" }

function TextValue($value) {
    if ($null -eq $value) {
        return ""
    }

    return [string]$value
}

function Normalize-CommandLine($value) {
    return [System.Text.RegularExpressions.Regex]::Replace((TextValue $value), "\s+", " ").Trim()
}

function Is-NodeOrBunProcessName($name) {
    $lowerName = (TextValue $name).ToLowerInvariant()
    return @("bun.exe", "bun", "node.exe", "node") -contains $lowerName
}

function Has-YamibunkoStartCommand($process) {
    if (!(Is-NodeOrBunProcessName $process.Name)) {
        return $false
    }

    $commandLine = Normalize-CommandLine $process.CommandLine
    $lowerCommandLine = $commandLine.ToLowerInvariant()

    if (!$lowerCommandLine.Contains("yamibunk")) {
        return $false
    }

    return [System.Text.RegularExpressions.Regex]::IsMatch(
        $lowerCommandLine,
        '(^|[\s"''])run\s+start($|[\s"'':])'
    )
}

function Is-YamibunkoProcess($process) {
    if ($null -eq $process -or $process.ProcessId -eq $PID) {
        return $false
    }

    $name = TextValue $process.Name
    $lowerName = $name.ToLowerInvariant()

    if ($lowerName -eq "yamibunko.exe" -or $lowerName -eq "yamibunko") {
        return $true
    }

    return Has-YamibunkoStartCommand $process
}

function Get-RunningYamibunkoProcess {
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

function Get-CommandPath($commandName) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }

    return $command.Source
}

function Invoke-DownloadFile($url, $destinationPath) {
    $curlPath = Get-CommandPath "curl.exe"

    if (![string]::IsNullOrWhiteSpace($curlPath)) {
        & $curlPath `
            --fail `
            --location `
            --retry 3 `
            --retry-delay 2 `
            --connect-timeout 20 `
            --header "User-Agent: Yamibunko-Updater" `
            --output $destinationPath `
            $url

        if ($LASTEXITCODE -ne 0) {
            throw "Download failed. curl.exe exited with code $LASTEXITCODE."
        }

        return
    }

    Invoke-WebRequest -Uri $url -OutFile $destinationPath -UseBasicParsing -Headers @{ "User-Agent" = "Yamibunko-Updater" }
}

function Expand-ReleaseArchive($archivePath, $destinationPath) {
    $tarPath = Get-CommandPath "tar.exe"

    if (![string]::IsNullOrWhiteSpace($tarPath)) {
        & $tarPath -xf $archivePath -C $destinationPath

        if ($LASTEXITCODE -ne 0) {
            throw "Extraction failed. tar.exe exited with code $LASTEXITCODE."
        }

        return
    }

    Expand-Archive -Path $archivePath -DestinationPath $destinationPath -Force
}

function Copy-ReleaseFiles($sourcePath, $destinationPath) {
    $robocopyPath = Get-CommandPath "robocopy.exe"

    if (![string]::IsNullOrWhiteSpace($robocopyPath)) {
        & $robocopyPath `
            $sourcePath `
            $destinationPath `
            /E `
            /COPY:DAT `
            /DCOPY:DAT `
            /R:2 `
            /W:1 `
            /MT:8 `
            /NFL `
            /NDL `
            /NP

        if ($LASTEXITCODE -ge 8) {
            throw "Could not copy the updated files. robocopy.exe exited with code $LASTEXITCODE."
        }

        return
    }

    Get-ChildItem -LiteralPath $sourcePath -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Recurse -Force
    }
}

function Remove-WebappBuildCache($webappPath) {
    $buildCachePath = [System.IO.Path]::Combine($webappPath, ".next")

    if (Test-Path -LiteralPath $buildCachePath) {
        Remove-Item -LiteralPath $buildCachePath -Recurse -Force
    }
}

$runningProcess = Get-RunningYamibunkoProcess
if ($null -ne $runningProcess) {
    Write-Host ("Yamibunko is still running (" + (TextValue $runningProcess.Name) + ", PID " + $runningProcess.ProcessId + "). Close the launcher/server before updating.")
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
    Invoke-DownloadFile $releaseUrl $zipPath

    Write-Host "Extracting release..."
    Expand-ReleaseArchive $zipPath $extractRoot

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
    Copy-ReleaseFiles $sourceRoot $installRoot

    Write-Host "Clearing cached webapp build..."
    Remove-WebappBuildCache $webappRoot

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
