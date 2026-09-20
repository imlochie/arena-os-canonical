FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
# This portable image deliberately uses CPU Demucs. CUDA requires a separately
# maintained image and NVIDIA runtime; it is never claimed from this image.
RUN pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch && \
    pip3 install --no-cache-dir --break-system-packages demucs
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "worker"]
