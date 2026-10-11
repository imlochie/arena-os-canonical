# Contributing to Waveyard

Waveyard is built around a hard rule: no fake audio processing, fake stems, fake job progress, or fake download path. A UI change that makes an unavailable feature look complete is a defect.

## Before opening a change

1. Identify the phase and acceptance test it advances.
2. Keep boundaries intact: UI does not invoke FFmpeg/Demucs, storage goes through `StorageProvider`, and workers own long-running work.
3. Add validation, server-side authorization, migration updates, and tests alongside persistent/API behavior.
4. Do not add copyrighted demo audio. Use the generated original fixture or other clearly licensed assets.
5. Run the checks that your environment supports and name checks not run.

## Pull request checklist

- [ ] No fake data or simulated completion state was added.
- [ ] New audio assets have a real origin and licensing metadata.
- [ ] API permissions are checked server-side.
- [ ] Temporary paths are isolated and cleaned up.
- [ ] Database changes include a migration and test path.
- [ ] Queue retries are idempotent.
- [ ] UI supports keyboard/focus/error states.
- [ ] Docs describe actual behavior rather than planned behavior.
- [ ] Test evidence says `VERIFIED`, `FAILED`, or `NOT VERIFIED` accurately.
