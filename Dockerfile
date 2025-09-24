# Dockerfile — Node + build do better-sqlite3
FROM node:20-alpine

# deps de build para better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# apenas package files para cache
COPY package*.json ./

# força build-from-source durante o npm ci
ENV npm_config_build_from_source=true
RUN npm ci --omit=dev

# copia o restante do projeto
COPY . .

ENV NODE_ENV=production
# Não fixe a porta — Railway injeta PORT em runtime
ENV PORT=3000

# (Opcional) se você usa DB persistente via Volume:
# ENV DB_PATH=/data/schema.db

EXPOSE 3000

CMD ["node", "server.js"]
