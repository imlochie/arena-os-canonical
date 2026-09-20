FROM node:22-bookworm-slim AS base
WORKDIR /app
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
RUN npm run build --workspace=@waveyard/web
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=@waveyard/web"]
