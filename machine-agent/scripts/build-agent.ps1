$ErrorActionPreference = "Stop"

# Builds the pinned UGS Core source and then the local-only machine agent.
$Root = Split-Path -Parent $PSScriptRoot
$Workspace = Split-Path -Parent $Root
$UgsDir = if ($env:DMHC_UGS_DIR) { $env:DMHC_UGS_DIR } else { Join-Path $Workspace ".agent-ugs\Universal-G-Code-Sender" }
$UgsRepo = "https://github.com/winder/Universal-G-Code-Sender.git"
$UgsCommit = "7c7d45b6b94a718589ce4b444865cd790c34882a"

if (-not (Get-Command java -ErrorAction SilentlyContinue) -or -not (Get-Command mvn -ErrorAction SilentlyContinue)) {
  throw "Java 17+ and Maven are required. Install a JDK before building."
}

if (-not (Test-Path (Join-Path $UgsDir ".git"))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UgsDir) | Out-Null
  git clone $UgsRepo $UgsDir
}

git -C $UgsDir fetch --tags --quiet
git -C $UgsDir checkout --detach $UgsCommit
mvn -q -f (Join-Path $UgsDir "pom.xml") -pl ugs-core -am install -DskipTests
mvn -q -f (Join-Path $Root "pom.xml") clean test package

$LicenseDir = Join-Path $Root "target\third-party-licenses"
New-Item -ItemType Directory -Force -Path $LicenseDir | Out-Null
Copy-Item (Join-Path $UgsDir "COPYING") (Join-Path $LicenseDir "UGS-COPYING.txt") -Force
Copy-Item (Join-Path $Root "NOTICE.md") (Join-Path $LicenseDir "NOTICE.md") -Force

Write-Host ""
Write-Host "Built: $Root\target\dmhc-machine-agent.jar"
Write-Host "Start: java -jar $Root\target\dmhc-machine-agent.jar"