param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$AudioPath,
  [string]$ModelsPath,
  [int]$MaxSeconds = 20,
  [int]$StartSeconds = 0
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "This measurement targets Windows x64."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Install Node.js LTS 22+ and reopen PowerShell before running the Waveyard measurement."
}
$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required to run the Waveyard measurement."
}
$playwrightPackage = Join-Path $PSScriptRoot "node_modules\playwright-core\package.json"
if (-not (Test-Path -LiteralPath $playwrightPackage -PathType Leaf)) {
  throw "Install this workspace's dependencies first by running pnpm install from the project root."
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "ArenaForge.exe was not found at the supplied path."
}
if (-not (Test-Path -LiteralPath $AudioPath -PathType Leaf)) {
  throw "The audio file was not found at the supplied path."
}
if ($MaxSeconds -ne 0 -and ($MaxSeconds -lt 2 -or $MaxSeconds -gt 20)) {
  throw "MaxSeconds must be 0 (full remaining file) or an integer from 2 to 20."
}
if ($StartSeconds -lt 0 -or $StartSeconds -gt 899) {
  throw "StartSeconds must be an integer from 0 to 899."
}
if (-not $env:LOCALAPPDATA -and -not $ModelsPath) {
  throw "LOCALAPPDATA is unavailable; pass -ModelsPath to the prepared Waveyard model cache."
}
if (-not $ModelsPath) {
  $ModelsPath = Join-Path $env:LOCALAPPDATA "Arena\waveyard\models"
}
if (-not (Test-Path -LiteralPath $ModelsPath -PathType Container)) {
  throw "The model cache was not found. Open Waveyard, prepare the four stem models, then rerun this measurement."
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$AudioPath = (Resolve-Path -LiteralPath $AudioPath).Path
$ModelsPath = (Resolve-Path -LiteralPath $ModelsPath).Path

$arguments = @(
  "desktop/waveyard-acceptance.mjs",
  $Executable,
  $AudioPath,
  $ModelsPath,
  [string]$MaxSeconds,
  [string]$StartSeconds
)
& node @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Waveyard Windows measurement failed. Read the timestamped report in generated-artifacts\windows-waveyard."
}
