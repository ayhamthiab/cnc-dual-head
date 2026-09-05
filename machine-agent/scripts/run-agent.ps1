param(
  [int]$Port = 18888,
  [string]$Token = ""
)

$Root = Split-Path -Parent $PSScriptRoot
$Jar = Join-Path $Root "target\dmhc-machine-agent.jar"
if (-not (Test-Path $Jar)) {
  throw "Agent JAR not found. Run .\scripts\build-agent.ps1 first."
}

$Arguments = @("-jar", $Jar, "--port", $Port)
if ($Token) {
  $Arguments += @("--token", $Token)
}
& java @Arguments