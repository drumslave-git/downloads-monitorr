# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.mjs ./
COPY src ./src

RUN npm run build && node --check src/server.js

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3020

WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/server.js ./src/server.js
COPY --chown=node:node package.json ./

USER node

EXPOSE 3020

CMD ["node", "src/server.js"]
