#!/usr/bin/env python3
"""Arena's real Demucs adapter.

The worker invokes this process. It never synthesizes or relabels output: success
means Demucs generated all four expected source files and each is non-empty.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

EXPECTED_STEMS = ("vocals", "drums", "bass", "other")


def resolve_device(requested: str) -> str:
    try:
        import torch
    except ImportError as error:
        raise RuntimeError("PyTorch is not installed; cannot run Demucs.") from error
    has_cuda = bool(torch.cuda.is_available())
    if requested == "cuda":
        if not has_cuda:
            raise RuntimeError("CUDA was requested but torch.cuda.is_available() is false.")
        return "cuda"
    if requested == "cpu":
        return "cpu"
    return "cuda" if has_cuda else "cpu"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    args = parser.parse_args()

    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    if not source.is_file():
        raise RuntimeError("Input source does not exist.")
    output.mkdir(parents=True, exist_ok=True)

    resolved_device = resolve_device(args.device)
    try:
        import demucs
        model_version = getattr(demucs, "__version__", "unknown")
    except ImportError:
        model_version = "unknown"

    raw_output = output / "demucs-raw"
    command = [
        sys.executable, "-m", "demucs", "--name", args.model, "--device", resolved_device,
        "--out", str(raw_output), str(source),
    ]
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        raise RuntimeError(f"Demucs exited {completed.returncode}: {(completed.stderr or completed.stdout)[-3000:]}")

    candidates = {path.name: path for path in raw_output.rglob("*.wav")}
    missing = [name for name in EXPECTED_STEMS if f"{name}.wav" not in candidates]
    if missing:
        raise RuntimeError(f"Demucs completed without expected stems: {', '.join(missing)}")

    produced = []
    for stem in EXPECTED_STEMS:
        origin = candidates[f"{stem}.wav"]
        destination = output / f"{stem}.wav"
        shutil.copy2(origin, destination)
        if destination.stat().st_size <= 0:
            raise RuntimeError(f"Demucs produced an empty {stem} stem.")
        produced.append({"stemType": stem, "path": str(destination), "bytes": destination.stat().st_size})

    print(json.dumps({
        "engine": "demucs", "model": args.model, "modelVersion": model_version,
        "requestedDevice": args.device, "resolvedDevice": resolved_device, "stems": produced,
    }))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
