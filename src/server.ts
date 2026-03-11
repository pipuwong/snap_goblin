import http from "node:http";
import { createApp } from "./app.js";
import { DiskScrapeCache, DiskSnapshotCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { closeCaptureBrowser, configureCaptureConcurrency } from "./capture.js";

async function startServer(): Promise<http.Server> {
  const config = loadConfig();
  const cache = new DiskSnapshotCache(config.cacheDir);
  const scrapeCache = new DiskScrapeCache(config.scrapeCacheDir);
  await cache.init();
  await scrapeCache.init();
  configureCaptureConcurrency(config.maxConcurrentPages);

  const app = createApp({ config, cache, scrapeCache });
  const server = app.listen(config.port, () => {
    console.log(`Screenshot and scrape service listening on port ${config.port}`);
  });

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await closeCaptureBrowser();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  return server;
}

void startServer().catch((error) => {
  console.error("Failed to start screenshot service:", error);
  process.exit(1);
});
