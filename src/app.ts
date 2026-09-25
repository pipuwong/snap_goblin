import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ScrapeCache, SnapshotCache } from "./cache.js";
import type { RuntimeConfig } from "./config.js";
import { captureWebsite, scrapeWebsite } from "./capture.js";
import type {
  CaptureRequestPayload,
  CaptureResponse,
  CapturedImageResult,
  ImageFormat,
  NavigationWaitUntil,
  ScrapeExportFormat,
  SerperKnowledgeGraph,
  SerperOrganicResult,
  SerperPeopleAlsoAskItem,
  SerperRelatedSearchItem,
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
  parseViewportDimension,
  resolveTargetAddress,
  type ResolvedTargetAddress
} from "./url-policy.js";

const VALID_FORMATS = new Set<ImageFormat>(["png", "jpeg"]);
const VALID_EXPORT_FORMATS = new Set<ScrapeExportFormat>(["default", "serper"]);
const DEFAULT_FORMAT: ImageFormat = "png";
const DEFAULT_QUALITY = 80;
const DEFAULT_WAIT_UNTIL: NavigationWaitUntil = "networkidle";
const DEFAULT_EXPORT_FORMAT: ScrapeExportFormat = "default";
const MAX_EXTRA_WAIT_MS = 30_000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

type RequestRateLimitScope = "auth" | "unauth";

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

function parseExportFormat(value: unknown): ScrapeExportFormat {
  if (typeof value === "string" && VALID_EXPORT_FORMATS.has(value as ScrapeExportFormat)) {
    return value as ScrapeExportFormat;
  }

  return DEFAULT_EXPORT_FORMAT;
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
  resolveAddress: (url: string) => Promise<ResolvedTargetAddress>;
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
  resolveAddress: (url: string) => Promise<ResolvedTargetAddress>;
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
  cache: SnapshotCache;
  scrapeCache: ScrapeCache;
  captureFn?: CaptureFn;
  scrapeFn?: ScrapeFn;
}

function buildImageUrl(config: RuntimeConfig, pathName: string): string {
  if (!config.publicBaseUrl) {
    return pathName;
  }

  return new URL(pathName, `${config.publicBaseUrl}/`).toString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimSnippet(value: string | null | undefined, maxLength = 240): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function getHostname(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function buildPageSnippet(result: ScrapedPageResult): string | undefined {
  return (
    trimSnippet(result.page?.ogDescription) ??
    trimSnippet(result.page?.description) ??
    trimSnippet(result.content?.text)
  );
}

function buildKnowledgeGraph(
  result: ScrapedPageResult,
  sourceUrl: string
): SerperKnowledgeGraph | undefined {
  const title = result.page?.ogTitle ?? result.page?.title ?? getHostname(sourceUrl) ?? undefined;
  const description = buildPageSnippet(result);
  const descriptionLink = result.page?.canonicalUrl ?? result.page?.finalUrl ?? sourceUrl;

  const attributes = Object.fromEntries(
    Object.entries({
      URL: result.page?.finalUrl ?? sourceUrl,
      "Canonical URL": result.page?.canonicalUrl ?? undefined,
      Website: result.page?.siteName ?? undefined,
      Language: result.page?.lang ?? undefined
    }).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );

  if (!title && !description && !result.page?.ogImage && Object.keys(attributes).length === 0) {
    return undefined;
  }

  return {
    ...(title ? { title } : {}),
    ...(result.page?.ogImage ? { imageUrl: result.page.ogImage } : {}),
    ...(description ? { description } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(description ? { descriptionSource: result.page?.siteName ?? "Website" } : {}),
    ...(description ? { descriptionLink } : {})
  };
}

function buildOrganicResults(
  result: ScrapedPageResult,
  sourceUrl: string
): SerperOrganicResult[] {
  const finalUrl = result.page?.finalUrl ?? sourceUrl;
  const pageHost = getHostname(finalUrl);
  const usedLinks = new Set<string>();
  const sitelinks =
    result.links
      ?.filter((link) => link.href !== finalUrl)
      .filter((link) => link.text || link.title)
      .filter((link) => getHostname(link.href) === pageHost)
      .filter((link) => {
        if (usedLinks.has(link.href)) {
          return false;
        }

        usedLinks.add(link.href);
        return true;
      })
      .slice(0, 5)
      .map((link) => ({
        title: link.text || link.title || getHostname(link.href) || link.href,
        link: link.href
      })) ?? [];

  const organic: SerperOrganicResult[] = [];
  const primaryTitle = result.page?.title ?? result.page?.ogTitle ?? getHostname(finalUrl) ?? finalUrl;
  organic.push({
    title: primaryTitle,
    link: finalUrl,
    ...(buildPageSnippet(result) ? { snippet: buildPageSnippet(result) } : {}),
    ...(sitelinks.length > 0 ? { sitelinks } : {}),
    position: 1
  });

  const seen = new Set<string>([finalUrl, ...sitelinks.map((link) => link.link)]);
  for (const link of result.links ?? []) {
    if (seen.has(link.href)) {
      continue;
    }

    const title = link.text || link.title || getHostname(link.href) || link.href;
    if (!title) {
      continue;
    }

    seen.add(link.href);
    organic.push({
      title,
      link: link.href,
      ...(trimSnippet(link.title) ? { snippet: trimSnippet(link.title) } : {}),
      position: organic.length + 1
    });

    if (organic.length >= 10) {
      break;
    }
  }

  return organic;
}

function buildPeopleAlsoAsk(
  result: ScrapedPageResult,
  sourceUrl: string
): SerperPeopleAlsoAskItem[] {
  const title = result.page?.title ?? result.page?.ogTitle ?? undefined;
  const link = result.page?.finalUrl ?? sourceUrl;
  const lines = (result.content?.text ?? "")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const items: SerperPeopleAlsoAskItem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const question = lines[index];
    if (!/\?$/.test(question) || question.length < 8 || question.length > 180) {
      continue;
    }

    const answer = lines.slice(index + 1).find((value) => !/\?$/.test(value) && value.length > 20);
    const normalizedQuestion = normalizeWhitespace(question).toLowerCase();
    if (!answer || seen.has(normalizedQuestion)) {
      continue;
    }

    seen.add(normalizedQuestion);
    items.push({
      question: normalizeWhitespace(question),
      snippet: trimSnippet(answer, 220) ?? normalizeWhitespace(answer),
      ...(title ? { title } : {}),
      ...(link ? { link } : {})
    });

    if (items.length >= 8) {
      break;
    }
  }

  return items;
}

function buildRelatedSearches(
  result: ScrapedPageResult
): SerperRelatedSearchItem[] {
  const pageTitle = normalizeWhitespace(result.page?.title ?? result.page?.ogTitle ?? "").toLowerCase();
  const candidates = [
    ...(result.content?.headings ?? []),
    ...((result.links ?? []).map((link) => link.text || link.title || "").filter(Boolean) as string[])
  ];
  const seen = new Set<string>();
  const queries: SerperRelatedSearchItem[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    const key = normalized.toLowerCase();
    if (
      normalized.length < 3 ||
      normalized.length > 80 ||
      key === pageTitle ||
      /\?$/.test(normalized) ||
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    queries.push({ query: normalized });

    if (queries.length >= 8) {
      break;
    }
  }

  return queries;
}

function toCaptureResponse(options: {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAtMs: number;
  ttlSeconds: number;
  mimeType: string;
  config: RuntimeConfig;
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
    imageUrl: buildImageUrl(options.config, imagePath)
  };
}

function toScrapeResponse(options: {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAtMs: number;
  ttlSeconds: number;
  requestOptions: ScrapeRequestOptions;
  query: string | null;
  engine: string;
  result: ScrapedPageResult;
  config: RuntimeConfig;
}): ScrapeResponse {
  if (options.requestOptions.exportFormat === "serper") {
    const knowledgeGraph = buildKnowledgeGraph(options.result, options.sourceUrl);
    const organic = buildOrganicResults(options.result, options.sourceUrl);
    const peopleAlsoAsk = buildPeopleAlsoAsk(options.result, options.sourceUrl);
    const relatedSearches = buildRelatedSearches(options.result);

    return {
      searchParameters: {
        q:
          options.query ??
          options.result.page?.title ??
          options.result.page?.ogTitle ??
          options.sourceUrl,
        type: "webpage",
        engine: options.engine
      },
      ...(knowledgeGraph ? { knowledgeGraph } : {}),
      organic,
      ...(peopleAlsoAsk.length > 0 ? { peopleAlsoAsk } : {}),
      ...(relatedSearches.length > 0 ? { relatedSearches } : {}),
      credits: 1
    };
  }

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
          imageUrl: buildImageUrl(options.config, options.result.screenshot.imagePath)
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

function getApiKeyCandidate(request: Request): string | null {
  const candidate = request.header("x-api-key");
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : null;
}

function isAuthorized(request: Request, apiKey: string): boolean {
  const candidate = getApiKeyCandidate(request);
  if (!candidate) {
    return false;
  }

  const expected = Buffer.from(apiKey, "utf8");
  const received = Buffer.from(candidate, "utf8");
  if (expected.byteLength !== received.byteLength) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

function setSecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
}

function createRateLimiter(config: RuntimeConfig) {
  const entries = new Map<string, RateLimitEntry>();

  return (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    const scope: RequestRateLimitScope = isAuthorized(request, config.apiKey) ? "auth" : "unauth";
    const clientId = request.ip || request.socket.remoteAddress || "unknown";
    const mapKey = `${scope}:${clientId}`;
    const maxRequests =
      scope === "auth" ? config.authRateLimitMax : config.unauthRateLimitMax;
    const current = entries.get(mapKey);

    if (!current || current.resetAt <= now) {
      entries.set(mapKey, {
        count: 1,
        resetAt: now + config.rateLimitWindowMs
      });
      next();
      return;
    }

    if (current.count >= maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.resetAt - now) / 1000)
      );
      response.setHeader("Retry-After", retryAfterSeconds.toString());
      response.status(429).json({
        error: "Too many requests. Please try again later."
      });
      return;
    }

    current.count += 1;
    entries.set(mapKey, current);
    next();
  };
}

async function validateSourceUrl(value: string, config: RuntimeConfig): Promise<string> {
  const normalized = normalizeTargetUrl(value.trim());
  await assertTargetUrlAllowed(normalized, config);
  return normalized;
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
  const fullPage = parseBoolean(body?.fetchFullPage, false) || body?.fullPage === true;

  return {
    width,
    height,
    fullPage,
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
  query: string | null;
  engine: string;
} {
  const captureInput = parseCaptureInput(body, config);
  const exportFormat = parseExportFormat(body?.exportFormat);
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
    includeLinks: parseBoolean(body?.includeLinks, exportFormat === "serper"),
    includeHtml: parseBoolean(body?.includeHtml, false),
    includeScreenshot: parseBoolean(body?.includeScreenshot, false),
    maxTextLength: parseBoundedInt(body?.maxTextLength, config.maxTextLength, config.maxTextLength),
    maxHtmlLength: parseBoundedInt(body?.maxHtmlLength, config.maxHtmlLength, config.maxHtmlLength),
    maxLinks: parseBoundedInt(body?.maxLinks, config.maxLinks, config.maxLinks),
    exportFormat
  };

  return {
    options,
    ttlSeconds: parseTtl(body?.ttlOverrideSeconds, config.scrapeCacheTtlSeconds),
    query: parseOptionalString(body?.query),
    engine: parseOptionalString(body?.engine) ?? "playwright"
  };
}

async function captureAndCache(options: {
  sourceUrl: string;
  captureInput: ReturnType<typeof parseCaptureInput>;
  config: RuntimeConfig;
  cache: SnapshotCache;
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
    resolveAddress: (url) => resolveTargetAddress(url, options.config)
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

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(setSecurityHeaders);
  app.use(createRateLimiter(options.config));

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
          config: options.config
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
          config: options.config
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
          config: options.config
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
            query: parsed.query,
            engine: parsed.engine,
            result: existing.payload,
            config: options.config
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
        resolveAddress: (url) => resolveTargetAddress(url, options.config)
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
          query: parsed.query,
          engine: parsed.engine,
          result: scrapeResult,
          config: options.config
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
