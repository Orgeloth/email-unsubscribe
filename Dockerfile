FROM node:20-alpine

# Upgrade zlib to 1.3.2-r0+ to patch CVE-2026-27171 (CPU exhaustion via crc32_combine64)
RUN apk upgrade --no-cache zlib

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY public ./public
COPY server.js .

EXPOSE 3000

USER node

CMD ["node", "server.js"]
