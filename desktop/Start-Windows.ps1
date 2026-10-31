param(
  [ValidateSet("Build", "Check")][string]$Action = "Build",
  [string]$Executable,
  [string]$Model,
  [switch]$FullWorkspace
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "This package targets Windows x64."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Install Node.js LTS first (winget install OpenJS.NodeJS.LTS), reopen PowerShell, then run this script again."
}
$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required to build this app." }
function Invoke-Pnpm {
  & npx.cmd --yes pnpm@10.26.1 @args
  if ($LASTEXITCODE -ne 0) { throw "pnpm command failed. See the error above." }
}
if ($Action -eq "Build") {
  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "Waveyard's native WASAPI capture host requires MSVC C++. To avoid installing the large Visual Studio C++ toolchain on this laptop, use the arenaforge-windows-x64 artifact from the Windows package workflow."
  }
  Write-Host "This downloads build dependencies, Electron, PostgreSQL and Chromium."
  Write-Host "It does not upload your workspace data, install an AI model, or change an existing Arena database."
  $tempPath = [IO.Path]::GetTempPath()
  $spaceLocations = @(
    "workspace=$root",
    "temporary files=$tempPath",
    "desktop staging=$(Join-Path $PSScriptRoot 'stage')",
    "desktop bundle=$(Join-Path $PSScriptRoot 'dist')",
    "installer output=$(Join-Path $root 'generated-artifacts\windows')",
    "FFmpeg download cache=$(Join-Path $root 'generated-artifacts\windows-tool-cache')"
  )
  if ($env:LOCALAPPDATA) {
    $spaceLocations += "user caches=$env:LOCALAPPDATA"
    $spaceLocations += "Chromium download cache=$(Join-Path $env:LOCALAPPDATA 'ms-playwright')"
    $spaceLocations += "Electron build cache=$(Join-Path $env:LOCALAPPDATA 'electron-builder\Cache')"
  }
  $spaceOutput = & node (Join-Path $PSScriptRoot "build-space-preflight.mjs") `
    @spaceLocations
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect build disk space. No dependency installation has started." }
  $spaceReport = $spaceOutput | ConvertFrom-Json
  foreach ($location in $spaceReport.locations) {
    if ($null -eq $location.availableGiB) {
      Write-Host ("{0}: could not inspect {1}: {2}" -f $location.label, $location.path, $location.inspectionError)
    } else {
      Write-Host ("{0}: {1} GiB free (checking {2})" -f $location.label, $location.availableGiB, $location.checkedPath)
    }
  }
  Write-Host ("Required free space on every listed volume: {0} GiB (set ARENA_BUILD_MIN_FREE_GIB to configure)" -f $spaceReport.minimumFreeGiB)
  if ($spaceReport.insufficientSpace) {
    throw "Build stopped before dependency installation or downloads because one or more volumes are below the required free-space threshold or could not be checked. Free space or set ARENA_BUILD_MIN_FREE_GIB to a threshold chosen from a measured build; no app data or generated files were deleted."
  }
  $sampleFile = Join-Path $tempPath "arena-build-space-$PID.jsonl"
  Remove-Item $sampleFile -Force -ErrorAction SilentlyContinue
  $monitorLocationsJson = ConvertTo-Json -InputObject @($spaceLocations) -Compress
  $monitor = Start-Job -ArgumentList @($monitorLocationsJson, $sampleFile) -ScriptBlock {
    param($locationsJson, $samplePath)
    $locations = ConvertFrom-Json $locationsJson
    while ($true) {
      $samples = foreach ($entry in $locations) {
        $separator = $entry.IndexOf("=")
        $label = $entry.Substring(0, $separator)
        $target = $entry.Substring($separator + 1)
        try {
          $driveRoot = [IO.Path]::GetPathRoot($target)
          $drive = [IO.DriveInfo]::new($driveRoot)
          if ($drive.IsReady) {
            [pscustomobject]@{ label = $label; freeBytes = $drive.AvailableFreeSpace }
          }
        } catch {}
      }
      $line = ConvertTo-Json -InputObject ([pscustomobject]@{ locations = @($samples) }) -Compress
      [IO.File]::AppendAllText($samplePath, $line + [Environment]::NewLine)
      Start-Sleep -Seconds 2
    }
  }
  $spaceSamples = @()
  try {
    if ($FullWorkspace) {
      Write-Host "Installing every workspace package as requested."
      Invoke-Pnpm install --frozen-lockfile
    } else {
      Write-Host "Installing only the desktop app, API, web app and their workspace dependencies."
      Invoke-Pnpm install --frozen-lockfile `
        --filter "@workspace/arenaforge..." `
        --filter "@workspace/api-server..." `
        --filter "@workspace/desktop..."
    }
    Invoke-Pnpm --filter @workspace/desktop run dist:win
  } finally {
    if ($monitor) {
      Stop-Job $monitor -ErrorAction SilentlyContinue
      Receive-Job $monitor -ErrorAction SilentlyContinue | Out-Null
      Remove-Job $monitor -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $sampleFile) {
      foreach ($line in Get-Content $sampleFile) {
        try { $spaceSamples += ($line | ConvertFrom-Json) } catch {}
      }
      Remove-Item $sampleFile -Force -ErrorAction SilentlyContinue
    }
    $peakConsumptionBytes = [double]0
    $sampleCount = 0
    foreach ($initial in $spaceReport.locations) {
      if ($null -eq $initial.availableBytes) { continue }
      foreach ($sampleSet in $spaceSamples) {
        foreach ($sample in $sampleSet.locations) {
          if ($sample.label -eq $initial.label) {
            $sampleCount++
            $consumed = [double]$initial.availableBytes - [double]$sample.freeBytes
            if ($consumed -gt $peakConsumptionBytes) { $peakConsumptionBytes = $consumed }
          }
        }
      }
    }
    $measuredPeakGiB = $null
    if ($sampleCount -gt 0) {
      $measuredPeakGiB = [math]::Round($peakConsumptionBytes / [math]::Pow(1024, 3), 2)
    }
    $measurement = [pscustomobject]@{
      measuredAtUtc = [DateTime]::UtcNow.ToString("o")
      measuredPeakConsumptionGiB = $measuredPeakGiB
      minimumFreeGiB = $spaceReport.minimumFreeGiB
      sampleIntervalSeconds = 2
      locations = $spaceReport.locations
    }
    try {
      $measurementDir = Join-Path $root "generated-artifacts"
      New-Item -ItemType Directory -Path $measurementDir -Force | Out-Null
      $reportJson = $measurement | ConvertTo-Json -Depth 6
      [IO.File]::WriteAllText(
        (Join-Path $measurementDir "windows-build-space.json"),
        $reportJson,
        [Text.UTF8Encoding]::new($false)
      )
      if ($null -ne $measuredPeakGiB) {
        Write-Host ("Measured peak disk consumption in this build: {0} GiB; next run adds 25% headroom, with a {1} GiB minimum." -f $measuredPeakGiB, $spaceReport.configuredMinimumGiB)
      } else {
        Write-Warning "No disk-space samples were recorded. The next build will use the configured minimum."
      }
    } catch {
      Write-Warning "Could not save the Windows build-space measurement. The next build will use the configured minimum."
    }
  }
  Write-Host "Installer: $root\generated-artifacts\windows"
  Write-Host "Install it, close ArenaForge, then run this script with -Action Check -Executable 'full path to ArenaForge.exe'."
  exit 0
}
if (-not $Executable -or -not (Test-Path $Executable)) {
  throw "Supply -Executable with the full path to the installed ArenaForge.exe. Close existing Arena windows before checking."
}
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Write-Host "Detected RAM: $ramGb GB. Local inference has no API fees, but speed depends on your CPU/GPU and free memory."
if (-not $Model) {
  if ($ramGb -ge 12) { $Model = "qwen2.5:3b" }
  elseif ($ramGb -ge 8) { $Model = "qwen2.5:1.5b" }
  else { throw "Less than 8 GB RAM detected. Send your laptop's RAM/CPU/GPU details before choosing a local model; reliable browser automation is not assured." }
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "Install Ollama first (winget install Ollama.Ollama), open it, then rerun this check. No account or API key is needed."
}
try {
  $tags = Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
} catch {
  throw "Ollama is not answering locally. Open the Ollama application and rerun this check."
}
if ($tags.models.name -notcontains $Model) {
  Write-Host "The check needs $Model. This is a one-time model download (roughly 1-2 GB)."
  $answer = Read-Host "Download this model to your laptop now? Type yes to continue"
  if ($answer -ne "yes") { throw "Model download not approved. No browser task was run." }
  & ollama pull $Model
  if ($LASTEXITCODE -ne 0) { throw "Model download failed." }
}
Write-Host "The check opens example.com and its IANA information link only."
Write-Host "It automatically approves that one benign click in an isolated test workspace."
Write-Host "It does NOT approve account logins, forms, purchases, or real workspace actions."
& node "$PSScriptRoot\acceptance.mjs" (Resolve-Path $Executable).Path $Model
if ($LASTEXITCODE -ne 0) { throw "The real Windows/model check failed. Send generated-artifacts\windows-check\result.json, not your profile or database." }
Write-Host "Real Windows check passed. Send generated-artifacts\windows-check\result.json to confirm the result."
