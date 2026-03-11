import path from "node:path";

export interface RuntimeConfig {
  apiKey: string;
  port: number;
  cacheDir: string;
  scrapeCacheDir: string;
  publicBaseUrl: string | null;
  cacheTtlSeconds: number;
  scrapeCacheTtlSeconds: number;
  navigationTimeoutMs: number;
  maxViewportWidth: number;
  maxViewportHeight: number;
  maxTextLength: number;
  maxHtmlLength: number;
  maxLinks: number;
  maxConcurrentPages: number;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  unauthRateLimitMax: number;
  allowPrivateNetworks: boolean;
  urlAllowlist: Set<string>;
  urlDenylist: Set<string>;
}

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_PORT = 4000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_VIEWPORT_WIDTH = 1920;
const DEFAULT_MAX_VIEWPORT_HEIGHT = 1080;
const DEFAULT_MAX_TEXT_LENGTH = 100_000;
const DEFAULT_MAX_HTML_LENGTH = 100_000;
const DEFAULT_MAX_LINKS = 100;
const DEFAULT_MAX_CONCURRENT_PAGES = 2;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 120;
const DEFAULT_UNAUTH_RATE_LIMIT_MAX = 30;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseOptionalBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PUBLIC_BASE_URL must use http or https.");
  }

  parsed.hash = "";
  parsed.search = "";

  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const apiKey = env.SNAP_GOBLIN_API_KEY;
  if (!apiKey) {
    throw new Error("SNAP_GOBLIN_API_KEY is required.");
  }

  const cacheDir = env.CACHE_DIR
    ? path.resolve(env.CACHE_DIR)
    : path.resolve(process.cwd(), "cache");
  const scrapeCacheDir = env.SCRAPE_CACHE_DIR
    ? path.resolve(env.SCRAPE_CACHE_DIR)
    : path.join(cacheDir, "scrape");

  return {
    apiKey,
    port: parsePositiveInt(env.PORT, DEFAULT_PORT),
    cacheDir,
    scrapeCacheDir,
    publicBaseUrl: parseOptionalBaseUrl(env.PUBLIC_BASE_URL),
    cacheTtlSeconds: parsePositiveInt(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS),
    scrapeCacheTtlSeconds: parsePositiveInt(
      env.SCRAPE_CACHE_TTL_SECONDS,
      DEFAULT_CACHE_TTL_SECONDS
    ),
    navigationTimeoutMs: parsePositiveInt(
      env.NAVIGATION_TIMEOUT_MS,
      DEFAULT_NAVIGATION_TIMEOUT_MS
    ),
    maxViewportWidth: parsePositiveInt(env.MAX_VIEWPORT_WIDTH, DEFAULT_MAX_VIEWPORT_WIDTH),
    maxViewportHeight: parsePositiveInt(env.MAX_VIEWPORT_HEIGHT, DEFAULT_MAX_VIEWPORT_HEIGHT),
    maxTextLength: parsePositiveInt(env.MAX_TEXT_LENGTH, DEFAULT_MAX_TEXT_LENGTH),
    maxHtmlLength: parsePositiveInt(env.MAX_HTML_LENGTH, DEFAULT_MAX_HTML_LENGTH),
    maxLinks: parsePositiveInt(env.MAX_LINKS, DEFAULT_MAX_LINKS),
    maxConcurrentPages: parsePositiveInt(
      env.MAX_CONCURRENT_PAGES,
      DEFAULT_MAX_CONCURRENT_PAGES
    ),
    rateLimitWindowMs: parsePositiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    authRateLimitMax: parsePositiveInt(env.AUTH_RATE_LIMIT_MAX, DEFAULT_AUTH_RATE_LIMIT_MAX),
    unauthRateLimitMax: parsePositiveInt(
      env.UNAUTH_RATE_LIMIT_MAX,
      DEFAULT_UNAUTH_RATE_LIMIT_MAX
    ),
    allowPrivateNetworks: parseBoolean(env.ALLOW_PRIVATE_NETWORKS, false),
    urlAllowlist: parseCsvSet(env.URL_ALLOWLIST),
    urlDenylist: parseCsvSet(env.URL_DENYLIST)
  };
}
