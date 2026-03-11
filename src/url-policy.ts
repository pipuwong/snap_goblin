import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { RuntimeConfig } from "./config.js";
import type { ImageFormat, NavigationWaitUntil, ScrapeRequestOptions } from "./types.js";

export function normalizeTargetUrl(value: string): string {
  const parsed = new URL(value);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  parsed.hash = "";
  return parsed.toString();
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 0 ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    return isPrivateIpv4(address);
  }

  if (net.isIPv6(address)) {
    return isPrivateIpv6(address);
  }

  return false;
}

async function assertHostnameResolvesPublic(hostname: string): Promise<void> {
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error(`Hostname ${hostname} did not resolve to any address.`);
  }

  const blocked = resolved.find((entry) => isPrivateAddress(entry.address));
  if (blocked) {
    throw new Error(`Hostname ${hostname} resolves to a private or loopback address.`);
  }
}

export async function assertTargetUrlAllowed(
  url: string,
  config: RuntimeConfig
): Promise<void> {
  const hostname = new URL(url).hostname.toLowerCase();

  if (config.urlDenylist.has(hostname)) {
    throw new Error(`Hostname ${hostname} is denied by policy.`);
  }

  if (config.urlAllowlist.size > 0 && !config.urlAllowlist.has(hostname)) {
    throw new Error(`Hostname ${hostname} is not in URL_ALLOWLIST.`);
  }

  if (config.allowPrivateNetworks) {
    return;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`Hostname ${hostname} is not allowed.`);
  }

  if (isPrivateAddress(hostname)) {
    throw new Error(`Hostname ${hostname} is not allowed.`);
  }

  await assertHostnameResolvesPublic(hostname);
}

export function createSnapshotKey(options: {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  format: ImageFormat;
  quality: number;
}): string {
  const input = `${options.url}|${options.width}x${options.height}|${options.fullPage ? "full" : "viewport"}|${options.format}@${options.quality}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function createScrapeKey(options: {
  url: string;
  request: ScrapeRequestOptions;
}): string {
  const request = options.request;
  const input = JSON.stringify({
    url: options.url,
    width: request.width,
    height: request.height,
    fullPage: request.fullPage,
    format: request.format,
    quality: request.quality,
    waitUntil: request.waitUntil,
    waitForSelector: request.waitForSelector,
    extraWaitMs: request.extraWaitMs,
    includeContent: request.includeContent,
    includeMetadata: request.includeMetadata,
    includeLinks: request.includeLinks,
    includeHtml: request.includeHtml,
    includeScreenshot: request.includeScreenshot,
    maxTextLength: request.maxTextLength,
    maxHtmlLength: request.maxHtmlLength,
    maxLinks: request.maxLinks
  });

  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function parseWaitUntil(value: unknown): NavigationWaitUntil {
  if (
    value === "domcontentloaded" ||
    value === "load" ||
    value === "networkidle"
  ) {
    return value;
  }

  return "networkidle";
}

export function parseViewportDimension(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return fallback;
  }

  return Math.min(rounded, max);
}
