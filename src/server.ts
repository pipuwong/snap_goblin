import http from "node:http";
import { createApp } from "./app.js";
import { BlobScrapeCache, BlobSnapshotCache } from "./blob-cache.js";
import { DiskScrapeCache, DiskSnapshotCache, type ScrapeCache, type SnapshotCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { closeCaptureBrowser, configureCaptureConcurrency } from "./capture.js";

async function startServer(): Promise<http.Server> {
  const config = loadConfig();
  const useBlob = process.env.SNAP_GOBLIN_STORAGE === "blob";
  if (useBlob && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for Blob storage.");
  }
  let cache: SnapshotCache;
  let scrapeCache: ScrapeCache;
  if (useBlob) {
    cache = new BlobSnapshotCache();
    scrapeCache = new BlobScrapeCache();
  } else {
    const diskCache = new DiskSnapshotCache(config.cacheDir);
    const diskScrapeCache = new DiskScrapeCache(config.scrapeCacheDir);
    await diskCache.init();
    await diskScrapeCache.init();
    cache = diskCache;
    scrapeCache = diskScrapeCache;
  }
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
