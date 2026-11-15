# Running the PostgreSQL route acceptance test without Postgres installed

`artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts`
boots a real PostgreSQL server, applies the canonical desktop migrations, seeds
private audio, and drives the production route handlers — including the real
WAV export worker. When `initdb` / `postgres` / `pg_ctl` are not on `PATH` it
skips itself with `PostgreSQL binaries are unavailable`, which reads like a
deliberate skip but is actually a missing dependency.

This document records how to make it run on a Linux sandbox that has no
Postgres, no ffmpeg and no root. Everything here is downloaded to `/tmp` at
run time; nothing is committed and nothing is installed system-wide.

## What the test needs

| Tool | Why | Where to get it without root |
| --- | --- | --- |
| `initdb`, `postgres`, `pg_ctl` | the test creates and stops its own cluster | `pgserver` wheel on PyPI (`pgserver/pginstall/bin`) |
| `ffmpeg` (recent) | the export worker's `amerge`/`pan` graph | `imageio-ffmpeg` wheel on PyPI |
| `ffprobe` | `validateAudio` after export | `@ffprobe-installer/linux-x64` from npm |

`ffmpeg` 4.1 from `@ffmpeg-installer` is **too old**: it fails with
`No channel layout for input 1` inside `amerge`, and the export job fails.
Use a 5.x/6.x/9.x build.

## Steps

```bash
# 1. PostgreSQL binaries (self-contained manylinux build, no lib dependency)
python3 -m pip download --no-deps -d /tmp/pgwheel pgserver
python3 - <<'PY'
import glob, zipfile
wheel = sorted(glob.glob('/tmp/pgwheel/pgserver-*.whl'))[-1]
zipfile.ZipFile(wheel).extractall('/tmp/pgserver')
PY
chmod +x /tmp/pgserver/pgserver/pginstall/bin/*

# 2. ffmpeg (new enough for the export worker's filter graph)
curl -sL "$(python3 -c "
import json,urllib.request
d=json.load(urllib.request.urlopen('https://pypi.org/pypi/imageio-ffmpeg/json'))
v=d['info']['version']
print([f['url'] for f in d['releases'][v] if 'manylinux' in f['filename'] and 'x86_64' in f['filename']][0])
")" -o /tmp/iio.whl
python3 -c "import zipfile; zipfile.ZipFile('/tmp/iio.whl').extractall('/tmp/iio')"
FFMPEG=$(find /tmp/iio -name 'ffmpeg-linux-*' -type f | head -1)
chmod +x "$FFMPEG"

# 3. ffprobe
curl -sL "https://registry.npmjs.org/@ffprobe-installer/linux-x64/-/linux-x64-5.2.0.tgz" -o /tmp/ffprobe.tgz
mkdir -p /tmp/ffprobe && tar xzf /tmp/ffprobe.tgz -C /tmp/ffprobe
chmod +x /tmp/ffprobe/package/ffprobe

# 4. run it
export PATH="/tmp/pgserver/pgserver/pginstall/bin:$PATH"
export ARENA_FFMPEG_PATH="$FFMPEG"
export ARENA_FFPROBE_PATH=/tmp/ffprobe/package/ffprobe
./scripts/node_modules/.bin/tsx \
  "artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts"
```

Expected tail:

```
# tests 1
# pass 1
# fail 0
```

## Traps found the hard way

- **Path globbing.** `tsx --test` treats `[id]` as a glob character class and
  silently matches zero files, printing `# tests 0` and exiting 0. Pass the
  path **quoted but unescaped** from the repository root, exactly as written
  above. Escaping the brackets (`\\[id\\]`) also matches nothing.
- **Relative imports.** Copying the test elsewhere to dodge the bracket problem
  breaks its `./route`, `../arena-handoff/route`, `../../../../remixes/...`
  imports and its `new URL("../../../../../../../../", import.meta.url)` root.
  Pin the bracket problem, not the file.
- **`pg` is not importable from `lib/arena`.** Use
  `createRequire(path.join(root, "lib/db/package.json"))` as the file already
  does.
- **`ERR_PNPM_IGNORED_BUILDS` / `ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED`.**
  A fresh checkout may need `corepack pnpm install --frozen-lockfile
  --ignore-scripts`; `onnxruntime-node`'s postinstall fails here and is not
  needed by this test. Run the same in `scripts/` to get `tsx`.
- The suite leaves a temporary cluster under `$TMPDIR`; it removes it on the
  success path and on most failures. If a run is killed, `pg_ctl -D <dir>
  stop` the leftover directory before re-running.
