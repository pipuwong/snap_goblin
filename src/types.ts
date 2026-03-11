export type ImageFormat = "png" | "jpeg";
export type NavigationWaitUntil = "domcontentloaded" | "load" | "networkidle";
export type ScrapeExportFormat = "default" | "serper";

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
  exportFormat?: ScrapeExportFormat;
  query?: string;
  engine?: string;
}

export interface ScrapeLink {
  href: string;
  text: string;
  rel: string | null;
  target: string | null;
  title: string | null;
}

export interface ScrapedPageMeta {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  siteName: string | null;
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
  exportFormat: ScrapeExportFormat;
}

export interface DefaultScrapeResponse {
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

export interface SerperSearchParameters {
  q: string;
  type: string;
  engine: string;
}

export interface SerperKnowledgeGraph {
  title?: string;
  imageUrl?: string;
  description?: string;
  descriptionSource?: string;
  descriptionLink?: string;
  attributes?: Record<string, string>;
}

export interface SerperSitelink {
  title: string;
  link: string;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  sitelinks?: SerperSitelink[];
  position: number;
}

export interface SerperPeopleAlsoAskItem {
  question: string;
  snippet: string;
  title?: string;
  link?: string;
}

export interface SerperRelatedSearchItem {
  query: string;
}

export interface SerperScrapeResponse {
  searchParameters: SerperSearchParameters;
  knowledgeGraph?: SerperKnowledgeGraph;
  organic: SerperOrganicResult[];
  peopleAlsoAsk?: SerperPeopleAlsoAskItem[];
  relatedSearches?: SerperRelatedSearchItem[];
  credits: number;
}

export type ScrapeResponse = DefaultScrapeResponse | SerperScrapeResponse;
