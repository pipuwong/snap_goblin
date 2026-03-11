FROM mcr.microsoft.com/playwright:v1.58.2-noble AS base

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=4000
ENV CACHE_DIR=/app/cache
ENV SCRAPE_CACHE_DIR=/app/cache/scrape

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/cache /app/cache/scrape && chown -R pwuser:pwuser /app

COPY --from=build /app/dist ./dist

USER pwuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4000') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "dist/src/server.js"]
