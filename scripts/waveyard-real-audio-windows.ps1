<#
.SYNOPSIS
Runs Waveyard's real-audio stem separation measurement locally on Windows.

.DESCRIPTION
Requires a 44.1 kHz stereo PCM WAV file and installed project dependencies.
Audio is processed locally and is not uploaded. The JSON report records the
Windows runtime, CPU, model hashes, input details, elapsed time, and stem metrics.

.PARAMETER WavPath
Path to the input WAV file.

.PARAMETER ReportPath
Optional report destination. Defaults to generated-artifacts/waveyard-real-audio-windows.json.

.PARAMETER MaxSeconds
Maximum audio duration to process. Defaults to 20 seconds; accepts 2 to 20 seconds.

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -WavPath "C:\Music\sample.wav"
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$WavPath,

  [string]$ReportPath = "generated-artifacts/waveyard-real-audio-windows.json",

  [int]$MaxSeconds = 20
)

$ErrorActionPreference = "Stop"

if ($MaxSeconds -lt 2 -or $MaxSeconds -gt 20) {
  throw "MaxSeconds must be an integer from 2 to 20."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedWavPath = (Resolve-Path -LiteralPath $WavPath).Path
if ([System.IO.Path]::GetExtension($resolvedWavPath).ToLowerInvariant() -ne ".wav") {
  throw "This runner currently requires a 44.1 kHz stereo PCM WAV file. It does not convert MP3 or upload audio."
}

$resolvedReportPath = if ([System.IO.Path]::IsPathRooted($ReportPath)) {
  $ReportPath
} else {
  Join-Path $repoRoot $ReportPath
}
$reportDirectory = Split-Path -Parent $resolvedReportPath
if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}

$testPath = Join-Path $repoRoot "lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts"
if (-not (Test-Path -LiteralPath $testPath)) {
  throw "The Waveyard real-audio test was not found at $testPath."
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
  throw "Project dependencies are missing. Run pnpm install from the project root first."
}

$pnpm = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
if (-not $pnpm) {
  $pnpm = Get-Command "pnpm" -ErrorAction Stop
}
$pnpmExecutable = $pnpm.Source
if (-not $pnpmExecutable) {
  $pnpmExecutable = $pnpm.Name
}

$previousWavPath = $env:WAVEYARD_REAL_AUDIO_WAV
$previousReportPath = $env:WAVEYARD_REAL_AUDIO_REPORT
$previousMaxSeconds = $env:WAVEYARD_REAL_AUDIO_MAX_SECONDS
Push-Location $repoRoot
try {
  $env:WAVEYARD_REAL_AUDIO_WAV = $resolvedWavPath
  $env:WAVEYARD_REAL_AUDIO_REPORT = $resolvedReportPath
  $env:WAVEYARD_REAL_AUDIO_MAX_SECONDS = [string]$MaxSeconds

  & $pnpmExecutable --filter @workspace/scripts exec tsx --test --test-name-pattern "real audio excerpt" $testPath
  $testExitCode = $LASTEXITCODE
  if ($testExitCode -ne 0) {
    throw "Waveyard real-audio run failed with exit code $testExitCode."
  }

  Write-Host "Measurement report saved to $resolvedReportPath"
} finally {
  if ($null -eq $previousWavPath) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_WAV -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_WAV = $previousWavPath
  }
  if ($null -eq $previousReportPath) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_REPORT -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_REPORT = $previousReportPath
  }
  if ($null -eq $previousMaxSeconds) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_MAX_SECONDS -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_MAX_SECONDS = $previousMaxSeconds
  }
  Pop-Location
}
