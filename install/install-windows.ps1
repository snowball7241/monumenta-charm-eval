# Installs (or updates) the Charm Evaluator web app on Windows 10/11: the latest mtce release, the web front end, and a private
# copy of Node.js, all in %LOCALAPPDATA%\Charm Evaluator. No admin rights needed.
#
# Double-click install-windows.bat, which downloads this script and runs it. Or, in PowerShell:
#
#   $f = "$env:TEMP\mtce-install.ps1"; iwr -UseBasicParsing https://github.com/snowball7241/monumenta-charm-eval/releases/latest/download/install-windows.ps1 -OutFile $f; powershell -NoProfile -ExecutionPolicy Bypass -File $f
#
# (It is downloaded to a file rather than piped into iex: GitHub serves release files as binary, which Windows PowerShell 5.1
# does not always decode as text.) Run it again to update. To uninstall, delete the install folder
# and the "Charm Evaluator" shortcuts on the Desktop and in the Start menu.
#
# Environment overrides (mostly for testing): MTCE_REPO (owner/name), MTCE_VERSION (release tag), MTCE_BASE_URL (where the
# release files are), MTCE_HOME (install folder), MTCE_NO_SHORTCUT=1, MTCE_NO_START=1.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:MTCE_REPO) { $env:MTCE_REPO } else { 'snowball7241/monumenta-charm-eval' }
$Dest = if ($env:MTCE_HOME) { $env:MTCE_HOME } else { Join-Path $env:LOCALAPPDATA 'Charm Evaluator' }
$NodeVersion = '22.23.5'

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { throw $msg }

function Fetch($url, $file) {
    for ($try = 1; $try -le 3; $try++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
            return
        } catch {
            if ($try -eq 3) { Fail "download failed: $url ($($_.Exception.Message))" }
            Start-Sleep -Seconds 2
        }
    }
}

function Check-Sha256($file, $sumsFile, $name) {
    $want = $null
    foreach ($line in Get-Content -LiteralPath $sumsFile) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and ($parts[1] -eq $name -or $parts[1] -eq "*$name")) { $want = $parts[0].ToLower() }
    }
    if (-not $want) { Fail "no checksum for $name" }
    $got = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { Fail "checksum mismatch for $name (download corrupted or tampered with)" }
}

function Main {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'this installer is for Windows (use install-mac.sh on macOS)' }
    if (-not [Environment]::Is64BitOperatingSystem) { Fail 'needs 64-bit Windows' }
    # the release has x64 builds only; Windows 11 on ARM runs them through its x64 emulation

    # --- which release
    if ($env:MTCE_VERSION) {
        $tag = $env:MTCE_VERSION
    } else {
        Say "Looking up the latest release of $Repo"
        try {
            $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing).tag_name
        } catch {
            Fail "could not find a release of $Repo ($($_.Exception.Message))"
        }
    }
    $base = if ($env:MTCE_BASE_URL) { $env:MTCE_BASE_URL } else { "https://github.com/$Repo/releases/download/$tag" }
    $nodeDist = "https://nodejs.org/dist/v$NodeVersion"

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mtce-install-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $mtceArchive = "mtce-$tag-windows-x86_64.zip"
        $webArchive = "mtce-web-$tag.zip"
        $nodeArchive = "node-v$NodeVersion-win-x64.zip"

        Say "Downloading mtce $tag"
        Fetch "$base/SHA256SUMS.txt" "$tmp\SHA256SUMS.txt"
        Fetch "$base/$mtceArchive" "$tmp\$mtceArchive"
        Check-Sha256 "$tmp\$mtceArchive" "$tmp\SHA256SUMS.txt" $mtceArchive

        Say 'Downloading the web front end'
        Fetch "$base/$webArchive" "$tmp\$webArchive"
        Check-Sha256 "$tmp\$webArchive" "$tmp\SHA256SUMS.txt" $webArchive

        $nodeExe = Join-Path $Dest 'node\node.exe'
        $nodeReady = (Test-Path -LiteralPath $nodeExe) -and ((& $nodeExe --version) -eq "v$NodeVersion")
        if ($nodeReady) {
            Say "Node.js v$NodeVersion is already installed"
        } else {
            Say "Downloading Node.js v$NodeVersion"
            Fetch "$nodeDist/SHASUMS256.txt" "$tmp\node-SHASUMS256.txt"
            Fetch "$nodeDist/$nodeArchive" "$tmp\$nodeArchive"
            Check-Sha256 "$tmp\$nodeArchive" "$tmp\node-SHASUMS256.txt" $nodeArchive
        }

        # --- unpack everything first, then swap it into place
        Say "Installing to $Dest"
        Expand-Archive -LiteralPath "$tmp\$mtceArchive" -DestinationPath "$tmp\mtce"
        Expand-Archive -LiteralPath "$tmp\$webArchive" -DestinationPath "$tmp\webzip"
        $mtceDir = Join-Path $tmp "mtce\mtce-$tag-windows-x86_64"
        $webDir = Join-Path $tmp "webzip\mtce-web-$tag"
        if (-not (Test-Path -LiteralPath "$mtceDir\mtce.exe") -or -not (Test-Path -LiteralPath "$webDir\web.mjs") -or
            -not (Test-Path -LiteralPath "$webDir\web\index.html")) {
            Fail 'release files are not in the expected layout'
        }

        New-Item -ItemType Directory -Force -Path $Dest | Out-Null
        if (-not $nodeReady) {
            Expand-Archive -LiteralPath "$tmp\$nodeArchive" -DestinationPath "$tmp\node"
            $nodeTarget = Join-Path $Dest 'node'
            if (Test-Path -LiteralPath $nodeTarget) { Remove-Item -LiteralPath $nodeTarget -Recurse -Force }
            Move-Item -LiteralPath (Join-Path $tmp "node\node-v$NodeVersion-win-x64") -Destination $nodeTarget
        }

        foreach ($f in 'mtce.exe', 'LICENSE', 'README.md', 'example.conf') {
            Copy-Item -LiteralPath (Join-Path $mtceDir $f) -Destination (Join-Path $Dest $f) -Force
        }
        $webTarget = Join-Path $Dest 'web'
        if (Test-Path -LiteralPath $webTarget) { Remove-Item -LiteralPath $webTarget -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $webDir 'web') -Destination $webTarget -Recurse
        Copy-Item -LiteralPath (Join-Path $webDir 'web.mjs') -Destination (Join-Path $Dest 'web.mjs') -Force
        Set-Content -LiteralPath (Join-Path $Dest 'VERSION') -Value $tag

        & (Join-Path $Dest 'mtce.exe') --version | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'the installed mtce.exe does not run on this PC' }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # --- launcher: double-click to start the server and open the page
    $launcher = Join-Path $Dest 'Start Charm Evaluator.cmd'
    Set-Content -LiteralPath $launcher -Encoding ASCII -Value @'
@echo off
rem Starts the Charm Evaluator and opens it in your browser. Close this window to stop it.
title Charm Evaluator
cd /d "%~dp0"
"%~dp0node\node.exe" web.mjs --mtce "%~dp0mtce.exe" --open
if errorlevel 1 pause
'@

    if (-not $env:MTCE_NO_SHORTCUT) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
            if (-not $folder) { continue }
            $shortcut = $shell.CreateShortcut((Join-Path $folder 'Charm Evaluator.lnk'))
            $shortcut.TargetPath = $launcher
            $shortcut.WorkingDirectory = $Dest
            $shortcut.Description = 'Start the Charm Evaluator'
            $shortcut.Save()
        }
        Say 'Added "Charm Evaluator" to your Desktop and Start menu: double-click it to start'
    }

    Say "Installed mtce $tag"
    if (-not $env:MTCE_NO_START) {
        Say 'Starting it now (close its window to stop it)'
        Start-Process -FilePath $launcher -WorkingDirectory $Dest
    }
}

try {
    Main
} catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
exit 0
