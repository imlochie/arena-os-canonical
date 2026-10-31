# Windows audio-capture check

The installer smoke test only proves that the packaged capture host starts. This separate acceptance check verifies that WASAPI loopback actually receives audible PCM from the Windows default playback endpoint.

Run it on a Windows PC with sound enabled, close other audio apps, and use a local build or installed host:

```powershell
node desktop/windows-capture-acceptance.mjs "C:\path\to\resources\native\waveyard-capture-host.exe"
```

If the Windows package was built in this checkout, the host defaults to `desktop\stage\native\waveyard-capture-host.exe`, so the argument can be omitted. The check creates a short 440 Hz test tone in the OS temporary directory, plays it through Windows, captures the default output, checks the captured signal, prints a JSON report, and deletes its temporary files. It does not use Apple Music or bypass protected output.

This confirms the native system-loopback path only. Verify the complete product flow separately in the packaged app: start a recording, capture the test tone, stop and add it to the Waveyard library, play the imported track, and confirm an interrupted partial recording appears under **Preserved recordings** after restarting the app.

## Application isolation

The host builds with the Windows SDK containing `audioclientactivationparams.h`
(20348 or later). Runtime application capture requires Windows build 20348+.
Older systems retain whole-output recording; there is no implicit fallback.
Application mode uses `ActivateAudioInterfaceAsync` with
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, not a virtual driver.
See [Microsoft's API/sample requirements](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

The **Windows native audio isolation** workflow is dispatched on an
interactive self-hosted Windows x64 runner labelled `arena-audio`, with an
active default playback endpoint. Do not attach this label to a headless
runner. It compiles the current host and runs:

```powershell
node desktop/windows-process-capture-acceptance.mjs "C:\path\to\waveyard-capture-host.exe"
```

The check plays authorized generated 440 Hz and 997 Hz tones in independent
processes. First, whole-output capture must detect both tones (positive
control). Then, selected-application capture must retain 440 Hz and exclude
997 Hz by at least 29.5 dB. It also checks discovery, rejection of a stale
creation-time identity, clean source-exit finalization and refusal to
follow an exited process. Silence, missing devices, unsupported Windows
versions and absent tones fail rather than count as isolation.
The machine-readable result is written under
`generated-artifacts/windows-process-capture/result.json`; scratch tones
are removed. No Apple Music or DRM-protected playback is used.

Whole-output mode preserves the endpoint mix format. The virtual process
device uses explicitly requested 48 kHz, stereo, 32-bit float PCM; Windows
may convert the source. Neither route establishes source-bit-perfect
capture or compatibility with protected output. A no-signal warning cannot
identify DRM as the cause.

The ordinary package CI compiles the same host and validates its capability
contract, but cannot prove audio isolation without a real render endpoint.
Adding these workflows is not evidence that a Windows run has passed.
