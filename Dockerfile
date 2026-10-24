ARG NODE_VERSION=24.22.1
ARG PNPM_VERSION=10.2.0
ARG TS_VERSION=5.3.3

# Builder stage
FROM node:${NODE_VERSION} as build

ARG PNPM_VERSION
ARG TS_VERSION

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g typescript@${TS_VERSION}
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@${PNPM_VERSION}
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
    --mount=type=bind,source=patches,target=patches \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set ignore-scripts "eztv-crawler,yts-api-node" && \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build
RUN pnpm prune --prod

# Runner stage
FROM node:${NODE_VERSION}-slim as final

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    htop \
    && curl -fsSL https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | bash \
    && apt-get update && apt-get install -y --no-install-recommends speedtest \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist

ENV NODE_ENV=production
ENV HTTPS_METHOD=local-ip.medicmobile.org
ENV DOWNLOAD_DIR=/data
ENV KEEP_DOWNLOADED_FILES=false
ENV MAX_CONNS_PER_TORRENT=50
ENV DOWNLOAD_SPEED_LIMIT=60971520
ENV UPLOAD_SPEED_LIMIT=60971520
ENV SEED_TIME=172800000
ENV TORRENT_TIMEOUT=5000
ENV SENTRY_DSN=""
ENV SENTRY_ENVIRONMENT=production
ENV SENTRY_TRACES_SAMPLE_RATE=0.1
ENV SENTRY_PROFILE_SESSION_SAMPLE_RATE=0
ENV SENTRY_ENABLE_LOGS=false
ENV SENTRY_SEND_DEFAULT_PII=false

VOLUME /data

RUN mkdir -p /data
RUN chown -R node /data

USER node

EXPOSE 58827
EXPOSE 58828

CMD npm start
