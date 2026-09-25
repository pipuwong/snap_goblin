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
  if (parsed.username || parsed.password) {
    throw new Error("URLs with credentials are not supported.");
  }

  parsed.hash = "";
  return parsed.toString();
}

const blockedAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32]
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 0 || blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type ResolvedTargetAddress = { address: string; family: 4 | 6 };

export async function resolveTargetAddress(url: string, config: RuntimeConfig): Promise<ResolvedTargetAddress> {
  const parsed = new URL(normalizeTargetUrl(url));
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (config.urlDenylist.has(hostname)) {
    throw new Error(`Hostname ${hostname} is denied by policy.`);
  }

  if (config.urlAllowlist.size > 0 && !config.urlAllowlist.has(hostname)) {
    throw new Error(`Hostname ${hostname} is not in URL_ALLOWLIST.`);
  }

  if (!config.allowPrivateNetworks) {
    if (parsed.port !== "") {
      throw new Error("Only standard HTTP and HTTPS ports are allowed.");
    }
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new Error(`Hostname ${hostname} is not allowed.`);
    }
    if (net.isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
      throw new Error(`Hostname ${hostname} is not allowed.`);
    }
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error(`Hostname ${hostname} did not resolve to any address.`);
  }

  if (!config.allowPrivateNetworks && resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`Hostname ${hostname} resolves to a private or loopback address.`);
  }
  const first = resolved[0];
  if (!first || (first.family !== 4 && first.family !== 6)) {
    throw new Error(`Hostname ${hostname} did not resolve to an IP address.`);
  }
  return { address: first.address, family: first.family };
}

export async function assertTargetUrlAllowed(
  url: string,
  config: RuntimeConfig
): Promise<void> {
  await resolveTargetAddress(url, config);
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
