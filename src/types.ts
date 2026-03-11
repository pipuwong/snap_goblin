export type ImageFormat = "png" | "jpeg";
export type NavigationWaitUntil = "domcontentloaded" | "load" | "networkidle";

export interface CaptureRequestPayload {
  url: string;
  ttlOverrideSeconds?: number;
  width?: number;
  height?: number;
  fullPage?: boolean;
  format?: ImageFormat;
  quality?: number;
}

export interface SnapshotMeta {
  key: string;
  sourceUrl: string;
  fileName: string;
  format: ImageFormat;
  contentType: string;
  sizeBytes: number;
  capturedAt: number;
  etag: string;
}

export interface CapturedImageResult {
  buffer: Buffer;
  format: ImageFormat;
  contentType: string;
}

export interface CaptureResponse {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  mimeType: string;
  imagePath: string;
  imageUrl: string;
}

export interface ScrapeRequestPayload extends CaptureRequestPayload {
  waitUntil?: NavigationWaitUntil;
  waitForSelector?: string;
  extraWaitMs?: number;
  includeContent?: boolean;
  includeMetadata?: boolean;
  includeLinks?: boolean;
  includeHtml?: boolean;
  includeScreenshot?: boolean;
  maxTextLength?: number;
  maxHtmlLength?: number;
  maxLinks?: number;
}

export interface ScrapeLink {
  href: string;
  text: string;
  rel: string | null;
  target: string | null;
}

export interface ScrapedPageMeta {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  canonicalUrl: string | null;
  lang: string | null;
}

export interface ScrapedContent {
  text: string | null;
  textLength: number;
  headings: string[];
  html: string | null;
  htmlLength: number;
}

export interface ScrapeScreenshotRef {
  key: string;
  mimeType: string;
  imagePath: string;
}

export interface ScrapeTimings {
  navigationMs: number;
  extractionMs: number;
  totalMs: number;
}

export interface ScrapedPageResult {
  page: ScrapedPageMeta | null;
  content: ScrapedContent | null;
  links: ScrapeLink[] | null;
  screenshot: ScrapeScreenshotRef | null;
  timings: ScrapeTimings;
}

export interface ScrapeCacheMeta {
  key: string;
  sourceUrl: string;
  fileName: string;
  contentType: "application/json";
  sizeBytes: number;
  capturedAt: number;
  etag: string;
}

export interface ScrapeRequestOptions {
  width: number;
  height: number;
  fullPage: boolean;
  format: ImageFormat;
  quality: number;
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
}

export interface ScrapeResponse {
  key: string;
  sourceUrl: string;
  cached: boolean;
  capturedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  request: ScrapeRequestOptions;
  page: ScrapedPageMeta | null;
  content: ScrapedContent | null;
  links: ScrapeLink[] | null;
  screenshot: (ScrapeScreenshotRef & { imageUrl: string }) | null;
  timings: ScrapeTimings | null;
}
