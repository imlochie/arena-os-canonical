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
Memory-only JSON report destination. Defaults to a separate path for automatic and CPU runs.

.PARAMETER MemoryRepetitions
Memory-only job count. Defaults to 7; accepts 6 to 12.
.PARAMETER MemoryProvider
Execution provider for memory-only mode. Defaults to automatic selection; use cpu to force CPU. Example: -MemoryOnly -MemoryProvider cpu

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

  [string]$MemoryReportPath,

  [int]$MemoryRepetitions = 7,
  [ValidateSet("auto", "cpu")]
  [string]$MemoryProvider = "auto"
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
  $MemoryProvider = $MemoryProvider.ToLowerInvariant()
  if ($MemoryRepetitions -lt 6 -or $MemoryRepetitions -gt 12) {
    throw "MemoryRepetitions must be an integer from 6 to 12."
  }
  if ($MemoryWavPath) {
    $resolvedMemoryWavPath = (Resolve-Path -LiteralPath $MemoryWavPath).Path
    if ([System.IO.Path]::GetExtension($resolvedMemoryWavPath).ToLowerInvariant() -ne ".wav") {
      throw "MemoryWavPath must be a 44.1 kHz stereo 16-bit PCM WAV file."
    }
  }
  $effectiveMemoryReportPath = if ($MemoryReportPath) {
    $MemoryReportPath
  } elseif ($MemoryProvider -eq "cpu") {
    "generated-artifacts/waveyard-four-stem-memory-windows-cpu.json"
  } else {
    "generated-artifacts/waveyard-four-stem-memory-windows.json"
  }
  $resolvedMemoryReportPath = if ([System.IO.Path]::IsPathRooted($effectiveMemoryReportPath)) {
    $effectiveMemoryReportPath
  } else {
    Join-Path $repoRoot $effectiveMemoryReportPath
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
  $previousMemoryProvider = $env:WAVEYARD_REAL_ORT_MEMORY_PROVIDER
  Push-Location $repoRoot
  $memoryStdoutPath = [System.IO.Path]::GetTempFileName()
  $memoryStderrPath = [System.IO.Path]::GetTempFileName()
  try {
    if ($resolvedMemoryWavPath) {
      $env:WAVEYARD_REAL_ORT_MEMORY_WAV = $resolvedMemoryWavPath
    } else {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_WAV -ErrorAction SilentlyContinue
    }
    $env:WAVEYARD_REAL_ORT_MEMORY_REPORT = $resolvedMemoryReportPath
    $env:WAVEYARD_REAL_ORT_MEMORY_REPETITIONS = [string]$MemoryRepetitions
    $env:WAVEYARD_REAL_ORT_MEMORY_PROVIDER = $MemoryProvider

    $runStartedAt = [DateTime]::UtcNow
    $nodeArguments = @(
      $memoryTestRunner,
      "--test",
      "--test-name-pattern",
      "repeated pinned four-model jobs",
      $testPath
    )
    $quotedArguments = foreach ($argument in $nodeArguments) {
      $escapedArgument = [regex]::Replace([string]$argument, '(\\*)"', '$1$1\"')
      $escapedArgument = [regex]::Replace($escapedArgument, '(\\+)$', '$1$1')
      '"' + $escapedArgument + '"'
    }
    $memoryTestProcess = Start-Process `
      -FilePath $nodeExecutable `
      -ArgumentList ($quotedArguments -join " ") `
      -WorkingDirectory $repoRoot `
      -PassThru `
      -NoNewWindow `
      -RedirectStandardOutput $memoryStdoutPath `
      -RedirectStandardError $memoryStderrPath

    $gpuCounterPath = '\GPU Process Memory(*)\Dedicated Usage'
    $gpuCounterAvailable = $false
    $gpuCounterUnavailableReason = $null
    $gpuSamples = [System.Collections.Generic.List[object]]::new()
    try {
      Get-Counter -Counter $gpuCounterPath -MaxSamples 1 -ErrorAction Stop | Out-Null
      $gpuCounterAvailable = $true
    } catch {
      $gpuCounterUnavailableReason = "Windows GPU Process Memory counter is unavailable: $($_.Exception.Message)"
    }

    $sampleProcessGpuMemory = {
      param([int]$ProcessId)
      try {
        $counter = Get-Counter -Counter $gpuCounterPath -MaxSamples 1 -ErrorAction Stop
        $processPattern = "(?i)pid_${ProcessId}(?:_|\\)"
        $processSamples = @($counter.CounterSamples | Where-Object { $_.Path -match $processPattern })
        if ($processSamples.Count -gt 0) {
          $dedicatedBytes = [long][Math]::Round(
            ($processSamples | Measure-Object -Property CookedValue -Sum).Sum
          )
          $gpuSamples.Add([pscustomobject]@{
            sampledAtUtcMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            dedicatedBytes = $dedicatedBytes
          })
        }
      } catch {
        # A sampling failure is reflected by missing per-job samples below.
      }
    }

    while (-not $memoryTestProcess.HasExited) {
      if ($gpuCounterAvailable) {
        & $sampleProcessGpuMemory $memoryTestProcess.Id
      }
      Start-Sleep -Milliseconds 1000
      $memoryTestProcess.Refresh()
    }
    $memoryTestProcess.WaitForExit()
    $testExitCode = $memoryTestProcess.ExitCode
    if ($gpuCounterAvailable) {
      # Capture the retained allocation after the final session has released.
      for ($sampleIndex = 0; $sampleIndex -lt 2; $sampleIndex += 1) {
        & $sampleProcessGpuMemory $memoryTestProcess.Id
        Start-Sleep -Milliseconds 1000
      }
    }
    Get-Content -LiteralPath $memoryStdoutPath | ForEach-Object { Write-Host $_ }
    Get-Content -LiteralPath $memoryStderrPath | ForEach-Object { Write-Host $_ }
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
    $expectedSelectionMode = if ($MemoryProvider -eq "cpu") { "forced" } else { "automatic" }
    if ($memoryReport.providerSelectionMode -ne $expectedSelectionMode -or $memoryReport.requestedProvider -ne $MemoryProvider) {
      throw "The report does not identify the requested $expectedSelectionMode $MemoryProvider provider run."
    }
    if ($MemoryProvider -eq "cpu" -and $memoryReport.selectedProvider -ne "cpu") {
      throw "The forced-CPU run selected '$($memoryReport.selectedProvider)' instead of cpu."
    }
    if ($MemoryProvider -eq "auto" -and @("dml", "cpu") -notcontains $memoryReport.selectedProvider) {
      throw "The Windows run selected unexpected provider '$($memoryReport.selectedProvider)'; expected dml or cpu."
    }
    if (-not $memoryReport.selectedProvider -or -not $memoryReport.summary.continuedGrowthBounded) {
      throw "The report has no consistent selected provider or continued RSS growth exceeded the limit."
    }
    if (@($memoryReport.models).Count -ne 4) {
      throw "The report does not identify all four pinned models."
    }
    foreach ($job in $memoryReport.jobs) {
      if ($job.requestedDevice -ne $MemoryProvider) {
        throw "Repetition $($job.repetition) requested '$($job.requestedDevice)' instead of $MemoryProvider."
      }
      if ($job.resolvedDevice -ne $memoryReport.selectedProvider) {
        throw "The selected provider changed between memory repetitions."
      }
      if ($null -eq $job.postReleaseMemory.rss -or $job.postReleaseMemory.rss -le 0) {
        throw "Repetition $($job.repetition) does not include a valid post-job RSS measurement."
      }
      foreach ($model in $memoryReport.models) {
        $chunkCount = $job.chunkCounts.PSObject.Properties[$model.id].Value
        if ($null -eq $chunkCount -or $chunkCount -le 1) {
          throw "Repetition $($job.repetition) did not process multiple chunks for $($model.id)."
        }
      }
    }

    $gpuMemoryApplicable = $memoryReport.selectedProvider -eq "dml"
    $gpuMemoryStatus = "not_applicable"
    $gpuMemoryReason = "The selected provider was CPU; DirectML GPU memory does not apply."
    if ($gpuMemoryApplicable) {
      $gpuMemoryStatus = "unavailable"
      $gpuMemoryReason = $gpuCounterUnavailableReason
      if ($gpuCounterAvailable) {
        $gpuMemoryReason = "The GPU counter did not report dedicated memory for the Node separation process."
      }
      if ($gpuSamples.Count -gt 0) {
        $gpuMemoryStatus = "measured"
        $gpuMemoryReason = $null
      }
    }

    $gpuJobMeasurements = @()
    foreach ($job in $memoryReport.jobs) {
      $duringJob = @($gpuSamples | Where-Object {
        $_.sampledAtUtcMs -ge $job.startedAtUtcMs -and $_.sampledAtUtcMs -le $job.finishedAtUtcMs
      })
      $postRelease = $null
      $postReleaseSampleUtcMs = $null
      if ($gpuMemoryApplicable -and $gpuSamples.Count -gt 0) {
        $nearbySamples = @($gpuSamples | Where-Object {
          $_.sampledAtUtcMs -ge $job.finishedAtUtcMs -and $_.sampledAtUtcMs -le ($job.finishedAtUtcMs + 2000)
        } | Sort-Object { $_.sampledAtUtcMs })
        if ($nearbySamples.Count -gt 0) {
          $postRelease = $nearbySamples[0].dedicatedBytes
          $postReleaseSampleUtcMs = $nearbySamples[0].sampledAtUtcMs
        }
      }
      $peakDedicatedBytes = $null
      if ($duringJob.Count -gt 0) {
        $peakDedicatedBytes = [long](($duringJob | Measure-Object -Property dedicatedBytes -Maximum).Maximum)
      }
      $jobGpuStatus = if (-not $gpuMemoryApplicable) { "not_applicable" } elseif ($duringJob.Count -gt 0) { "measured" } else { "unavailable" }
      $jobGpuReason = if ($jobGpuStatus -eq "not_applicable") {
        "The selected provider was CPU."
      } elseif ($jobGpuStatus -eq "unavailable") {
        "No GPU counter sample fell within this job's execution window."
      } else {
        $null
      }
      $jobGpuMemory = [pscustomobject]@{
        status = $jobGpuStatus
        sampleCount = $duringJob.Count
        peakDedicatedBytes = $peakDedicatedBytes
        postReleaseDedicatedBytes = $postRelease
        postReleaseSampleUtcMs = $postReleaseSampleUtcMs
        unavailableReason = $jobGpuReason
      }
      $job | Add-Member -NotePropertyName gpuMemory -NotePropertyValue $jobGpuMemory -Force
      $gpuJobMeasurements += $jobGpuMemory
    }

    if ($gpuMemoryApplicable -and $gpuSamples.Count -gt 0) {
      $jobsWithGpuSamples = @($gpuJobMeasurements | Where-Object { $_.sampleCount -gt 0 }).Count
      if ($jobsWithGpuSamples -eq $gpuJobMeasurements.Count) {
        $gpuMemoryStatus = "measured"
      } else {
        $gpuMemoryStatus = "partial"
        $gpuMemoryReason = "GPU memory samples were missing from one or more repeated job windows."
      }
    }

    $gpuMemoryLevelsOffAfterWarmup = $null
    $gpuFirstSteadyBytes = $null
    $gpuFinalHalfMedianBytes = $null
    $gpuContinuedGrowthBytes = $null
    $gpuAllowedContinuedGrowthBytes = 128 * 1024 * 1024
    if ($gpuMemoryApplicable -and $gpuMemoryStatus -eq "measured") {
      $postReleaseValues = @($gpuJobMeasurements | ForEach-Object { $_.postReleaseDedicatedBytes })
      $hasCompletePostReleaseSamples = $postReleaseValues.Count -eq $MemoryRepetitions -and
        @($postReleaseValues | Where-Object { $null -eq $_ }).Count -eq 0
      if ($hasCompletePostReleaseSamples -and $postReleaseValues.Count -gt $memoryReport.warmupJobs) {
        $firstSteadyIndex = [int]$memoryReport.warmupJobs
        $gpuFirstSteadyBytes = [long]$postReleaseValues[$firstSteadyIndex]
        $steadyValues = @($postReleaseValues | Select-Object -Skip $firstSteadyIndex)
        $tailValues = @($steadyValues | Select-Object -Skip ([int][Math]::Floor($steadyValues.Count / 2)) | Sort-Object)
        $middleGpuIndex = [int][Math]::Floor($tailValues.Count / 2)
        if ($tailValues.Count % 2 -eq 1) {
          $gpuFinalHalfMedianBytes = [long]$tailValues[$middleGpuIndex]
        } else {
          $gpuFinalHalfMedianBytes = [long](($tailValues[$middleGpuIndex - 1] + $tailValues[$middleGpuIndex]) / 2)
        }
        $gpuContinuedGrowthBytes = $gpuFinalHalfMedianBytes - $gpuFirstSteadyBytes
        $gpuMemoryLevelsOffAfterWarmup = $gpuContinuedGrowthBytes -le $gpuAllowedContinuedGrowthBytes
      } else {
        $gpuMemoryStatus = "partial"
        $gpuMemoryReason = "GPU readings were collected, but there were not enough post-release samples for a warm-up trend."
      }
    }

    $gpuMemoryReport = [pscustomobject]@{
      applicable = $gpuMemoryApplicable
      status = $gpuMemoryStatus
      source = if ($gpuMemoryApplicable) { "Windows GPU Process Memory\\Dedicated Usage counter, filtered to the Node test process" } else { $null }
      sampleIntervalMs = 1000
      samples = if ($gpuMemoryApplicable) { @($gpuSamples.ToArray()) } else { @() }
      unavailableReason = $gpuMemoryReason
    }
    $memoryReport | Add-Member -NotePropertyName gpuMemory -NotePropertyValue $gpuMemoryReport -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuMemoryStatus -NotePropertyValue $gpuMemoryStatus -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuFirstSteadyPostReleaseBytes -NotePropertyValue $gpuFirstSteadyBytes -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuFinalHalfMedianPostReleaseBytes -NotePropertyValue $gpuFinalHalfMedianBytes -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuContinuedGrowthBytes -NotePropertyValue $gpuContinuedGrowthBytes -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuAllowedContinuedGrowthBytes -NotePropertyValue $gpuAllowedContinuedGrowthBytes -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuMemoryLevelsOffAfterWarmup -NotePropertyValue $gpuMemoryLevelsOffAfterWarmup -Force
    $memoryReport.summary | Add-Member -NotePropertyName gpuMemoryTrendMethod -NotePropertyValue "Compare the final-half median post-release dedicated memory after $($memoryReport.warmupJobs) warm-up jobs with the first steady job; levels off means growth is at most 128 MiB." -Force
    $memoryReport | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $resolvedMemoryReportPath -Encoding UTF8

    if ($memoryReport.selectedProvider -eq "cpu" -and $memoryReport.gpuMemory.status -ne "not_applicable") {
      throw "CPU fallback must label dedicated GPU memory as not applicable."
    }
    if ($memoryReport.selectedProvider -eq "dml" -and $memoryReport.gpuMemory.status -eq "measured") {
      if (@($memoryReport.jobs | Where-Object { $_.gpuMemory.sampleCount -lt 1 }).Count -gt 0) {
        throw "The DirectML report is missing a GPU measurement for one or more repeated jobs."
      }
      if ($null -eq $memoryReport.summary.gpuMemoryLevelsOffAfterWarmup) {
        throw "The DirectML report does not state whether GPU memory levels off after warm-up."
      }
    }

    $rssSamples = @($memoryReport.jobs | ForEach-Object { [Math]::Round($_.postReleaseMemory.rss / 1MB, 1) })
    Write-Host "Windows memory report saved to $resolvedMemoryReportPath"
    Write-Host "Provider selection: $($memoryReport.providerSelectionMode) ($($memoryReport.requestedProvider)); selected provider: $($memoryReport.selectedProvider)"
    Write-Host "Post-job RSS (MiB): $($rssSamples -join ' -> ')"
    Write-Host "Continued RSS growth after warm-up: $([Math]::Round($memoryReport.summary.continuedRssGrowthBytes / 1MB, 1)) MiB; bounded: $($memoryReport.summary.continuedGrowthBounded)"
    if ($gpuMemoryStatus -eq "measured") {
      $gpuSamplesMiB = @($memoryReport.jobs | ForEach-Object {
        if ($null -eq $_.gpuMemory.postReleaseDedicatedBytes) { "n/a" }
        else { [Math]::Round($_.gpuMemory.postReleaseDedicatedBytes / 1MB, 1) }
      })
      Write-Host "Post-release dedicated GPU memory (MiB): $($gpuSamplesMiB -join ' -> ')"
      if ($null -eq $gpuMemoryLevelsOffAfterWarmup) {
        Write-Host "Dedicated GPU memory level-off after warm-up: undetermined (insufficient post-release samples)"
      } else {
        Write-Host "Dedicated GPU memory level-off after warm-up: $gpuMemoryLevelsOffAfterWarmup (continued growth $([Math]::Round($gpuContinuedGrowthBytes / 1MB, 1)) MiB)"
      }
    } else {
      Write-Host "Dedicated GPU memory measurement: $gpuMemoryStatus ($gpuMemoryReason)"
      if (-not $gpuMemoryApplicable) {
        Write-Host "Dedicated GPU memory level-off after warm-up: not applicable to CPU execution."
      } else {
        Write-Host "Dedicated GPU memory level-off after warm-up: undetermined (GPU counter data is incomplete)."
      }
    }
  } finally {
    if (Test-Path -LiteralPath $memoryStdoutPath) {
      Remove-Item -LiteralPath $memoryStdoutPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $memoryStderrPath) {
      Remove-Item -LiteralPath $memoryStderrPath -Force -ErrorAction SilentlyContinue
    }
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
    if ($null -eq $previousMemoryProvider) {
      Remove-Item Env:WAVEYARD_REAL_ORT_MEMORY_PROVIDER -ErrorAction SilentlyContinue
    } else {
      $env:WAVEYARD_REAL_ORT_MEMORY_PROVIDER = $previousMemoryProvider
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
