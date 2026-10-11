#!/usr/bin/env python3
"""
WanGP bridge — expose WanGP's official Python API (shared/api.py) as JSON/HTTP
so Arena OS Studio (or any app) can drive it.

WanGP by DeepBeepMeep: https://github.com/deepbeepmeep/Wan2GP
This bridge is a thin, dependency-free wrapper (Python stdlib only) around
WanGP's own API; it adds no generation logic of its own.

Usage (inside your WanGP python environment, from the WanGP folder):

    python /path/to/bridges/wangp_bridge.py --root . --port 7862

Options:
    --root PATH       WanGP installation folder (default: $WANGP_ROOT or cwd)
    --host HOST       bind address (default 127.0.0.1 — keep it local)
    --port PORT       port (default 7862)
    --profile N       WanGP profile flag passed through (e.g. 4)
    --attention X     attention backend passed through (e.g. sdpa / sage)
    --mock            run with a fake session (no WanGP / no GPU) for testing
    --output-dir PATH optional output override passed to WanGP init

Endpoints:
    GET  /health
    GET  /models?main_output=video|image|audio&query=...
    GET  /model/{model_type}          → defaults + schema + availability
    POST /generate {"settings": {...}}  → {"job_id": "..."}
    GET  /jobs/{id}                   → status/progress/files
    POST /jobs/{id}/cancel
    GET  /files/{job_id}/{name}       → media bytes (supports Range)

Settings are WanGP settings: the easiest way to get a known-good set is to
configure the WanGP web UI, click "Export Settings", and reuse that JSON
(docs/API.md in the WanGP repo).
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import sys
import threading
import time
import queue as queue_mod
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

BRIDGE_VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# WanGP session loading
# ---------------------------------------------------------------------------


def load_wangp_session(root: Path, cli_args, output_dir=None):
    """Import WanGP's shared.api and call init(...). Returns the session."""
    root_str = str(root.resolve())
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    try:
        from shared.api import init  # type: ignore
    except Exception as e:  # pragma: no cover - depends on WanGP install
        raise RuntimeError(
            f"Could not import WanGP's shared.api from {root_str} ({e}). "
            "Run this bridge from your WanGP python environment with --root pointing "
            "at your WanGP installation (see https://github.com/deepbeepmeep/Wan2GP)."
        )
    kwargs = {"root": root, "cli_args": cli_args}
    if output_dir:
        kwargs["output_dir"] = Path(output_dir)
    return init(**kwargs)


# ---------------------------------------------------------------------------
# Mock session (for testing the bridge + app without WanGP / a GPU)
# ---------------------------------------------------------------------------


class _MockResult:
    def __init__(self, files):
        self.success = True
        self.generated_files = files
        self.errors = []
        self.cancelled = False


class _MockEvent:
    def __init__(self, kind, data):
        self.kind = kind
        self.data = data


class _MockProgress:
    def __init__(self, phase, progress, current_step, total_steps):
        self.phase = phase
        self.progress = progress
        self.current_step = current_step
        self.total_steps = total_steps


class _MockStreamLine:
    def __init__(self, text, stream="stdout"):
        self.text = text
        self.stream = stream


class _MockImage:
    """Tiny drawable stand-in with a save() that writes an animated-ish SVG."""

    def __init__(self, size=(320, 180)):
        self.size = size

    def save(self, fp, format=None, **kwargs):
        w, h = self.size
        fp.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">'
            f'<rect width="100%" height="100%" fill="#0b1020"/>'
            f'<circle cx="{w//2}" cy="{h//2}" r="30" fill="#22d3ee">'
            f'<animate attributeName="r" values="20;36;20" dur="2s" repeatCount="indefinite"/>'
            f"</circle></svg>".encode("utf-8")
        )


class _MockEventStream:
    """Paces progress events across the mock job duration, then ends
    (mirroring WanGP: the event stream finishes when the job does)."""

    def __init__(self, job: "_MockJob"):
        self._job = job

    def iter(self, timeout=None):
        start = time.time()
        steps = self._job._steps
        dur = self._job._duration
        yield _MockEvent("status", "Loading model")
        yield _MockEvent("stream", _MockStreamLine("[mock] WanGP bridge mock session"))
        for i in range(1, steps + 1):
            target = start + dur * i / steps
            while time.time() < target:
                if self._job.cancel_requested:
                    return
                time.sleep(min(0.1, max(0.01, target - time.time())))
            if self._job.cancel_requested:
                return
            yield _MockEvent("progress", _MockProgress("generating", 100.0 * i / steps, i, steps))
            if i == max(1, steps // 2):
                yield _MockEvent("preview", type("P", (), {"image": _MockImage()})())
        yield _MockEvent("status", "Saving output")


class _MockJob:
    def __init__(self, files, duration_s=12.0, steps=20):
        self.done = False
        self.cancel_requested = False
        self._files = files
        self._duration = duration_s
        self._steps = steps
        self._start = time.time()
        self.events = _MockEventStream(self)

    def result(self, timeout=None):
        waited = time.time() - self._start
        if waited < self._duration:
            time.sleep(self._duration - waited)
        self.done = True
        result = _MockResult([] if self.cancel_requested else self._files)
        result.cancelled = self.cancel_requested
        return result

    def cancel(self):
        self.cancel_requested = True
        self.done = True


_MOCK_MODELS = [
    {"model_type": "t2v_2_2", "name": "Wan 2.2 Text-to-Video", "family": "wan2_2", "family_label": "Wan 2.2",
     "main_output": ["video"], "outputs": ["video"], "inputs": ["text"], "finetune": False},
    {"model_type": "i2v_2_2", "name": "Wan 2.2 Image-to-Video", "family": "wan2_2", "family_label": "Wan 2.2",
     "main_output": ["video"], "outputs": ["video"], "inputs": ["text", "image"], "finetune": False},
    {"model_type": "ltx2_22B_distilled_1_1", "name": "LTX-2.3 Distilled 1.1 22B", "family": "ltx2",
     "family_label": "LTX-2", "main_output": ["video"], "outputs": ["video", "audio"],
     "inputs": ["text", "image"], "finetune": False},
    {"model_type": "krea2_raw", "name": "Krea 2 RAW", "family": "krea2", "family_label": "Krea 2",
     "main_output": ["image"], "outputs": ["image"], "inputs": ["text"], "finetune": False},
    {"model_type": "qwen3_tts_base", "name": "Qwen3 TTS Base", "family": "qwen3_tts", "family_label": "Qwen3 TTS",
     "main_output": ["audio"], "outputs": ["audio"], "inputs": ["text", "audio"], "finetune": False},
]

_MOCK_DEFAULTS = {
    "video": {"resolution": "832x480", "num_inference_steps": 20, "video_length": "5s", "force_fps": 16},
    "image": {"resolution": "1024x1024", "num_inference_steps": 20},
    "audio": {"duration_seconds": 6},
}


class MockSession:
    """Session-shaped object mirroring the parts of WanGPSession we use."""

    mock = True

    def list_model_metadata(self, **filters):
        out = []
        for m in _MOCK_MODELS:
            want = filters.get("main_output")
            if want:
                if isinstance(want, (list, tuple)):
                    if not any(w in m["main_output"] for w in want):
                        continue
                elif want not in m["main_output"]:
                    continue
            row = dict(m)
            row["available"] = True
            out.append(row)
        return out

    def get_default_settings(self, model_type):
        for m in _MOCK_MODELS:
            if m["model_type"] == model_type:
                base = _MOCK_DEFAULTS.get(m["main_output"][0], {})
                return {"model_type": model_type, "prompt": "", **base}
        raise KeyError(model_type)

    def get_model_schema(self, model_type):
        for m in _MOCK_MODELS:
            if m["model_type"] == model_type:
                return {
                    "model_type": model_type,
                    "name": m["name"],
                    "main_output": m["main_output"],
                    "outputs": m["outputs"],
                    "inputs": m["inputs"],
                }
        return None

    def get_model_availability(self, model_type):
        return {"model_type": model_type, "available": True}

    def submit_task(self, settings, callbacks=None):
        model_type = str(settings.get("model_type", "t2v_2_2"))
        steps = int(settings.get("num_inference_steps", 20) or 20)
        out_dir = Path(os.environ.get("WANGP_MOCK_OUTPUTS", Path.cwd() / "mock_outputs"))
        out_dir.mkdir(parents=True, exist_ok=True)
        main_out = "video"
        for m in _MOCK_MODELS:
            if m["model_type"] == model_type:
                main_out = m["main_output"][0]
        if main_out == "audio":
            fname = f"mock_{uuid.uuid4().hex[:8]}.wav"
            data = self._mock_wav(settings)
        elif main_out == "image":
            fname = f"mock_{uuid.uuid4().hex[:8]}.svg"
            data = self._mock_svg(settings)
        else:
            fname = f"mock_{uuid.uuid4().hex[:8]}.svg"
            data = self._mock_svg(settings, animated=True)
        (out_dir / fname).write_bytes(data)
        return _MockJob([str(out_dir / fname)], duration_s=min(30.0, 4.0 + steps * 0.4), steps=steps)

    @staticmethod
    def _mock_svg(settings, animated=False):
        prompt = str(settings.get("prompt", ""))[:60].replace("&", "&amp;").replace("<", "&lt;")
        anim = (
            '<circle cx="480" cy="270" r="80" fill="#22d3ee"><animate attributeName="r" values="50;110;50" '
            'dur="4s" repeatCount="indefinite"/></circle>' if animated else '<circle cx="480" cy="270" r="80" fill="#22d3ee"/>'
        )
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">'
            '<rect width="100%" height="100%" fill="#0b1020"/>'
            '<rect x="40" y="60" width="200" height="80" rx="16" fill="#6366f1" opacity="0.6"/>'
            + anim +
            f'<text x="40" y="500" font-family="monospace" font-size="20" fill="#e2e8f0">{prompt}</text>'
            '<text x="40" y="525" font-family="monospace" font-size="13" fill="#a5f3fc">WanGP bridge mock output</text>'
            "</svg>"
        ).encode("utf-8")

    @staticmethod
    def _mock_wav(settings):
        import struct
        import math

        dur = float(settings.get("duration_seconds", 4) or 4)
        rate = 22050
        n = int(rate * dur)
        buf = io.BytesIO()
        for i in range(n):
            t = i / rate
            v = 0.5 * math.sin(2 * math.pi * 220 * t) + 0.25 * math.sin(2 * math.pi * 330 * t)
            fade = min(1.0, t / 0.2) * min(1.0, max(0.0, (dur - t) / 0.3))
            buf.write(struct.pack("<h", int(max(-1, min(1, v * fade)) * 32000)))
        data = buf.getvalue()
        hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
            "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16
        ) + b"data" + struct.pack("<I", len(data))
        return hdr + data


# ---------------------------------------------------------------------------
# Job tracking
# ---------------------------------------------------------------------------


def guess_media_type(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    if mt:
        return mt
    ext = Path(path).suffix.lower()
    return {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
    }.get(ext, "application/octet-stream")


class Job:
    def __init__(self, job_id, model_type):
        self.id = job_id
        self.model_type = model_type
        self.status = "queued"  # queued | running | completed | failed | cancelled
        self.phase = ""
        self.progress = 0.0  # 0..1
        self.current_step = 0
        self.total_steps = 0
        self.files = []  # [{name, path, media_type, size}]
        self.errors = []
        self.preview = None  # data URI
        self.handle = None
        self.created = time.time()
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            return {
                "job_id": self.id,
                "model_type": self.model_type,
                "status": self.status,
                "phase": self.phase,
                "progress": round(self.progress, 4),
                "current_step": self.current_step,
                "total_steps": self.total_steps,
                "files": [dict(f) for f in self.files],
                "errors": [dict(e) for e in self.errors],
                "preview": self.preview,
                "created": self.created,
            }


class BridgeState:
    def __init__(self, session_factory):
        self.session_factory = session_factory
        self.session = None
        self.session_error = None
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = queue_mod.Queue()
        self.wangp_version = None
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- session (lazy, retried) ----
    def get_session(self):
        with self.lock:
            if self.session is not None:
                return self.session
            if self.session_error is not None and time.time() - self.session_error[0] < 30:
                raise RuntimeError(self.session_error[1])
            return None

    def _obtain_session(self):
        with self.lock:
            try:
                self.session = self.session_factory()
                self.session_error = None
                ver = getattr(self.session, "version", None) or getattr(self.session, "wangp_version", None)
                if ver:
                    self.wangp_version = str(ver)
            except Exception as e:
                self.session = None
                self.session_error = (time.time(), str(e))

    # ---- worker: one job at a time (single GPU) ----
    def _worker(self):
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if job is None:
                continue
            try:
                self._run_job(job)
            except Exception as e:
                with job.lock:
                    job.status = "failed"
                    job.errors.append({"message": str(e)})
            finally:
                self.queue.task_done()

    def _run_job(self, job):
        if self.get_session() is None:
            self._obtain_session()
        session = self.get_session()
        if session is None:
            with job.lock:
                job.status = "failed"
                job.errors.append({"message": f"WanGP session unavailable: {self.session_error[1]}"})
            return
        with job.lock:
            job.status = "running"
            job.phase = "starting"
        handle = session.submit_task(job.settings)
        with job.lock:
            job.handle = handle
        if handle is None:
            with job.lock:
                job.status = "failed"
                job.errors.append({"message": "submit_task returned None"})
            return

        # consume events until the job reports done
        events = getattr(handle, "events", None)
        if events is not None:
            try:
                for event in events.iter(timeout=0.5):
                    self._apply_event(job, event)
                    if getattr(handle, "done", False) or job.status == "cancelled":
                        break
            except Exception:
                pass  # stream may end abruptly; result() below is authoritative

        result = handle.result()
        with job.lock:
            if getattr(result, "cancelled", False) or getattr(handle, "cancel_requested", False):
                job.status = "cancelled"
            elif getattr(result, "success", False):
                job.status = "completed"
                job.progress = 1.0
                job.phase = "done"
            else:
                job.status = "failed"
            for err in getattr(result, "errors", None) or []:
                msg = getattr(err, "message", None) or str(err)
                job.errors.append({"message": str(msg)})
            for p in getattr(result, "generated_files", None) or []:
                p = str(p)
                try:
                    size = os.path.getsize(p)
                except OSError:
                    size = None
                job.files.append(
                    {"name": os.path.basename(p), "path": p, "media_type": guess_media_type(p), "size": size}
                )
            if not job.phase:
                job.phase = "finished"

    def _apply_event(self, job, event):
        kind = getattr(event, "kind", None)
        data = getattr(event, "data", None)
        if kind == "progress" and data is not None:
            phase = str(getattr(data, "phase", "") or getattr(data, "status", "") or "")
            progress = getattr(data, "progress", None)
            with job.lock:
                if phase:
                    job.phase = phase
                if progress is not None:
                    try:
                        p = float(progress)
                        job.progress = p / 100.0 if p > 1.0 else p
                    except (TypeError, ValueError):
                        pass
                job.current_step = int(getattr(data, "current_step", 0) or 0)
                job.total_steps = int(getattr(data, "total_steps", 0) or 0)
        elif kind == "status" and data is not None:
            s = str(data).strip()
            if s:
                with job.lock:
                    job.phase = s
        elif kind == "preview" and data is not None:
            img = getattr(data, "image", None)
            if img is not None and hasattr(img, "save"):
                try:
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    b = buf.getvalue()
                    if len(b) < 400_000:
                        with job.lock:
                            job.preview = "data:image/png;base64," + base64.b64encode(b).decode("ascii")
                except Exception:
                    pass
        elif kind == "output":
            name = getattr(data, "filename", None) or getattr(data, "path", None)
            if name:
                p = str(name)
                with job.lock:
                    if not any(f["path"] == p for f in job.files):
                        try:
                            size = os.path.getsize(p)
                        except OSError:
                            size = None
                        job.files.append(
                            {"name": os.path.basename(p), "path": p, "media_type": guess_media_type(p), "size": size}
                        )

    # ---- public ops ----
    def submit(self, settings):
        model_type = str(settings.get("model_type", ""))
        job_id = uuid.uuid4().hex[:16]
        job = Job(job_id, model_type)
        job.settings = settings
        with self.lock:
            self.jobs[job_id] = job
        self.queue.put(job_id)
        return job_id

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            return False
        handle = getattr(job, "handle", None)
        if handle is not None and not getattr(handle, "done", False):
            try:
                handle.cancel()
            except Exception:
                pass
        with job.lock:
            if job.status in ("queued", "running"):
                job.status = "cancelled"
                job.phase = "cancelled"
        return True

    def file_entry(self, job_id, name):
        job = self.jobs.get(job_id)
        if job is None:
            return None
        with job.lock:
            for f in job.files:
                if f["name"] == name:
                    return dict(f)
        return None

    def models(self, main_output=None, query=None):
        session = self.get_session()
        if session is None:
            self._obtain_session()
            session = self.get_session()
        if session is None:
            raise RuntimeError(self.session_error[1] if self.session_error else "no session")
        kwargs = {"include_availability": True}
        if main_output:
            kwargs["main_output"] = main_output
        try:
            rows = session.list_model_metadata(**kwargs)
        except TypeError:
            # older WanGP without include_availability
            rows = session.list_model_metadata(**({k: v for k, v in kwargs.items() if k != "include_availability"}))
        out = []
        for r in rows:
            if query and query.lower() not in json.dumps(r).lower():
                continue
            out.append(r)
        return out

    def model_detail(self, model_type):
        session = self.get_session()
        if session is None:
            self._obtain_session()
            session = self.get_session()
        if session is None:
            raise RuntimeError(self.session_error[1] if self.session_error else "no session")
        detail = {
            "model_type": model_type,
            "name": model_type,
            "defaults": None,
            "schema": None,
            "availability": None,
        }
        try:
            d = session.get_default_settings(model_type)
            detail["defaults"] = d
        except Exception:
            pass
        try:
            s = session.get_model_schema(model_type)
            detail["schema"] = s
            if isinstance(s, dict):
                detail["name"] = s.get("name") or detail["name"]
        except Exception:
            pass
        try:
            detail["availability"] = session.get_model_availability(model_type)
        except Exception:
            pass
        return detail


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def make_handler(state: BridgeState, mock: bool):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = f"WanGPBridge/{BRIDGE_VERSION}"

        def log_message(self, fmt, *args):
            sys.stderr.write("[bridge] " + (fmt % args) + "\n")

        # ---- helpers ----
        def _json(self, obj, status=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                return {}

        # ---- routes ----
        def do_GET(self):
            parsed = urlparse(self.path)
            parts = [unquote(p) for p in parsed.path.split("/") if p]
            qs = parse_qs(parsed.query)

            if parts == ["health"]:
                session_ready = state.get_session() is not None
                return self._json(
                    {
                        "ok": True,
                        "backend": "wangp",
                        "mock": mock,
                        "bridge_version": BRIDGE_VERSION,
                        "wangp_version": state.wangp_version,
                        "session_ready": session_ready,
                        "queue": state.queue.qsize(),
                    }
                )

            if parts == ["models"]:
                main_output = qs.get("main_output", [None])[0]
                query = qs.get("query", [None])[0]
                try:
                    models = state.models(main_output=main_output, query=query)
                    return self._json({"models": models})
                except Exception as e:
                    return self._json({"error": f"models: {e}"}, 503)

            if len(parts) == 2 and parts[0] == "model":
                try:
                    return self._json(state.model_detail(parts[1]))
                except Exception as e:
                    return self._json({"error": f"model detail: {e}"}, 503)

            if len(parts) == 2 and parts[0] == "jobs":
                job = state.jobs.get(parts[1])
                if job is None:
                    return self._json({"error": "job not found"}, 404)
                return self._json(job.snapshot())

            if len(parts) == 3 and parts[0] == "files":
                entry = state.file_entry(parts[1], parts[2])
                if entry is None:
                    return self._json({"error": "file not found"}, 404)
                return self._serve_file(entry, self.headers.get("Range"))

            return self._json({"error": "not found"}, 404)

        def do_POST(self):
            parsed = urlparse(self.path)
            parts = [unquote(p) for p in parsed.path.split("/") if p]

            if parts == ["generate"]:
                body = self._read_json()
                settings = body.get("settings") or body
                if not isinstance(settings, dict) or not settings.get("model_type"):
                    return self._json({"error": "settings.model_type is required"}, 400)
                session = state.get_session()
                if session is None and not mock:
                    state._obtain_session()
                job_id = state.submit(settings)
                return self._json({"job_id": job_id})

            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel":
                ok = state.cancel(parts[1])
                return self._json({"cancelled": bool(ok)})

            return self._json({"error": "not found"}, 404)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        # ---- file serving with Range support ----
        def _serve_file(self, entry, range_header):
            path = entry["path"]
            try:
                size = os.path.getsize(path)
            except OSError:
                return self._json({"error": "file missing on disk"}, 410)

            start, end = 0, size - 1
            status = 200
            if range_header:
                try:
                    unit, rng = range_header.split("=", 1)
                    if unit.strip().lower() == "bytes":
                        if "," in rng:
                            rng = rng.split(",", 1)[0]
                        s, _, e = rng.partition("-")
                        start = int(s) if s else 0
                        end = int(e) if e else size - 1
                        start = max(0, min(start, size - 1))
                        end = max(start, min(end, size - 1))
                        status = 206
                except Exception:
                    start, end, status = 0, size - 1, 200

            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", entry.get("media_type") or "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description="WanGP bridge for Arena OS Studio")
    ap.add_argument("--root", default=os.environ.get("WANGP_ROOT", "."), help="WanGP installation folder")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("WANGP_BRIDGE_PORT", "7862")))
    ap.add_argument("--profile", default=None, help="WanGP --profile value (e.g. 4)")
    ap.add_argument("--attention", default=None, help="WanGP --attention value (e.g. sdpa)")
    ap.add_argument("--output-dir", default=None, help="optional output dir override")
    ap.add_argument("--mock", action="store_true", help="fake session for testing (no WanGP needed)")
    args = ap.parse_args()

    cli_args = []
    if args.attention:
        cli_args += ["--attention", args.attention]
    if args.profile:
        cli_args += ["--profile", str(args.profile)]

    if args.mock:
        session_factory = lambda: MockSession()
        print(f"[bridge] MOCK mode — no WanGP will be loaded.")
    else:
        root = Path(args.root).expanduser().resolve()
        print(f"[bridge] WanGP root: {root}")
        session_factory = lambda: load_wangp_session(root, cli_args, output_dir=args.output_dir)

    state = BridgeState(session_factory)
    # obtain the session eagerly so /health reflects real status quickly
    state._obtain_session()

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(state, mock=args.mock))
    print(
        f"[bridge] WanGP bridge v{BRIDGE_VERSION} listening on http://{args.host}:{args.port} "
        f"(powering Arena OS Studio · WanGP by DeepBeepMeep — https://github.com/deepbeepmeep/Wan2GP)"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] shutting down.")


if __name__ == "__main__":
    main()
