param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$AudioPath,
  [string]$ModelsPath
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "This measurement targets Windows x64."
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "ArenaForge.exe was not found at the supplied path."
}
if (-not (Test-Path -LiteralPath $AudioPath -PathType Leaf)) {
  throw "The audio file was not found at the supplied path."
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

$arguments = @("desktop/waveyard-acceptance.mjs", $Executable, $AudioPath, $ModelsPath)
& node @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Waveyard Windows measurement failed. Read the timestamped report in generated-artifacts\windows-waveyard."
}
