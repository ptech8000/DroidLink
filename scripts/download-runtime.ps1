$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PlatformToolsDir = Join-Path $Root "resources\platform-tools"
$ServerDir = Join-Path $Root "resources\server"
$TempDir = Join-Path $Root ".tmp-download"

New-Item -ItemType Directory -Force -Path $PlatformToolsDir, $ServerDir, $TempDir | Out-Null

$AdbExe = Join-Path $PlatformToolsDir "adb.exe"
if (-not (Test-Path $AdbExe)) {
    $PtZip = Join-Path $TempDir "platform-tools-latest-windows.zip"
    Write-Host "Downloading Android SDK Platform-Tools (adb.exe)..."
    Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $PtZip -UseBasicParsing

    $PtExtract = Join-Path $TempDir "pt-extract"
    if (Test-Path $PtExtract) { Remove-Item -Recurse -Force $PtExtract }
    Expand-Archive -Path $PtZip -DestinationPath $PtExtract -Force

    Copy-Item -Path (Join-Path $PtExtract "platform-tools\*") -Destination $PlatformToolsDir -Recurse -Force
    Write-Host "Installed platform-tools to $PlatformToolsDir"
} else {
    Write-Host "adb.exe already present at $AdbExe"
}

$ServerFile = Join-Path $ServerDir "scrcpy-server"
$ServerVersion = "v5.0.1"
if (-not (Test-Path $ServerFile)) {
    Write-Host "Downloading scrcpy-server $ServerVersion (Apache-2.0)..."
    $ServerUrl = "https://github.com/Genymobile/scrcpy/releases/download/$ServerVersion/scrcpy-server-$ServerVersion"
    Invoke-WebRequest -Uri $ServerUrl -OutFile $ServerFile -UseBasicParsing
    Write-Host "Installed scrcpy-server to $ServerFile"
} else {
    Write-Host "scrcpy-server already present at $ServerFile"
}

if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
}

Write-Host "Runtime dependencies ready."
& $AdbExe version
