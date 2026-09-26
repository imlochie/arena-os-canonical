FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
# CPU image is the portable default. Use a separately maintained CUDA image when NVIDIA runtime is available.
# The local NumPy DSP analysis engine pins its only analysis dependency for reproducible output.
RUN pip3 install --no-cache-dir --break-system-packages --index-url https://pypi.org/simple "numpy==1.26.4" "typing-extensions==4.15.0" "flit_core>=3.11,<4" && pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple torch && pip3 install --no-cache-dir --break-system-packages demucs
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/audio/package.json packages/audio/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci
COPY . .
CMD ["npm", "run", "start", "--workspace=@waveyard/worker"]
