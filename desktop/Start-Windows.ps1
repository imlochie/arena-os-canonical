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
  Write-Host "This downloads build dependencies, Electron, PostgreSQL and Chromium."
  Write-Host "It does not upload your workspace data, install an AI model, or change an existing Arena database."
  $spaceLocations = @("workspace=$root")
  if ($env:TEMP) { $spaceLocations += "temporary files=$env:TEMP" }
  if ($env:LOCALAPPDATA) { $spaceLocations += "user caches=$env:LOCALAPPDATA" }
  $spaceOutput = & node (Join-Path $PSScriptRoot "build-space-preflight.mjs") `
    @spaceLocations
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect build disk space. No dependency installation has started." }
  $spaceReport = $spaceOutput | ConvertFrom-Json
  foreach ($location in $spaceReport.locations) {
    if ($null -eq $location.availableGiB) {
      Write-Warning "Free space could not be checked for $($location.label): $($location.inspectionError)"
    } else {
      Write-Host ("{0}: {1} GiB free at {2}" -f $location.label, $location.availableGiB, $location.path)
    }
  }
  $lowSpace = @($spaceReport.locations | Where-Object { $_.belowWarningThreshold })
  if ($lowSpace.Count -gt 0) {
    Write-Warning "A build location has less than 20 GiB free or could not be inspected. This is an early warning threshold, not a measured minimum; the Windows build's peak disk use has not yet been measured."
    $answer = Read-Host "To continue anyway, type CONTINUE. Press Enter to stop before dependency installation"
    if ($answer -cne "CONTINUE") {
      throw "Build stopped before dependency installation; no existing app data or generated build files were changed."
    }
  }
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
