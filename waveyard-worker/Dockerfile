# Waveyard worker image — the real processing engine.
# Ported from the original Waveyard docker/worker.Dockerfile; the build
# context is ./waveyard-worker (its own npm workspace with its own lockfile).
#
# CPU image is the portable default (same choice the original made). Use a
# separately maintained CUDA image when an NVIDIA runtime is available.
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# NumPy is the DSP analysis engine's pinned dependency; PyTorch comes from
# the CPU wheel index; Demucs pulls the rest.
RUN pip3 install --no-cache-dir --break-system-packages \
      --index-url https://pypi.org/simple \
      "numpy==1.26.4" "typing-extensions==4.15.0" "flit_core>=3.11,<4" \
 && pip3 install --no-cache-dir --break-system-packages \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      torch \
 && pip3 install --no-cache-dir --break-system-packages \
      --index-url https://pypi.org/simple \
      demucs

COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/audio/package.json packages/audio/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/types/package.json packages/types/package.json
RUN npm ci --no-audit --no-fund

COPY . .

CMD ["npm", "run", "worker"]
