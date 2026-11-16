# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ARG TARGETARCH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip make gcc pkg-config libgnutls28-dev curl xz-utils ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY protocol ./protocol
COPY scripts ./scripts
COPY staging/dashboard ./dashboard-input
RUN npm run build && npm prune --omit=dev && \
    case "$TARGETARCH" in amd64) target=linux-x64;; arm64) target=linux-arm64;; *) exit 1;; esac && \
    bash scripts/packaging-ffmpeg-build.sh "$target" && \
    node scripts/packaging-inputs.mjs "$target" dashboard-input /tmp/inputs.json && \
    node scripts/packaging-stage.mjs /tmp/inputs.json

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgnutls30 && rm -rf /var/lib/apt/lists/*
ENV STREAMSNIPE_MODE=docker NODE_ENV=production PORT=47821 HOST=0.0.0.0 DASHBOARD_PATH=/opt/streamsnipe/dashboard DATA_DIR=/data RECORDINGS_PATH=/media
WORKDIR /opt/streamsnipe
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
# Build context must contain hash-verified, architecture-matched staged assets.
COPY --from=build --chown=node:node /app/staging/dashboard ./dashboard
COPY --from=build --chown=node:node /app/staging/tools ./tools
COPY --from=build --chown=node:node /app/staging/licenses ./licenses
COPY --from=build --chown=node:node /app/staging/integrity.json ./integrity.json
ENV JS_RUNTIME_PATH=/opt/streamsnipe/tools/deno YT_DLP_PATH=/opt/streamsnipe/tools/yt-dlp FFMPEG_PATH=/opt/streamsnipe/tools/ffmpeg FFPROBE_PATH=/opt/streamsnipe/tools/ffprobe
RUN mkdir -p /data /media && chown node:node /data /media
USER node
VOLUME ["/data", "/media"]
EXPOSE 47821
CMD ["node", "dist/server.js"]
