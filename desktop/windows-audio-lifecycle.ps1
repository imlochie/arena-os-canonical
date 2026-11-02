param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("get-defaults", "set-default", "get-endpoint", "disable-endpoint", "enable-endpoint", "suspend-resume")]
  [string]$Operation,

  [string]$EndpointId,
  [string]$EndpointName,
  [string]$InstanceId,
  [ValidateRange(0, 2)]
  [int]$Role = 0
)

$ErrorActionPreference = "Stop"

if ($env:WAVEYARD_ENABLE_DESTRUCTIVE_AUDIO_TESTS -ne "1" -or
    $env:WAVEYARD_AUDIO_RUNNER_ISOLATED -ne "1") {
  throw "Refusing to change Windows audio or power state without both explicit isolated-runner opt-ins."
}

if ($Operation -eq "set-default" -or $Operation -eq "get-defaults") {
  if ($Operation -eq "set-default" -and
      ([string]::IsNullOrWhiteSpace($EndpointId) -or $EndpointId.Length -gt 4096)) {
    throw "A valid playback endpoint ID is required."
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class WaveyardPolicyConfigClient {}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class WaveyardMMDeviceEnumeratorClient {}

[ComImport]
[Guid("f8679f50-850a-41cf-9c72-430f290290c8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface WaveyardIPolicyConfig {
  [PreserveSig] int GetMixFormat();
  [PreserveSig] int GetDeviceFormat();
  [PreserveSig] int ResetDeviceFormat();
  [PreserveSig] int SetDeviceFormat();
  [PreserveSig] int GetProcessingPeriod();
  [PreserveSig] int SetProcessingPeriod();
  [PreserveSig] int GetShareMode();
  [PreserveSig] int SetShareMode();
  [PreserveSig] int GetPropertyValue();
  [PreserveSig] int SetPropertyValue();
  [PreserveSig] int SetDefaultEndpoint(
    [MarshalAs(UnmanagedType.LPWStr)] string endpointId,
    int role
  );
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface WaveyardIMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out WaveyardIMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out WaveyardIMMDevice device);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface WaveyardIMMDevice {
  [PreserveSig] int Activate(ref Guid interfaceId, int context, IntPtr parameters, out IntPtr instance);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
  [PreserveSig] int GetId(out IntPtr id);
  [PreserveSig] int GetState(out int state);
}

public static class WaveyardAudioRoute {
  public static void SetDefault(string endpointId, int role) {
    var policy = (WaveyardIPolicyConfig)new WaveyardPolicyConfigClient();
    int result = policy.SetDefaultEndpoint(endpointId, role);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
  }

  public static string GetDefault(int role) {
    var enumerator = (WaveyardIMMDeviceEnumerator)new WaveyardMMDeviceEnumeratorClient();
    WaveyardIMMDevice device;
    int result = enumerator.GetDefaultAudioEndpoint(0, role, out device);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    IntPtr id;
    result = device.GetId(out id);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    try { return Marshal.PtrToStringUni(id); }
    finally { Marshal.FreeCoTaskMem(id); }
  }
}
"@

  if ($Operation -eq "set-default") {
    [WaveyardAudioRoute]::SetDefault($EndpointId, $Role)
    [ordered]@{ operation = $Operation; endpointId = $EndpointId; role = $Role } |
      ConvertTo-Json -Compress
  } else {
    $defaults = @(foreach ($roleValue in 0..2) {
      [ordered]@{ role = $roleValue; endpointId = [WaveyardAudioRoute]::GetDefault($roleValue) }
    })
    [ordered]@{ operation = $Operation; roleDefaults = $defaults } |
      ConvertTo-Json -Compress -Depth 4
  }
  exit 0
}

if ($Operation -eq "get-endpoint") {
  if ([string]::IsNullOrWhiteSpace($EndpointName)) {
    throw "An endpoint name is required to identify the isolated runner's test device."
  }
  $matches = @(Get-PnpDevice -Class AudioEndpoint -Status OK |
    Where-Object { $_.FriendlyName -ceq $EndpointName })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one active audio endpoint named '$EndpointName'; found $($matches.Count). No device was disabled."
  }
  $device = $matches[0]
  [ordered]@{
    operation = $Operation
    endpointName = $device.FriendlyName
    instanceId = $device.InstanceId
    status = "active"
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Operation -eq "disable-endpoint") {
  if ([string]::IsNullOrWhiteSpace($InstanceId)) {
    throw "The exact previously identified audio endpoint is required."
  }
  $device = Get-PnpDevice -InstanceId $InstanceId -ErrorAction Stop
  if ($device.Class -ne "AudioEndpoint" -or $device.Status -ne "OK") {
    throw "The identified playback endpoint is no longer active; no device was disabled."
  }
  Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $current = Get-PnpDevice -InstanceId $device.InstanceId -ErrorAction SilentlyContinue
  } while ($current -and $current.Status -eq "OK" -and [DateTime]::UtcNow -lt $deadline)
  if ($current -and $current.Status -eq "OK") {
    throw "Windows did not disable the selected playback endpoint."
  }
  [ordered]@{
    operation = $Operation
    endpointName = $device.FriendlyName
    instanceId = $device.InstanceId
    status = "disabled"
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Operation -eq "enable-endpoint") {
  if ([string]::IsNullOrWhiteSpace($InstanceId)) {
    throw "The exact previously disabled endpoint instance is required for restoration."
  }
  $device = Get-PnpDevice -InstanceId $InstanceId -ErrorAction Stop
  if ($device.Status -ne "OK") {
    Enable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $current = Get-PnpDevice -InstanceId $device.InstanceId -ErrorAction SilentlyContinue
    } while ((-not $current -or $current.Status -ne "OK") -and [DateTime]::UtcNow -lt $deadline)
    if (-not $current -or $current.Status -ne "OK") {
      throw "Windows did not restore the disabled playback endpoint."
    }
  } else {
    $current = $device
  }
  [ordered]@{
    operation = $Operation
    endpointName = $current.FriendlyName
    status = "enabled"
  } | ConvertTo-Json -Compress
  exit 0
}

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class WaveyardPower {
  [DllImport("powrprof.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetSuspendState(
    [MarshalAs(UnmanagedType.Bool)] bool hibernate,
    [MarshalAs(UnmanagedType.Bool)] bool forceCritical,
    [MarshalAs(UnmanagedType.Bool)] bool disableWakeEvent
  );
}
"@

$taskName = "WaveyardAudioResume-" + [Guid]::NewGuid().ToString("N")
$eventName = "WaveyardAudioPower-" + [Guid]::NewGuid().ToString("N")
$registeredTask = $false
$registeredEvent = $false
try {
  # Set a one-shot wake before requesting sleep. If the machine cannot arm a
  # wake timer, fail before changing power state.
  $wakeAction = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c exit 0"
  $wakeTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30)
  $wakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  Register-ScheduledTask -TaskName $taskName -Action $wakeAction `
    -Trigger $wakeTrigger -Settings $wakeSettings -User "SYSTEM" `
    -RunLevel Highest | Out-Null
  $registeredTask = $true
  Start-Sleep -Seconds 1
  $wakeTimers = (& powercfg.exe /waketimers 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $wakeTimers -notmatch [Regex]::Escape($taskName)) {
    throw "Windows did not confirm that the one-shot wake task is armed. Suspend was not requested."
  }

  Register-WmiEvent -Query "SELECT * FROM Win32_PowerManagementEvent" `
    -SourceIdentifier $eventName | Out-Null
  $registeredEvent = $true

  $suspendRequestedAt = [DateTime]::UtcNow
  if (-not [WaveyardPower]::SetSuspendState($false, $false, $false)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows refused the suspend request (Win32 error $errorCode)."
  }

  $powerEvents = @()
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline -and
      (-not ($powerEvents -contains 4) -or -not ($powerEvents -contains 7))) {
    $event = Wait-Event -SourceIdentifier $eventName -Timeout 1
    if ($event) {
      $powerEvents += [int]$event.SourceEventArgs.NewEvent.EventType
      Remove-Event -EventIdentifier $event.EventIdentifier
    }
  }
  if (-not ($powerEvents -contains 4) -or -not ($powerEvents -contains 7)) {
    throw "The runner did not report both Windows suspend (4) and resume (7) events."
  }

  [ordered]@{
    operation = $Operation
    suspendRequestedAt = $suspendRequestedAt.ToString("o")
    resumedAt = [DateTime]::UtcNow.ToString("o")
    powerEvents = $powerEvents
    wakeTask = $taskName
  } | ConvertTo-Json -Compress
}
finally {
  if ($registeredEvent) {
    Unregister-Event -SourceIdentifier $eventName -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $eventName -ErrorAction SilentlyContinue |
      Remove-Event -ErrorAction SilentlyContinue
  }
  if ($registeredTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false `
      -ErrorAction SilentlyContinue | Out-Null
  }
}
