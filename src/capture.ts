import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { startSafeEgressProxy } from "./safe-egress-proxy.js";
import type { ResolvedTargetAddress } from "./url-policy.js";
import type {
  CapturedImageResult,
  ImageFormat,
  NavigationWaitUntil,
  ScrapedPageMeta,
  ScrapedPageResult,
  ScrapeLink
} from "./types.js";

const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg"
};

let browserPromise: Promise<Browser> | null = null;
let maxConcurrentPages = 2;
let activePages = 0;
const waitingResolvers: Array<() => void> = [];

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
      ]
    });
  }

  return browserPromise;
}

function setConcurrencyLimit(limit: number): void {
  maxConcurrentPages = Math.max(1, Math.floor(limit));
}

async function acquirePageSlot(): Promise<void> {
  if (activePages < maxConcurrentPages) {
    activePages += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    waitingResolvers.push(() => {
      activePages += 1;
      resolve();
    });
  });
}

function releasePageSlot(): void {
  activePages = Math.max(0, activePages - 1);
  const next = waitingResolvers.shift();
  next?.();
}

async function waitForPageReady(
  page: Page,
  options: {
    url: string;
    navigationTimeoutMs: number;
    waitUntil: NavigationWaitUntil;
    waitForSelector: string | null;
    extraWaitMs: number;
    resolveAddress: (url: string) => Promise<ResolvedTargetAddress>;
  }
): Promise<void> {
  await page.goto(options.url, {
    timeout: options.navigationTimeoutMs,
    waitUntil: options.waitUntil
  });

  await options.resolveAddress(page.url());

  if (options.waitForSelector) {
    await page.waitForSelector(options.waitForSelector, {
      timeout: options.navigationTimeoutMs
    });
  }

  if (options.extraWaitMs > 0) {
    await page.waitForTimeout(options.extraWaitMs);
  }
}

async function withLoadedPage<T>(options: {
  url: string;
  width: number;
  height: number;
  navigationTimeoutMs: number;
  waitUntil: NavigationWaitUntil;
  waitForSelector: string | null;
  extraWaitMs: number;
  resolveAddress: (url: string) => Promise<ResolvedTargetAddress>;
  run: (page: Page) => Promise<T>;
}): Promise<T> {
  await acquirePageSlot();
  let context: BrowserContext | null = null;
  let proxy: Awaited<ReturnType<typeof startSafeEgressProxy>> | null = null;
  try {
    proxy = await startSafeEgressProxy(options.resolveAddress);
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      proxy: { server: proxy.url },
      serviceWorkers: "block",
      acceptDownloads: false
    });
    const page = await context.newPage();
    await waitForPageReady(page, {
      url: options.url,
      navigationTimeoutMs: options.navigationTimeoutMs,
      waitUntil: options.waitUntil,
      waitForSelector: options.waitForSelector,
      extraWaitMs: options.extraWaitMs,
      resolveAddress: options.resolveAddress
    });

    return await options.run(page);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await proxy?.close();
      } finally {
        releasePageSlot();
      }
    }
  }
}

export async function captureWebsite(options: {
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
}): Promise<CapturedImageResult> {
  return withLoadedPage({
    url: options.url,
    width: options.width,
    height: options.height,
    navigationTimeoutMs: options.navigationTimeoutMs,
    waitUntil: options.waitUntil ?? "networkidle",
    waitForSelector: options.waitForSelector ?? null,
    extraWaitMs: options.extraWaitMs ?? 0,
    resolveAddress: options.resolveAddress,
    run: async (page) => {
      const buffer = await page.screenshot({
        type: options.format,
        quality: options.format !== "png" ? options.quality : undefined,
        fullPage: options.fullPage
      });

      return {
        buffer,
        format: options.format,
        contentType: CONTENT_TYPES[options.format]
      };
    }
  });
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function trimHtml(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}<!-- truncated -->`;
}

export async function scrapeWebsite(options: {
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
}): Promise<{
  page: ScrapedPageMeta | null;
  content: ScrapedPageResult["content"];
  links: ScrapeLink[] | null;
  screenshotBuffer: Buffer | null;
  screenshotContentType: string | null;
  timings: ScrapedPageResult["timings"];
}> {
  const startedAt = Date.now();

  return withLoadedPage({
    url: options.url,
    width: options.width,
    height: options.height,
    navigationTimeoutMs: options.navigationTimeoutMs,
    waitUntil: options.waitUntil,
    waitForSelector: options.waitForSelector,
    extraWaitMs: options.extraWaitMs,
    resolveAddress: options.resolveAddress,
    run: async (page) => {
      const navigationMs = Date.now() - startedAt;
      const extractionStartedAt = Date.now();
      const extracted = await page.evaluate(
        ({ includeMetadata, includeLinks, maxLinks }) => {
          const getMeta = (selector: string): string | null => {
            const element = document.querySelector<HTMLMetaElement>(selector);
            return element?.content?.trim() || null;
          };

          const canonicalElement = document.querySelector<HTMLLinkElement>(
            'link[rel="canonical"]'
          );
          const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
            .map((element) => element.textContent?.trim() ?? "")
            .filter(Boolean)
            .slice(0, 50);
          const links = includeLinks
            ? Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
                .map((element) => ({
                  href: element.href,
                  text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
                  rel: element.getAttribute("rel"),
                  target: element.getAttribute("target"),
                  title: element.getAttribute("title")?.trim() || null
                }))
                .filter((link) => Boolean(link.href))
                .slice(0, maxLinks)
            : null;

          return {
            finalUrl: window.location.href,
            title: includeMetadata ? document.title?.trim() || null : null,
            description: includeMetadata ? getMeta('meta[name="description"]') : null,
            ogTitle: includeMetadata ? getMeta('meta[property="og:title"]') : null,
            ogDescription: includeMetadata
              ? getMeta('meta[property="og:description"]')
              : null,
            ogImage: includeMetadata
              ? getMeta('meta[property="og:image"]') ?? getMeta('meta[name="twitter:image"]')
              : null,
            siteName: includeMetadata ? getMeta('meta[property="og:site_name"]') : null,
            canonicalUrl: includeMetadata ? canonicalElement?.href ?? null : null,
            lang: includeMetadata ? document.documentElement.lang || null : null,
            headings,
            text: document.body?.innerText ?? "",
            html: document.documentElement.outerHTML,
            links
          };
        },
        {
          includeMetadata: options.includeMetadata,
          includeLinks: options.includeLinks,
          maxLinks: options.maxLinks
        }
      );

      const pageMeta: ScrapedPageMeta | null =
        options.includeMetadata || options.includeContent || options.includeLinks
          ? {
              requestedUrl: options.url,
              finalUrl: extracted.finalUrl,
              title: extracted.title,
              description: extracted.description,
              ogTitle: extracted.ogTitle,
              ogDescription: extracted.ogDescription,
              ogImage: extracted.ogImage,
              siteName: extracted.siteName,
              canonicalUrl: extracted.canonicalUrl,
              lang: extracted.lang
            }
          : null;

      const content = options.includeContent
        ? {
            text: trimText(extracted.text, options.maxTextLength),
            textLength: extracted.text.length,
            headings: extracted.headings,
            html: options.includeHtml ? trimHtml(extracted.html, options.maxHtmlLength) : null,
            htmlLength: extracted.html.length
          }
        : null;

      const screenshotBuffer = options.includeScreenshot
        ? await page.screenshot({
            type: options.format,
            quality: options.format !== "png" ? options.quality : undefined,
            fullPage: options.fullPage
          })
        : null;
      const extractionMs = Date.now() - extractionStartedAt;

      return {
        page: pageMeta,
        content,
        links: options.includeLinks ? extracted.links : null,
        screenshotBuffer,
        screenshotContentType: options.includeScreenshot
          ? CONTENT_TYPES[options.format]
          : null,
        timings: {
          navigationMs,
          extractionMs,
          totalMs: Date.now() - startedAt
        }
      };
    }
  });
}

export function configureCaptureConcurrency(limit: number): void {
  setConcurrencyLimit(limit);
}

export async function closeCaptureBrowser(): Promise<void> {
  if (!browserPromise) {
    return;
  }

  const browser = await browserPromise;
  await browser.close();
  browserPromise = null;
  activePages = 0;
  waitingResolvers.length = 0;
}
