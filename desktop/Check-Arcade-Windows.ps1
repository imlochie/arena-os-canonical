param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$Model = "qwen2.5:3b"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "This acceptance check requires Windows x64."
}
if (-not (Test-Path $Executable)) {
  throw "Supply -Executable with the full path to the installed ArenaForge.exe."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Install Node.js 22 or newer and the workspace dependencies before running this check."
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "Install and open Ollama first (winget install Ollama.Ollama). No account or API key is needed."
}

try {
  $tags = Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
} catch {
  throw "Ollama is not answering locally. Open the Ollama application and rerun this check."
}
if ($tags.models.name -notcontains $Model) {
  throw "Model '$Model' is not installed. Install it with: ollama pull $Model"
}

Write-Host "This check uses the packaged app, the installed local Ollama model, and an isolated data directory."
Write-Host "WebGPU is explicitly disabled. Import and gameplay editing are untested; Pong mechanics are checked in the isolated preview."
& node "$PSScriptRoot\arcade-acceptance.mjs" (Resolve-Path $Executable).Path $Model
if ($LASTEXITCODE -ne 0) {
  throw "The live local-model Arcade check failed. Inspect generated-artifacts\windows-check\arcade-result.json."
}
Write-Host "Arcade generation and Pong mechanics check passed. Share only generated-artifacts\windows-check\arcade-result.json."
