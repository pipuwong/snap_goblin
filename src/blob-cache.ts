import { BlobNotFoundError, get, head, put } from "@vercel/blob";
import type { ScrapeCache, SnapshotCache } from "./cache.js";
import type { ScrapedPageResult } from "./types.js";

type BlobClient = { get: typeof get; head: typeof head; put: typeof put };
const defaultClient: BlobClient = { get, head, put };
const imagePath = (key: string) => `snapshots/${key}.bin`;
const scrapePath = (key: string) => `scrapes/${key}.json`;

export class BlobSnapshotCache implements SnapshotCache {
  constructor(private readonly blob: BlobClient = defaultClient) {}

  async getMeta(key: string) {
    try {
      const result = await this.blob.head(imagePath(key));
      return { contentType: result.contentType, capturedAt: result.uploadedAt.getTime() };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async getImage(key: string) {
    const result = await this.blob.get(imagePath(key), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { meta: { contentType: result.blob.contentType, etag: result.blob.etag }, buffer };
  }

  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now = Date.now()) {
    return now - meta.capturedAt < ttlSeconds * 1000;
  }

  async save(options: Parameters<SnapshotCache["save"]>[0]) {
    await this.blob.put(imagePath(options.key), options.buffer, {
      access: "private",
      allowOverwrite: true,
      contentType: options.contentType
    });
    return { key: options.key, contentType: options.contentType, capturedAt: options.capturedAt };
  }
}

export class BlobScrapeCache implements ScrapeCache {
  constructor(private readonly blob: BlobClient = defaultClient) {}

  async get(key: string): Promise<{ meta: { capturedAt: number }; payload: ScrapedPageResult } | null> {
    const result = await this.blob.get(scrapePath(key), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const payload = JSON.parse(await new Response(result.stream).text()) as ScrapedPageResult;
    return { meta: { capturedAt: result.blob.uploadedAt.getTime() }, payload };
  }

  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now = Date.now()) {
    return now - meta.capturedAt < ttlSeconds * 1000;
  }

  async save(options: Parameters<ScrapeCache["save"]>[0]) {
    await this.blob.put(scrapePath(options.key), JSON.stringify(options.payload), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json"
    });
    return { capturedAt: options.capturedAt };
  }
}
