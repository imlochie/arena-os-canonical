# WanGP bridge

Exposes [WanGP (Wan2GP) by DeepBeepMeep](https://github.com/deepbeepmeep/Wan2GP) as a
small JSON/HTTP service so Arena OS Studio (or any app) can drive it.

- **Zero dependencies** — Python stdlib only, run it inside your WanGP environment.
- Wraps WanGP's **official API** (`shared/api.py`): `init()` → `submit_task()` →
  progress events → `generated_files`, plus model metadata (`list_model_metadata`,
  `get_default_settings`, `get_model_schema`, availability).
- One job at a time (single GPU), queued; cancellation supported; files served with
  HTTP Range; progress previews forwarded as data URIs.

## Run

```bash
# from your WanGP folder, inside the WanGP python env:
python /path/to/bridges/wangp_bridge.py --root . --port 7862

# options:
#   --root PATH      WanGP install (default $WANGP_ROOT or cwd)
#   --host / --port  bind (default 127.0.0.1:7862 — keep local)
#   --profile N      pass WanGP --profile through (e.g. 4)
#   --attention X    pass WanGP --attention through (e.g. sdpa)
#   --output-dir P   override WanGP output dir
#   --mock           fake session for testing without WanGP/GPU
```

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | bridge + session status |
| GET | `/models?main_output=video\|image\|audio&query=…` | live model metadata (availability included) |
| GET | `/model/{model_type}` | defaults + schema + availability |
| POST | `/generate` `{"settings": {…}}` | submit a WanGP-settings job → `{"job_id"}` |
| GET | `/jobs/{id}` | status / phase / progress / files / preview |
| POST | `/jobs/{id}/cancel` | cancel |
| GET | `/files/{job_id}/{name}` | generated media bytes (Range supported) |

Settings are plain **WanGP settings** — the easiest way to get a known-good set is
the WanGP web UI's **Export Settings** button. `video_length` accepts `"10s"` style
values; WanGP converts to the nearest legal frame count.

See `../STUDIO.md` for the full Studio guide.
