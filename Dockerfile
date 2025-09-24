# Node 20 + build nativo do better-sqlite3
FROM node:20-alpine

# deps nativas p/ compilar better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# copie só o package.json para aproveitar cache
COPY package.json ./

# força build-from-source e instala sem dev
ENV npm_config_build_from_source=true
RUN npm install --omit=dev

# copie o resto do código
COPY . .

# garante rebuild do better-sqlite3 se necessário
RUN npm rebuild better-sqlite3 --build-from-source || true

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
