<#
.SYNOPSIS
Runs a low-level real-audio separation pipeline measurement on Windows.

.DESCRIPTION
This paired benchmark runs sequential 2/1 and bounded-parallel 1/2 CPU settings
for multiple repetitions against the same pinned models and audio excerpt. It
does not launch the packaged ArenaForge app or verify live stem playback.
For the complete installed-app Windows acceptance check, use
desktop/Measure-Waveyard.ps1 instead.

Use -MemoryOnly to run repeated production-worker jobs with all four pinned
models and record post-job process memory, provider, and per-model chunk counts.
The memory-only mode uses a deterministic multi-chunk synthetic input unless
-MemoryWavPath points to a local 44.1 kHz stereo 16-bit PCM WAV.

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

.PARAMETER MemoryOnly
Run only the pinned four-model repeated memory measurement.

.PARAMETER MemoryWavPath
Optional 44.1 kHz stereo 16-bit PCM WAV input for memory-only mode.

.PARAMETER MemoryReportPath
Memory-only JSON report destination.

.PARAMETER MemoryRepetitions
Memory-only job count. Defaults to 7; accepts 6 to 12.

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -AudioPath "C:\Music\sample.mp3"

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -AudioPath "C:\Music\sample.mp3" -StartSeconds 25

.EXAMPLE
.\scripts\waveyard-real-audio-windows.ps1 -MemoryOnly
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [Alias("WavPath")]
  [string]$AudioPath,

  [string]$ReportPath = "generated-artifacts/waveyard-real-audio-windows.json",

  [int]$MaxSeconds = 20,

  [int]$StartSeconds = 0,

  [int]$Repetitions = 3,

  [switch]$MemoryOnly,

  [string]$MemoryWavPath,

  [string]$MemoryReportPath = "generated-artifacts/waveyard-four-stem-memory-windows.json",

  [int]$MemoryRepetitions = 7
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
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

if ($MemoryOnly) {
  if ($MemoryRepetitions -lt 6 -or $MemoryRepetitions -gt 12) {
    throw "MemoryRepetitions must be an integer from 6 to 12."
  }
  if ($MemoryWavPath) {
    $resolvedMemoryWavPath = (Resolve-Path -LiteralPath $MemoryWavPath).Path
    if ([System.IO.Path]::GetExtension($resolvedMemoryWavPath).ToLowerInvariant() -ne ".wav") {
      throw "MemoryWavPath must be a 44.1 kHz stereo 16-bit PCM WAV file."
    }
  }
  $resolvedMemoryReportPath = if ([System.IO.Path]::IsPathRooted($MemoryReportPath)) {
    $MemoryReportPath
  } else {
    Join-Path $repoRoot $MemoryReportPath
  }
  $memoryReportDirectory = Split-Path -Parent $resolvedMemoryReportPath
  if ($memoryReportDirectory -and -not (Test-Path -LiteralPath $memoryReportDirectory)) {
    New-Item -ItemType Directory -Path $memoryReportDirectory -Force | Out-Null
  }
  $memoryTestRunner = Join-Path $repoRoot "scripts/node_modules/tsx/dist/cli.mjs"
  if (-not (Test-Path -LiteralPath $memoryTestRunner)) {
    throw "The scripts workspace TypeScript test runner is missing at $memoryTestRunner."
  }

  $previousMemoryWav = $env:WAVEYARD_REAL_ORT_MEMORY_WAV
  $previousMemoryReport = $env:WAVEYARD_REAL_ORT_MEMORY_REPORT
  $previousMemoryRepetitions = $env:WAVEYARD_REAL_ORT_MEMORY_REPETITIONS
  Push-Location $repoRoot
  try {
    if ($resolvedMemoryWavPath) {
      $env:WAVEYARD_REAL_ORT_MEMORY_WAV = $resolvedMemoryWavPath
    } else {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_WAV -ErrorAction SilentlyContinue
    }
    $env:WAVEYARD_REAL_ORT_MEMORY_REPORT = $resolvedMemoryReportPath
    $env:WAVEYARD_REAL_ORT_MEMORY_REPETITIONS = [string]$MemoryRepetitions

    $runStartedAt = [DateTime]::UtcNow
    & $nodeExecutable $memoryTestRunner --test --test-name-pattern "repeated pinned four-model jobs" $testPath
    $testExitCode = $LASTEXITCODE
    if ($testExitCode -ne 0) {
      throw "The Windows four-stem memory run failed with exit code $testExitCode."
    }
    if (-not (Test-Path -LiteralPath $resolvedMemoryReportPath)) {
      throw "The memory test passed without creating its report at $resolvedMemoryReportPath."
    }
    $reportFile = Get-Item -LiteralPath $resolvedMemoryReportPath
    if ($reportFile.LastWriteTimeUtc -lt $runStartedAt.AddSeconds(-2)) {
      throw "The memory report at $resolvedMemoryReportPath is stale."
    }
    $memoryReport = Get-Content -LiteralPath $resolvedMemoryReportPath -Raw | ConvertFrom-Json
    if ($memoryReport.measuredMachine.platform -ne "win32") {
      throw "The report records platform '$($memoryReport.measuredMachine.platform)', not win32."
    }
    if ($memoryReport.repetitions -ne $MemoryRepetitions -or @($memoryReport.jobs).Count -ne $MemoryRepetitions) {
      throw "The report does not contain all requested memory repetitions."
    }
    if ($memoryReport.requestedProvider -ne "auto") {
      throw "The report did not run with automatic provider selection."
    }
    if (@("dml", "cpu") -notcontains $memoryReport.selectedProvider) {
      throw "The Windows run selected unexpected provider '$($memoryReport.selectedProvider)'; expected dml or cpu."
    }
    if (-not $memoryReport.selectedProvider -or -not $memoryReport.summary.continuedGrowthBounded) {
      throw "The report has no consistent selected provider or continued RSS growth exceeded the limit."
    }
    if (@($memoryReport.models).Count -ne 4) {
      throw "The report does not identify all four pinned models."
    }
    foreach ($job in $memoryReport.jobs) {
      if ($job.resolvedDevice -ne $memoryReport.selectedProvider) {
        throw "The selected provider changed between memory repetitions."
      }
      foreach ($model in $memoryReport.models) {
        $chunkCount = $job.chunkCounts.PSObject.Properties[$model.id].Value
        if ($null -eq $chunkCount -or $chunkCount -le 1) {
          throw "Repetition $($job.repetition) did not process multiple chunks for $($model.id)."
        }
      }
    }

    $rssSamples = @($memoryReport.jobs | ForEach-Object { [Math]::Round($_.memory.rss / 1MB, 1) })
    Write-Host "Windows memory report saved to $resolvedMemoryReportPath"
    Write-Host "Selected provider: $($memoryReport.selectedProvider)"
    Write-Host "Post-job RSS (MiB): $($rssSamples -join ' -> ')"
    Write-Host "Continued RSS growth after warm-up: $([Math]::Round($memoryReport.summary.continuedRssGrowthBytes / 1MB, 1)) MiB; bounded: $($memoryReport.summary.continuedGrowthBounded)"
  } finally {
    if ($null -eq $previousMemoryWav) {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_WAV -ErrorAction SilentlyContinue
    } else {
      $env:WAVEYARD_REAL_ORT_MEMORY_WAV = $previousMemoryWav
    }
    if ($null -eq $previousMemoryReport) {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_REPORT -ErrorAction SilentlyContinue
    } else {
      $env:WAVEYARD_REAL_ORT_MEMORY_REPORT = $previousMemoryReport
    }
    if ($null -eq $previousMemoryRepetitions) {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_REPETITIONS -ErrorAction SilentlyContinue
    } else {
      $env:WAVEYARD_REAL_ORT_MEMORY_REPETITIONS = $previousMemoryRepetitions
    }
    Pop-Location
  }
  return
}

if (-not $AudioPath) {
  throw "AudioPath is required unless -MemoryOnly is selected."
}
if ($MaxSeconds -lt 2 -or $MaxSeconds -gt 20) {
  throw "MaxSeconds must be an integer from 2 to 20."
}
if ($StartSeconds -lt 0 -or $StartSeconds -gt 899) {
  throw "StartSeconds must be an integer from 0 to 899."
}
if ($Repetitions -lt 2 -or $Repetitions -gt 10) {
  throw "Repetitions must be an integer from 2 to 10."
}

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
