import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ImageFormat,
  ScrapeCacheMeta,
  ScrapedPageResult,
  SnapshotMeta
} from "./types.js";

interface CacheIndex {
  version: 1;
  entries: Record<string, SnapshotMeta>;
}

interface JsonCacheIndex {
  version: 1;
  entries: Record<string, ScrapeCacheMeta>;
}

export interface SnapshotCache {
  getMeta(key: string): Promise<Pick<SnapshotMeta, "contentType" | "capturedAt"> | null>;
  getImage(key: string): Promise<{ meta: Pick<SnapshotMeta, "contentType" | "etag">; buffer: Buffer } | null>;
  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now?: number): boolean;
  save(options: { key: string; sourceUrl: string; format: ImageFormat; contentType: string; buffer: Buffer; capturedAt: number }): Promise<Pick<SnapshotMeta, "key" | "contentType" | "capturedAt">>;
}

export interface ScrapeCache {
  get(key: string): Promise<{ meta: Pick<ScrapeCacheMeta, "capturedAt">; payload: ScrapedPageResult } | null>;
  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now?: number): boolean;
  save(options: { key: string; sourceUrl: string; payload: ScrapedPageResult; capturedAt: number }): Promise<Pick<ScrapeCacheMeta, "capturedAt">>;
}

export class DiskSnapshotCache {
  private readonly indexPath: string;
  private readonly entries = new Map<string, SnapshotMeta>();

  constructor(private readonly cacheDir: string) {
    this.indexPath = path.join(this.cacheDir, "index.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });

    try {
      const content = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(content) as CacheIndex;
      if (parsed.version !== 1 || !parsed.entries) {
        return;
      }

      for (const [key, value] of Object.entries(parsed.entries)) {
        this.entries.set(key, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async getMeta(key: string): Promise<SnapshotMeta | null> {
    const meta = this.entries.get(key);
    if (!meta) {
      return null;
    }

    const filePath = path.join(this.cacheDir, meta.fileName);
    try {
      await fs.access(filePath);
      return meta;
    } catch {
      this.entries.delete(key);
      await this.persistIndex();
      return null;
    }
  }

  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now = Date.now()): boolean {
    return now - meta.capturedAt < ttlSeconds * 1000;
  }

  async getImage(key: string): Promise<{ meta: SnapshotMeta; buffer: Buffer } | null> {
    const meta = await this.getMeta(key);
    if (!meta) {
      return null;
    }

    const filePath = path.join(this.cacheDir, meta.fileName);
    const buffer = await fs.readFile(filePath);

    return { meta, buffer };
  }

  async save(options: {
    key: string;
    sourceUrl: string;
    format: ImageFormat;
    contentType: string;
    buffer: Buffer;
    capturedAt: number;
  }): Promise<SnapshotMeta> {
    const fileName = `${options.key}.${options.format}`;
    const filePath = path.join(this.cacheDir, fileName);
    await fs.writeFile(filePath, options.buffer);

    const meta: SnapshotMeta = {
      key: options.key,
      sourceUrl: options.sourceUrl,
      fileName,
      format: options.format,
      contentType: options.contentType,
      sizeBytes: options.buffer.byteLength,
      capturedAt: options.capturedAt,
      etag: this.createEtag(options.buffer)
    };

    this.entries.set(options.key, meta);
    await this.persistIndex();
    return meta;
  }

  private async persistIndex(): Promise<void> {
    const payload: CacheIndex = {
      version: 1,
      entries: Object.fromEntries(this.entries)
    };

    await fs.writeFile(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private createEtag(buffer: Buffer): string {
    return crypto.createHash("sha1").update(buffer).digest("hex");
  }
}

export class DiskScrapeCache {
  private readonly indexPath: string;
  private readonly entries = new Map<string, ScrapeCacheMeta>();

  constructor(private readonly cacheDir: string) {
    this.indexPath = path.join(this.cacheDir, "index.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });

    try {
      const content = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(content) as JsonCacheIndex;
      if (parsed.version !== 1 || !parsed.entries) {
        return;
      }

      for (const [key, value] of Object.entries(parsed.entries)) {
        this.entries.set(key, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async get(
    key: string
  ): Promise<{ meta: ScrapeCacheMeta; payload: ScrapedPageResult } | null> {
    const meta = await this.getMeta(key);
    if (!meta) {
      return null;
    }

    const filePath = path.join(this.cacheDir, meta.fileName);
    const content = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(content) as ScrapedPageResult;

    return { meta, payload };
  }

  async getMeta(key: string): Promise<ScrapeCacheMeta | null> {
    const meta = this.entries.get(key);
    if (!meta) {
      return null;
    }

    const filePath = path.join(this.cacheDir, meta.fileName);
    try {
      await fs.access(filePath);
      return meta;
    } catch {
      this.entries.delete(key);
      await this.persistIndex();
      return null;
    }
  }

  isFresh(meta: { capturedAt: number }, ttlSeconds: number, now = Date.now()): boolean {
    return now - meta.capturedAt < ttlSeconds * 1000;
  }

  async save(options: {
    key: string;
    sourceUrl: string;
    payload: ScrapedPageResult;
    capturedAt: number;
  }): Promise<ScrapeCacheMeta> {
    const fileName = `${options.key}.json`;
    const filePath = path.join(this.cacheDir, fileName);
    const serialized = JSON.stringify(options.payload, null, 2);
    await fs.writeFile(filePath, serialized, "utf8");

    const meta: ScrapeCacheMeta = {
      key: options.key,
      sourceUrl: options.sourceUrl,
      fileName,
      contentType: "application/json",
      sizeBytes: Buffer.byteLength(serialized),
      capturedAt: options.capturedAt,
      etag: this.createEtag(serialized)
    };

    this.entries.set(options.key, meta);
    await this.persistIndex();
    return meta;
  }

  private async persistIndex(): Promise<void> {
    const payload: JsonCacheIndex = {
      version: 1,
      entries: Object.fromEntries(this.entries)
    };

    await fs.writeFile(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private createEtag(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex");
  }
}
