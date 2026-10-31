<#
.SYNOPSIS
Runs a low-level real-audio separation pipeline measurement on Windows.

.DESCRIPTION
This paired benchmark runs sequential 2/1 and bounded-parallel 1/2 CPU settings
for multiple repetitions against the same pinned models and audio excerpt. It
does not launch the packaged ArenaForge app or verify live stem playback.
For the complete installed-app Windows acceptance check, use
desktop/Measure-Waveyard.ps1 instead.

Accepts WAV, MP3, FLAC, M4A, AAC, and OGG files plus installed project dependencies.
Compressed formats and WAV files outside native 16-bit PCM at 44.1 kHz require
ffmpeg to be available through Arena's local resolver.
Audio is processed locally and is not uploaded. The JSON report records the
Windows runtime, CPU, model hashes, input details, elapsed time, and stem metrics.
This comparison measures CPU inference; it does not establish DirectML performance.

.PARAMETER AudioPath
Path to a local supported audio file.

.PARAMETER ReportPath
Optional report destination. Defaults to generated-artifacts/waveyard-real-audio-windows.json.

.PARAMETER MaxSeconds
Maximum audio duration to process. Defaults to 20 seconds; accepts 2 to 20 seconds.

.PARAMETER StartSeconds
Whole-second offset into the audio file. Defaults to the beginning.

.PARAMETER Repetitions
Paired repetitions. Defaults to 3; accepts 2 to 10.

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -AudioPath "C:\Music\sample.mp3"

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -AudioPath "C:\Music\sample.mp3" -StartSeconds 25
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [Alias("WavPath")]
  [string]$AudioPath,

  [string]$ReportPath = "generated-artifacts/waveyard-real-audio-windows.json",

  [int]$MaxSeconds = 20,

  [int]$StartSeconds = 0,

  [int]$Repetitions = 3
)

$ErrorActionPreference = "Stop"

if ($MaxSeconds -lt 2 -or $MaxSeconds -gt 20) {
  throw "MaxSeconds must be an integer from 2 to 20."
}
if ($StartSeconds -lt 0 -or $StartSeconds -gt 899) {
  throw "StartSeconds must be an integer from 0 to 899."
}
if ($Repetitions -lt 2 -or $Repetitions -gt 10) {
  throw "Repetitions must be an integer from 2 to 10."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedAudioPath = (Resolve-Path -LiteralPath $AudioPath).Path
$audioExtension = [System.IO.Path]::GetExtension($resolvedAudioPath).ToLowerInvariant()
$allowedAudioExtensions = @(".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg")
if ($allowedAudioExtensions -notcontains $audioExtension) {
  throw "Use a WAV, MP3, FLAC, M4A, AAC, or OGG audio file."
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

$node = Get-Command "node" -ErrorAction Stop
$nodeExecutable = $node.Source
if (-not $nodeExecutable) {
  $nodeExecutable = $node.Name
}

$previousInputPath = $env:WAVEYARD_REAL_AUDIO_INPUT
$previousReportPath = $env:WAVEYARD_REAL_AUDIO_REPORT
$previousMaxSeconds = $env:WAVEYARD_REAL_AUDIO_MAX_SECONDS
$previousStartSeconds = $env:WAVEYARD_REAL_AUDIO_START_SECONDS
$previousRepetitions = $env:WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS
Push-Location $repoRoot
try {
  $env:WAVEYARD_REAL_AUDIO_INPUT = $resolvedAudioPath
  $env:WAVEYARD_REAL_AUDIO_REPORT = $resolvedReportPath
  $env:WAVEYARD_REAL_AUDIO_MAX_SECONDS = [string]$MaxSeconds
  $env:WAVEYARD_REAL_AUDIO_START_SECONDS = [string]$StartSeconds
  $env:WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS = [string]$Repetitions

  $runStartedAt = [DateTime]::UtcNow
  & $nodeExecutable (Join-Path $repoRoot "scripts/waveyard-real-audio-benchmark.mjs")
  $testExitCode = $LASTEXITCODE
  if ($testExitCode -ne 0) {
    throw "Waveyard real-audio run failed with exit code $testExitCode."
  }
  if (-not (Test-Path -LiteralPath $resolvedReportPath)) {
    throw "The measurement passed but did not create its JSON report at $resolvedReportPath."
  }
  $reportFile = Get-Item -LiteralPath $resolvedReportPath
  if ($reportFile.LastWriteTimeUtc -lt $runStartedAt.AddSeconds(-2)) {
    throw "The report at $resolvedReportPath is stale; no new Windows result was recorded."
  }
  $report = Get-Content -LiteralPath $resolvedReportPath -Raw | ConvertFrom-Json
  if ($report.measuredMachine.platform -ne "win32") {
    throw "The report records platform '$($report.measuredMachine.platform)', not win32. It is not Windows evidence."
  }
  if ($report.summary.sequential.repetitions -ne $Repetitions -or $report.summary.parallel.repetitions -ne $Repetitions) {
    throw "The report does not contain all requested paired repetitions."
  }
  if ($report.measuredMachine.cpuModel -eq $null) {
    throw "The report does not identify the Windows CPU model."
  }

  Write-Host "Measurement report saved to $resolvedReportPath"
} finally {
  if ($null -eq $previousInputPath) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_INPUT -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_INPUT = $previousInputPath
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
  if ($null -eq $previousStartSeconds) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_START_SECONDS -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_START_SECONDS = $previousStartSeconds
  }
  if ($null -eq $previousRepetitions) {
    Remove-Item Env:WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS -ErrorAction SilentlyContinue
  } else {
    $env:WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS = $previousRepetitions
  }
  Pop-Location
}
