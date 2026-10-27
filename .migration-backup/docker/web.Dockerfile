# Arena OS web image — the Next.js app (all rooms, including /waveyard).
# ffmpeg/ffprobe is included because the upload path probes real audio
# metadata server-side; without it the app falls back to the browser's
# Web Audio probe (recorded as probeSource "client-webaudio").
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
