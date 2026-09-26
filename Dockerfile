# ---- Build del frontend (necesita las dependencias de desarrollo: Vite)
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Imagen final: solo dependencias de producción
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY prompts ./prompts
COPY schema ./schema
COPY data/seed ./data/seed
COPY config.json ./

# La base de datos vive en /data: monta un volumen para no perderla.
ENV VOCAB_DB=/data/vocab.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
