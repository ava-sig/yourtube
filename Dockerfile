FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    YOURTUBE_DATA_DIR=/var/lib/yourtube \
    YOURTUBE_MEDIA_DIR=/var/lib/yourtube-media

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && mkdir -p /var/lib/yourtube /var/lib/yourtube-media \
    && chown -R node:node /var/lib/yourtube /var/lib/yourtube-media \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
