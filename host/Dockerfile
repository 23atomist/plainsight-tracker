# syntax=docker/dockerfile:1
# One image, three Node services (mcp, agent, dashboard); compose sets the command.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig*.json ./
COPY dashboard ./dashboard
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
# ffmpeg + Intel VAAPI driver. intel-media-va-driver-non-free is in Debian
# non-free, which the slim image does not enable by default. The driver is
# amd64-only in Debian; on other arches (arm64 dev builds) it is skipped so the
# image still builds, and h264_vaapi simply has no device there.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && EXTRA="" && if [ "$(dpkg --print-architecture)" = "amd64" ]; then EXTRA="intel-media-va-driver-non-free"; fi \
 && apt-get install -y --no-install-recommends ffmpeg libva-drm2 vainfo curl $EXTRA \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY dashboard/public ./dashboard/public
ENV NODE_ENV=production TB3_CONFIG=/config/config.json
USER node
