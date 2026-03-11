import express, { type Request } from "express";
import { DiskScrapeCache, DiskSnapshotCache } from "./cache.js";
import type { RuntimeConfig } from "./config.js";
import { captureWebsite, scrapeWebsite } from "./capture.js";
import type {
  CaptureRequestPayload,
  CaptureResponse,
  CapturedImageResult,
  ImageFormat,
  NavigationWaitUntil,
  ScrapeRequestOptions,
  ScrapeRequestPayload,
  ScrapeResponse,
  ScrapeScreenshotRef,
  ScrapedPageResult
} from "./types.js";
import {
  assertTargetUrlAllowed,
  createScrapeKey,
  createSnapshotKey,
  normalizeTargetUrl,
  parseWaitUntil,
  parseViewportDimension
} from "./url-policy.js";

const VALID_FORMATS = new Set<ImageFormat>(["png", "jpeg"]);
const DEFAULT_FORMAT: ImageFormat = "png";
const DEFAULT_QUALITY = 80;
const DEFAULT_WAIT_UNTIL: NavigationWaitUntil = "networkidle";
const MAX_EXTRA_WAIT_MS = 30_000;

function parseFormat(value: unknown): ImageFormat {
  if (typeof value === "string" && VALID_FORMATS.has(value as ImageFormat)) {
    return value as ImageFormat;
  }

  return DEFAULT_FORMAT;
}

function parseQuality(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_QUALITY;
  }

  return Math.min(100, Math.max(0, Math.floor(value)));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBoundedInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return fallback;
  }

  return Math.min(rounded, max);
}

function parseExtraWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return 0;
  }

  return Math.min(rounded, MAX_EXTRA_WAIT_MS);
}

type CaptureFn = (options: {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  format: ImageFormat;
  quality: number;
  navigationTimeoutMs: number;
  waitUntil?: NavigationWaitUntil;
  waitForSelector?: string | null;
  extraWaitMs?: number;
  validateUrl?: (url: string) => Promise<void>;
}) => Promise<CapturedImageResult>;

type ScrapeFn = (options: {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  format: ImageFormat;
  quality: number;
  navigationTimeoutMs: number;
  waitUntil: NavigationWaitUntil;
  waitForSelector: string | null;
  extraWaitMs: number;
  includeContent: boolean;
  includeMetadata: boolean;
  includeLinks: boolean;
  includeHtml: boolean;
  includeScreenshot: boolean;
  maxTextLength: number;
  maxHtmlLength: number;
  maxLinks: number;
  validateUrl?: (url: string) => Promise<void>;
}) => Promise<{
  page: ScrapedPageResult["page"];
  content: ScrapedPageResult["content"];
  links: ScrapedPageResult["links"];
  screenshotBuffer: Buffer | null;
  screenshotContentType: string | null;
  timings: ScrapedPageResult["timings"];
}>;

export interface CreateAppOptions {
  config: RuntimeConfig;
  cache: DiskSnapshotCache;
  scrapeCache: DiskScrapeCache;
  captureFn?: CaptureFn;
  scrapeFn?: ScrapeFn;
}

function buildAbsoluteImageUrl(request: Request, pathName: string): string {
  const proto = request.header("x-forwarded-proto") ?? request.protocol;
  const host = request.header("x-forwarded-host") ?? request.get("host");
  if (!host) {
    return pathName;
  }

  return `${proto}://${host}${pathName}`;
}

function toCaptureResponse(options: {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAtMs: number;
  ttlSeconds: number;
  mimeType: string;
  request: Request;
}): CaptureResponse {
  const imagePath = `/image/${options.key}`;
  const expiresAtMs = options.capturedAtMs + options.ttlSeconds * 1000;

  return {
    key: options.key,
    sourceUrl: options.sourceUrl,
    cached: options.cached,
    capturedAt: new Date(options.capturedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlSeconds: options.ttlSeconds,
    mimeType: options.mimeType,
    imagePath,
    imageUrl: buildAbsoluteImageUrl(options.request, imagePath)
  };
}

function toScrapeResponse(options: {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAtMs: number;
  ttlSeconds: number;
  requestOptions: ScrapeRequestOptions;
  result: ScrapedPageResult;
  request: Request;
}): ScrapeResponse {
  const expiresAtMs = options.capturedAtMs + options.ttlSeconds * 1000;

  return {
    key: options.key,
    sourceUrl: options.sourceUrl,
    cached: options.cached,
    capturedAt: new Date(options.capturedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlSeconds: options.ttlSeconds,
    request: options.requestOptions,
    page: options.result.page,
    content: options.result.content,
    links: options.result.links,
    screenshot: options.result.screenshot
      ? {
          ...options.result.screenshot,
          imageUrl: buildAbsoluteImageUrl(options.request, options.result.screenshot.imagePath)
        }
      : null,
    timings: options.result.timings
  };
}

function parseTtl(overrideTtl: unknown, fallback: number): number {
  if (typeof overrideTtl !== "number" || !Number.isFinite(overrideTtl)) {
    return fallback;
  }

  const rounded = Math.floor(overrideTtl);
  return rounded > 0 ? rounded : fallback;
}

function isAuthorized(request: Request, apiKey: string): boolean {
  const candidate = request.header("x-api-key");
  return Boolean(candidate) && candidate === apiKey;
}

async function validateSourceUrl(value: string, config: RuntimeConfig): Promise<string> {
  const normalized = normalizeTargetUrl(value.trim());
  await assertTargetUrlAllowed(normalized, config);
  return normalized;
}

async function validateLoadedUrl(url: string, config: RuntimeConfig): Promise<void> {
  await assertTargetUrlAllowed(normalizeTargetUrl(url), config);
}

function parseCaptureInput(
  body: Partial<CaptureRequestPayload> | undefined,
  config: RuntimeConfig
): {
  width: number;
  height: number;
  fullPage: boolean;
  format: ImageFormat;
  quality: number;
  ttlSeconds: number;
  waitUntil: NavigationWaitUntil;
  waitForSelector: string | null;
  extraWaitMs: number;
} {
  const width = parseViewportDimension(
    body?.width,
    config.maxViewportWidth,
    config.maxViewportWidth
  );
  const height = parseViewportDimension(
    body?.height,
    config.maxViewportHeight,
    config.maxViewportHeight
  );

  return {
    width,
    height,
    fullPage: body?.fullPage === true,
    format: parseFormat(body?.format),
    quality: parseQuality(body?.quality),
    ttlSeconds: parseTtl(body?.ttlOverrideSeconds, config.cacheTtlSeconds),
    waitUntil: parseWaitUntil((body as Partial<ScrapeRequestPayload> | undefined)?.waitUntil),
    waitForSelector: parseOptionalString(
      (body as Partial<ScrapeRequestPayload> | undefined)?.waitForSelector
    ),
    extraWaitMs: parseExtraWaitMs(
      (body as Partial<ScrapeRequestPayload> | undefined)?.extraWaitMs
    )
  };
}

function parseScrapeInput(
  body: Partial<ScrapeRequestPayload> | undefined,
  config: RuntimeConfig
): {
  options: ScrapeRequestOptions;
  ttlSeconds: number;
} {
  const captureInput = parseCaptureInput(body, config);
  const options: ScrapeRequestOptions = {
    width: captureInput.width,
    height: captureInput.height,
    fullPage: captureInput.fullPage,
    format: captureInput.format,
    quality: captureInput.quality,
    waitUntil: body?.waitUntil ? parseWaitUntil(body.waitUntil) : DEFAULT_WAIT_UNTIL,
    waitForSelector: parseOptionalString(body?.waitForSelector),
    extraWaitMs: parseExtraWaitMs(body?.extraWaitMs),
    includeContent: parseBoolean(body?.includeContent, true),
    includeMetadata: parseBoolean(body?.includeMetadata, true),
    includeLinks: parseBoolean(body?.includeLinks, false),
    includeHtml: parseBoolean(body?.includeHtml, false),
    includeScreenshot: parseBoolean(body?.includeScreenshot, false),
    maxTextLength: parseBoundedInt(body?.maxTextLength, config.maxTextLength, config.maxTextLength),
    maxHtmlLength: parseBoundedInt(body?.maxHtmlLength, config.maxHtmlLength, config.maxHtmlLength),
    maxLinks: parseBoundedInt(body?.maxLinks, config.maxLinks, config.maxLinks)
  };

  return {
    options,
    ttlSeconds: parseTtl(body?.ttlOverrideSeconds, config.scrapeCacheTtlSeconds)
  };
}

async function captureAndCache(options: {
  sourceUrl: string;
  captureInput: ReturnType<typeof parseCaptureInput>;
  config: RuntimeConfig;
  cache: DiskSnapshotCache;
  captureFn: CaptureFn;
}): Promise<{ key: string; capturedAtMs: number; mimeType: string }> {
  const key = createSnapshotKey({
    url: options.sourceUrl,
    width: options.captureInput.width,
    height: options.captureInput.height,
    fullPage: options.captureInput.fullPage,
    format: options.captureInput.format,
    quality: options.captureInput.quality
  });
  const capturedAtMs = Date.now();
  const captured = await options.captureFn({
    url: options.sourceUrl,
    width: options.captureInput.width,
    height: options.captureInput.height,
    fullPage: options.captureInput.fullPage,
    format: options.captureInput.format,
    quality: options.captureInput.quality,
    navigationTimeoutMs: options.config.navigationTimeoutMs,
    waitUntil: options.captureInput.waitUntil,
    waitForSelector: options.captureInput.waitForSelector,
    extraWaitMs: options.captureInput.extraWaitMs,
    validateUrl: async (loadedUrl) => validateLoadedUrl(loadedUrl, options.config)
  });

  const saved = await options.cache.save({
    key,
    sourceUrl: options.sourceUrl,
    format: captured.format,
    contentType: captured.contentType,
    buffer: captured.buffer,
    capturedAt: capturedAtMs
  });

  return {
    key,
    capturedAtMs: saved.capturedAt,
    mimeType: saved.contentType
  };
}

export function createApp(options: CreateAppOptions) {
  const captureFn = options.captureFn ?? captureWebsite;
  const scrapeFn = options.scrapeFn ?? scrapeWebsite;
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.use((request, response, next) => {
    if (isAuthorized(request, options.config.apiKey)) {
      next();
      return;
    }

    response.status(401).json({
      error: "Unauthorized. Provide a valid x-api-key header."
    });
  });

  app.post("/capture", async (request, response) => {
    try {
      const body = request.body as Partial<CaptureRequestPayload> | undefined;
      if (!body || typeof body.url !== "string" || body.url.trim().length === 0) {
        response.status(400).json({ error: "Body must include a valid url string." });
        return;
      }

      const sourceUrl = await validateSourceUrl(body.url, options.config);
      const captureInput = parseCaptureInput(body, options.config);
      const key = createSnapshotKey({
        url: sourceUrl,
        width: captureInput.width,
        height: captureInput.height,
        fullPage: captureInput.fullPage,
        format: captureInput.format,
        quality: captureInput.quality
      });
      const existing = await options.cache.getMeta(key);

      if (existing && options.cache.isFresh(existing, captureInput.ttlSeconds)) {
        response.status(200).json(
          toCaptureResponse({
            key,
            sourceUrl,
            cached: true,
            capturedAtMs: existing.capturedAt,
            ttlSeconds: captureInput.ttlSeconds,
            mimeType: existing.contentType,
            request
          })
        );
        return;
      }

      const saved = await captureAndCache({
        sourceUrl,
        captureInput,
        config: options.config,
        cache: options.cache,
        captureFn
      });

      response.status(200).json(
        toCaptureResponse({
          key: saved.key,
          sourceUrl,
          cached: false,
          capturedAtMs: saved.capturedAtMs,
          ttlSeconds: captureInput.ttlSeconds,
          mimeType: saved.mimeType,
          request
        })
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to capture screenshot."
      });
    }
  });

  app.post("/refresh", async (request, response) => {
    try {
      const body = request.body as Partial<CaptureRequestPayload> | undefined;
      if (!body || typeof body.url !== "string" || body.url.trim().length === 0) {
        response.status(400).json({ error: "Body must include a valid url string." });
        return;
      }

      const sourceUrl = await validateSourceUrl(body.url, options.config);
      const captureInput = parseCaptureInput(body, options.config);
      const saved = await captureAndCache({
        sourceUrl,
        captureInput,
        config: options.config,
        cache: options.cache,
        captureFn
      });

      response.status(200).json(
        toCaptureResponse({
          key: saved.key,
          sourceUrl,
          cached: false,
          capturedAtMs: saved.capturedAtMs,
          ttlSeconds: captureInput.ttlSeconds,
          mimeType: saved.mimeType,
          request
        })
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to refresh screenshot."
      });
    }
  });

  app.post("/scrape", async (request, response) => {
    try {
      const body = request.body as Partial<ScrapeRequestPayload> | undefined;
      if (!body || typeof body.url !== "string" || body.url.trim().length === 0) {
        response.status(400).json({ error: "Body must include a valid url string." });
        return;
      }

      const sourceUrl = await validateSourceUrl(body.url, options.config);
      const parsed = parseScrapeInput(body, options.config);
      const scrapeKey = createScrapeKey({
        url: sourceUrl,
        request: parsed.options
      });

      if (
        !parsed.options.includeContent &&
        !parsed.options.includeMetadata &&
        !parsed.options.includeLinks &&
        !parsed.options.includeScreenshot
      ) {
        response.status(400).json({
          error: "Request must enable at least one of content, metadata, links, or screenshot."
        });
        return;
      }

      const existing = await options.scrapeCache.get(scrapeKey);
      if (existing && options.scrapeCache.isFresh(existing.meta, parsed.ttlSeconds)) {
        response.status(200).json(
          toScrapeResponse({
            key: scrapeKey,
            sourceUrl,
            cached: true,
            capturedAtMs: existing.meta.capturedAt,
            ttlSeconds: parsed.ttlSeconds,
            requestOptions: parsed.options,
            result: existing.payload,
            request
          })
        );
        return;
      }

      const scrapedAtMs = Date.now();
      const scraped = await scrapeFn({
        url: sourceUrl,
        width: parsed.options.width,
        height: parsed.options.height,
        fullPage: parsed.options.fullPage,
        format: parsed.options.format,
        quality: parsed.options.quality,
        navigationTimeoutMs: options.config.navigationTimeoutMs,
        waitUntil: parsed.options.waitUntil,
        waitForSelector: parsed.options.waitForSelector,
        extraWaitMs: parsed.options.extraWaitMs,
        includeContent: parsed.options.includeContent,
        includeMetadata: parsed.options.includeMetadata,
        includeLinks: parsed.options.includeLinks,
        includeHtml: parsed.options.includeHtml,
        includeScreenshot: parsed.options.includeScreenshot,
        maxTextLength: parsed.options.maxTextLength,
        maxHtmlLength: parsed.options.maxHtmlLength,
        maxLinks: parsed.options.maxLinks,
        validateUrl: async (loadedUrl) => validateLoadedUrl(loadedUrl, options.config)
      });

      let screenshot: ScrapeScreenshotRef | null = null;
      if (parsed.options.includeScreenshot && scraped.screenshotBuffer && scraped.screenshotContentType) {
        const snapshotKey = createSnapshotKey({
          url: sourceUrl,
          width: parsed.options.width,
          height: parsed.options.height,
          fullPage: parsed.options.fullPage,
          format: parsed.options.format,
          quality: parsed.options.quality
        });

        const savedImage = await options.cache.save({
          key: snapshotKey,
          sourceUrl,
          format: parsed.options.format,
          contentType: scraped.screenshotContentType,
          buffer: scraped.screenshotBuffer,
          capturedAt: scrapedAtMs
        });

        screenshot = {
          key: savedImage.key,
          mimeType: savedImage.contentType,
          imagePath: `/image/${savedImage.key}`
        };
      }

      const scrapeResult: ScrapedPageResult = {
        page: scraped.page,
        content: scraped.content,
        links: scraped.links,
        screenshot,
        timings: scraped.timings
      };

      const saved = await options.scrapeCache.save({
        key: scrapeKey,
        sourceUrl,
        payload: scrapeResult,
        capturedAt: scrapedAtMs
      });

      response.status(200).json(
        toScrapeResponse({
          key: scrapeKey,
          sourceUrl,
          cached: false,
          capturedAtMs: saved.capturedAt,
          ttlSeconds: parsed.ttlSeconds,
          requestOptions: parsed.options,
          result: scrapeResult,
          request
        })
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to scrape website."
      });
    }
  });

  app.get("/image/:key", async (request, response) => {
    const key = request.params.key;
    if (!/^[a-f0-9]{24}$/.test(key)) {
      response.status(400).json({ error: "Invalid key format." });
      return;
    }

    const image = await options.cache.getImage(key);
    if (!image) {
      response.status(404).json({ error: "Screenshot not found." });
      return;
    }

    if (request.header("if-none-match") === image.meta.etag) {
      response.status(304).end();
      return;
    }

    response.setHeader("Content-Type", image.meta.contentType);
    response.setHeader("ETag", image.meta.etag);
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.status(200).send(image.buffer);
  });

  return app;
}
