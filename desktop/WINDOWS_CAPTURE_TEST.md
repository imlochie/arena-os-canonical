# Windows audio-capture check

The installer smoke test only proves that the packaged capture host starts. This separate acceptance check verifies that WASAPI loopback actually receives audible PCM from the Windows default playback endpoint.

Run it on a Windows PC with sound enabled, close other audio apps, and use a local build or installed host:

```powershell
node desktop/windows-capture-acceptance.mjs "C:\path\to\resources\native\waveyard-capture-host.exe"
```

If the Windows package was built in this checkout, the host defaults to `desktop\stage\native\waveyard-capture-host.exe`, so the argument can be omitted. The check creates a short 440 Hz test tone in the OS temporary directory, plays it through Windows, captures the default output, checks the captured signal, prints a JSON report, and deletes its temporary files. It does not use Apple Music or bypass protected output.

This confirms the native system-loopback path only. Verify the complete product flow separately in the packaged app: start a recording, capture the test tone, stop and add it to the Waveyard library, play the imported track, and confirm an interrupted partial recording appears under **Preserved recordings** after restarting the app.

## Interactive endpoint-loss and recovery check

This opt-in check exercises a real selected-endpoint loss while the packaged
ArenaForge workbench is also recording. Run it from an interactive Windows
terminal with the packaged app open and a default playback endpoint you can
safely disable or unplug:

```powershell
node desktop/windows-capture-acceptance.mjs --device-loss "C:\path\to\resources\native\waveyard-capture-host.exe"
```

Omit the host argument to use
`desktop\stage\native\waveyard-capture-host.exe`. The check explicitly starts
native capture with the current default endpoint ID, verifies that the generated
440 Hz tone is present before the test, and does not change capture sources if
Windows changes the default route. Follow its prompts to start a whole-output
recording on that same endpoint in ArenaForge, then disable or unplug the
endpoint yourself. It confirms that the selected endpoint disappears from the
active-device list before waiting for the native failure. Restore it when
prompted. Do not use an endpoint needed by other users or critical audio; the
check does not disable or restore devices automatically.

The check passes only when Windows reports a native capture failure, a
tone-bearing RF64 recovery file is saved, and the tester confirms that
ArenaForge showed its failure message, exposed the recording under
**Preserved recordings**, imported it, and played the imported track after the
endpoint was restored. The JSON report is written to
`generated-artifacts/windows-capture-device-loss/result.json`; a diagnostic
copy of the native test's captured PCM is stored under
`generated-artifacts/windows-capture-device-loss/recovery/`. If the run cannot
confirm a usable file or the in-app recovery flow, it reports `status: "failed"`
and records the reason instead of counting that run as a pass. These generated
files are local test evidence, not library items; the app recording must be
recovered through the workbench.

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

## Output and power lifecycle acceptance

The workflow's `lifecycle-resilience` job is separate from the ordinary
process-isolation job. It runs only when `exercise_lifecycle` is selected and
requires `confirm_disposable_runner`. Its runner must use the dedicated
`arena-audio-isolated` label; never attach that label to a developer's
workstation. The runner account must be able to change the Windows default
output route, disable and re-enable its test audio endpoint, create a one-shot
SYSTEM wake task, and request suspend/resume. If any prerequisite is missing,
the run fails and does not count as evidence.

The lifecycle check needs at least two active render endpoints. It records the
original default endpoint for all three Windows roles, routes them to an
alternate endpoint, disables the original endpoint in Device Manager, restores
the endpoint and all original routes, then requests real Windows suspend and
waits for the scheduled wake. Cleanup attempts restore the endpoint and every
saved route even when an assertion fails. The test uses active generated 440 Hz
and 997 Hz tone processes throughout. Before and after each change it checks
both tones in whole-output loopback, then confirms selected-process capture
retains 440 Hz and excludes 997 Hz. Captures spanning each change also verify
the process capture remains audible on both sides; silence or an exited host is
a failure, not a healthy recording.

If a lifecycle capture fails after receiving PCM, the acceptance harness writes
the captured samples as a valid recoverable RF64 `.wav` file under
`generated-artifacts/windows-process-capture/recovery/`, includes its path and
next steps in the report, and uploads it with the workflow result. The API
manager separately marks a native capture failure as failed, preserves the
partial RF64 for **Preserved recordings**, and tells the user to check the
playback device and Windows audio service.

The JSON report records Windows edition, version/build, installed Windows SDK
versions, MSVC toolset version, individual positive controls, isolation
measurements, and lifecycle action results. A base-only run is marked
`partial` with lifecycle `not-run`; it is not a lifecycle pass. Only a report
with overall `status: "passed"` and lifecycle `status: "passed"` is evidence
that these changes were exercised. A missing report or absent audio/power
infrastructure is not a pass.

No Windows lifecycle run has been performed in this development workspace:
the available environment is Linux and has no Windows audio endpoints or
Windows SDK. Therefore no actual Windows OS/SDK versions or lifecycle results
are claimed here. The test remains unverified until the opt-in workflow
produces and retains a passing report from the isolated runner.

Whole-output mode preserves the endpoint mix format. The virtual process
device uses explicitly requested 48 kHz, stereo, 32-bit float PCM; Windows
may convert the source. Neither route establishes source-bit-perfect
capture or compatibility with protected output. A no-signal warning cannot
identify DRM as the cause.

The ordinary package CI compiles the same host and validates its capability
contract, but cannot prove audio isolation without a real render endpoint.
Adding these workflows is not evidence that a Windows run has passed.
