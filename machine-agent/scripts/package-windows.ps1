$ErrorActionPreference = "Stop"

# Build a Windows MSI that contains the shaded agent JAR. Run this on Windows
# with a JDK that includes jpackage (JDK 17+), Maven, Git and WiX available.
$Root = Split-Path -Parent $PSScriptRoot
$BuildScript = Join-Path $Root "scripts\build-agent.ps1"
$Jar = Join-Path $Root "target\dmhc-machine-agent.jar"
$InstallerDir = Join-Path $Root "target\installer"

& $BuildScript
if (-not (Get-Command jpackage -ErrorAction SilentlyContinue)) {
  throw "jpackage was not found. Install a JDK 17+ distribution that includes jpackage."
}

Remove-Item -Recurse -Force $InstallerDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $InstallerDir | Out-Null

jpackage `
  --type msi `
  --name "DMHC Machine Agent" `
  --app-version "0.1.0" `
  --vendor "DMHC" `
  --description "Local-only dual GRBL controller bridge for DMHC CNC Middleware" `
  --input (Join-Path $Root "target") `
  --main-jar (Split-Path -Leaf $Jar) `
  --dest $InstallerDir `
  --win-console `
  --win-menu `
  --win-shortcut

Write-Host "Windows installer created in $InstallerDir"