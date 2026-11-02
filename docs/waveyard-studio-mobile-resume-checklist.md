# Waveyard Studio mobile resume check

## Status

Prepared for physical-device testing. The iPhone and Android checks below have
not been run; this workspace cannot reproduce a real iOS or Android lock screen.
Do not treat the browser evidence as device acceptance.

## Existing recovery behavior

- Stem transport checks `visibilitychange`, `pageshow`, and `focus`, then tries
  to resume the audio context and active stem media at the current position.
- Arrangement preview listens for the same return events and reschedules from
  the position reached before the audio context was suspended.
- If automatic recovery is blocked, Studio shows an actionable message:
  `Audio was interrupted. Tap Play stems to resume.` or
  `Audio couldn't resume automatically. Tap Preview arrangement to try again.`
- The Chromium smoke test passed simulated background recovery for stems and
  arrangement preview, including the arrangement playhead and the tap-to-resume
  fallback. The separate real-audio-graph suite passed 10 tests. These checks
  use headless Chromium and synthetic audio, not physical phones.

## Device test procedure

Use the same saved Studio arrangement with audible stems and a visible timeline.
Test in Safari on iPhone and Chrome on Android. For each device:

1. Start **Play stems** and note the timeline playhead.
2. Switch to another app for about 15 seconds, return to Studio, and check that
   the audio either resumes or shows a clear tap-to-resume message.
3. Confirm the playhead continues from its prior position; it must not jump to
   the start or show playback as active while silent.
4. Repeat steps 1–3, but lock the screen for about 15 seconds and then unlock.
5. Start **Preview arrangement** and repeat both the app-switch and
   lock/unlock checks.
6. If audio does not resume automatically, tap the relevant Play or Preview
   button and confirm playback continues from the preserved position.
7. Record whether the browser reloaded or discarded the page, and note any
   browser- or OS-specific behavior.

## Results to record

| Device | OS version | Browser/version | Stems: app switch | Stems: lock/unlock | Arrangement: app switch | Arrangement: lock/unlock | Playhead preserved? | Notes/limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone | Not tested | Safari / not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Physical-device check required |
| Android phone | Not tested | Chrome / not tested | Not tested | Not tested | Not tested | Not tested | Not tested | Physical-device check required |

## Pass criteria

Playback resumes automatically, or Studio clearly asks for a user tap to resume.
The displayed playing state matches audible playback, and the playhead is not
lost. Record any case where the page reloads, audio stays silent, the message is
missing, or the playhead resets.
