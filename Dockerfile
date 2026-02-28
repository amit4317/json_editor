FROM node:22-bookworm-slim AS build

WORKDIR /app

ARG APP_BASE_PATH=/json/
ENV APP_BASE_PATH=${APP_BASE_PATH}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ARG APP_BASE_PATH=/json/
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_BASE_PATH=${APP_BASE_PATH}

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["node", "server.mjs"]
