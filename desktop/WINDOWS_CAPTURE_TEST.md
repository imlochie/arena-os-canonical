# Windows audio-capture check

The installer smoke test only proves that the packaged capture host starts. This separate acceptance check verifies that WASAPI loopback actually receives audible PCM from the Windows default playback endpoint.

Run it on a Windows PC with sound enabled, close other audio apps, and use a local build or installed host:

```powershell
node desktop/windows-capture-acceptance.mjs "C:\path\to\resources\native\waveyard-capture-host.exe"
```

If the Windows package was built in this checkout, the host defaults to `desktop\stage\native\waveyard-capture-host.exe`, so the argument can be omitted. The check creates a short 440 Hz test tone in the OS temporary directory, plays it through Windows, captures the default output, checks the captured signal, prints a JSON report, and deletes its temporary files. It does not use Apple Music or bypass protected output.

This confirms the native system-loopback path only. Verify the complete product flow separately in the packaged app: start a recording, capture the test tone, stop and add it to the Waveyard library, play the imported track, and confirm an interrupted partial recording appears under **Preserved recordings** after restarting the app.
