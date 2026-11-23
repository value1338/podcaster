# Podcast-Studio (podcaster) – UI-Build + Node-Server mit ffmpeg, läuft als Nutzer "node".
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Muss zu STUDIO_BASE_PATH passen, z. B. VITE_BASE=/podcast/ bei STUDIO_BASE_PATH=/podcast
ARG VITE_BASE=/
RUN VITE_BASE=$VITE_BASE npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data && chmod 700 /data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production STUDIO_HOST=0.0.0.0 STUDIO_PORT=8850 STUDIO_DATA_DIR=/data
USER node
VOLUME /data
EXPOSE 8850
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.STUDIO_PORT+(process.env.STUDIO_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
