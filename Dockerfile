# MyDay v2 — one image: the API serves the built web app.
# Every RUN is sequential (the droplet is small): install, then shared, api, web.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY api api
COPY web web
RUN npm run build -w shared
RUN npm run build -w api
RUN npm run build -w web
RUN npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/package.json api/
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/api/migrations api/migrations
COPY --from=build /app/web/dist web/dist
USER node
WORKDIR /app/api
EXPOSE 4000
# Migrations run on every start (= every deploy), then the server.
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
