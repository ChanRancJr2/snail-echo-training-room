FROM node:24-bookworm-slim AS build
WORKDIR /echo
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:api && npm run build:web

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /echo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /echo/dist ./dist
ENV NODE_ENV=production WEB_ROOT=/echo/dist/web FFMPEG_PATH=/usr/bin/ffmpeg PORT=3000
USER node
EXPOSE 3000
CMD ["npm", "run", "start:api"]
