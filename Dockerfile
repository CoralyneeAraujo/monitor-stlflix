# Dockerfile — Node 20 + build do better-sqlite3
FROM node:20-alpine

# deps nativas pro better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# copiar os manifests primeiro p/ cache
COPY package*.json ./

# força build nativo; usa npm ci se houver lock, senão npm install
ENV npm_config_build_from_source=true
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# copia o restante do código
COPY . .

ENV NODE_ENV=production
# Railway injeta PORT em runtime; seu server.js já usa process.env.PORT || 3000
ENV PORT=3000

# (opcional) se você montou volume p/ o banco:
# ENV DB_PATH=/data/schema.db

EXPOSE 3000
CMD ["node", "server.js"]
