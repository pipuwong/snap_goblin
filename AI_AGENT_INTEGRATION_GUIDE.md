# Snap Goblin AI Integration Guide

Use this guide to integrate the `snap_goblin` service into another project.

The goal is to let another app send a URL to this service and receive structured page data that is useful for an AI agent:

- rendered page text
- page metadata
- optional links
- optional screenshot metadata

This service is intended for server-to-server use. Do not expose the API key in browser code.
Protected routes, including image retrieval, require the same `x-api-key`.
`GET /health` is the only public route.

## Service Summary

The service runs as a separate HTTP API and exposes these routes:

- `GET /health`
- `POST /capture`
- `POST /refresh`
- `POST /scrape`
- `GET /image/:key`

For AI use cases, the main route is `POST /scrape`.

By default, the service now returns up to `100000` characters of rendered page text through `content.text`.

## Expected Runtime

Default local Docker setup:

- host port: `4010`
- container port: `4000`

So the base URL is usually:

```txt
http://localhost:4010
```

If the consuming app runs in another Docker container on the same network, prefer using the Docker service name instead of `localhost`.

Example:

```txt
http://snap_goblin:4000
```

## Required Environment Variables

The consuming app should have these env vars:

```env
SCRAPER_BASE_URL=http://localhost:4010
SCRAPER_API_KEY=replace-with-the-same-value-as-SNAP_GOBLIN_API_KEY
```

The scraper service itself must be started with:

```env
SNAP_GOBLIN_API_KEY=replace-with-strong-api-key
HOST_PORT=4010
PORT=4000
PUBLIC_BASE_URL=https://snap-goblin.example.com
RATE_LIMIT_WINDOW_MS=60000
AUTH_RATE_LIMIT_MAX=120
UNAUTH_RATE_LIMIT_MAX=30
MAX_TEXT_LENGTH=100000
```

Use a long random API key generated outside the repo, keep it in server-side env vars only, and rotate it if you suspect it has been exposed.

## Recommended Architecture

The other project should:

1. Call this scraper only from trusted server code.
2. Centralize scraper calls in one helper or service module.
3. Normalize scraper responses before passing them into your AI pipeline.
4. Keep the raw response available for debugging.
5. Use timeouts and graceful error handling.

Good places for integration:

- Next.js route handler
- Next.js server action
- Express backend service
- background job / worker
- ingestion pipeline before LLM summarization

## Primary Endpoint

### `POST /scrape`

Headers:

```http
content-type: application/json
x-api-key: <SCRAPER_API_KEY>
```

Recommended request body for AI ingestion:

```json
{
  "url": "https://example.com",
  "exportFormat": "serper",
  "query": "example domain",
  "engine": "google",
  "includeContent": true,
  "includeMetadata": true,
  "includeLinks": true,
  "includeHtml": false,
  "includeScreenshot": false,
  "fetchFullPage": false,
  "waitUntil": "networkidle",
  "maxTextLength": 100000,
  "maxLinks": 50
}
```

`fetchFullPage` is a request-body alias for `fullPage`. It enables full-page capture behavior on `/capture`, `/refresh`, and screenshot-enabled `/scrape` requests without changing the service-wide `MAX_VIEWPORT_WIDTH` and `MAX_VIEWPORT_HEIGHT` limits.

If you request screenshots, the response includes `imagePath` and `imageUrl`. Treat both as protected resources. Your backend must send `x-api-key` again when fetching `GET /image/:key`.
If `PUBLIC_BASE_URL` is not set on the scraper service, `imageUrl` will stay relative so downstream apps do not accidentally trust forwarded host headers.

Recommended high-value fields from the response when using the default export:

- `page.title`
- `page.description`
- `page.ogTitle`
- `page.ogDescription`
- `page.finalUrl`
- `content.text`
- `content.headings`
- `links`
- `timings`

## Response Shape To Expect

Typical response:

```json
{
  "key": "abc123",
  "sourceUrl": "https://example.com",
  "cached": false,
  "capturedAt": "2026-03-11T00:00:00.000Z",
  "expiresAt": "2026-03-11T00:05:00.000Z",
  "ttlSeconds": 300,
  "request": {
    "includeContent": true,
    "includeMetadata": true,
    "includeLinks": true,
    "includeHtml": false,
    "includeScreenshot": false,
    "maxTextLength": 100000,
    "maxLinks": 50
  },
  "page": {
    "requestedUrl": "https://example.com",
    "finalUrl": "https://example.com",
    "title": "Example Domain",
    "description": null,
    "ogTitle": null,
    "ogDescription": null,
    "ogImage": null,
    "siteName": null,
    "canonicalUrl": null,
    "lang": "en"
  },
  "content": {
    "text": "Rendered page text...",
    "textLength": 12345,
    "headings": ["Heading A", "Heading B"],
    "html": null,
    "htmlLength": 45678
  },
  "links": [
    {
      "href": "https://example.com/about",
      "text": "About",
      "rel": null,
      "target": null,
      "title": null
    }
  ],
  "screenshot": null,
  "timings": {
    "navigationMs": 1200,
    "extractionMs": 150,
    "totalMs": 1350
  }
}
```

If you want a Serper-style export instead, send `"exportFormat": "serper"` and the response will look like this:

```json
{
  "searchParameters": {
    "q": "example domain",
    "type": "webpage",
    "engine": "google"
  },
  "knowledgeGraph": {
    "title": "Example Domain",
    "description": "Rendered summary for the crawled page...",
    "descriptionSource": "Website",
    "descriptionLink": "https://example.com/",
    "attributes": {
      "URL": "https://example.com/",
      "Language": "en"
    }
  },
  "organic": [
    {
      "title": "Example Domain",
      "link": "https://example.com/",
      "snippet": "Rendered summary for the crawled page...",
      "position": 1
    }
  ],
  "relatedSearches": [
    {
      "query": "More information"
    }
  ],
  "credits": 1
}
```

## Minimal Implementation Pattern

Create a server-only helper in the other project.

Example TypeScript helper:

```ts
type ScrapeResult = {
  key: string;
  sourceUrl: string;
  cached: boolean;
  page: {
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
  } | null;
  content: {
    text: string | null;
    textLength: number;
    headings: string[];
    html: string | null;
    htmlLength: number;
  } | null;
  links: Array<{
    href: string;
    text: string;
    rel: string | null;
    target: string | null;
    title: string | null;
  }> | null;
  timings: {
    navigationMs: number;
    extractionMs: number;
    totalMs: number;
  } | null;
};

export async function scrapePageForAi(url: string): Promise<ScrapeResult> {
  const response = await fetch(`${process.env.SCRAPER_BASE_URL}/scrape`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.SCRAPER_API_KEY!
    },
    body: JSON.stringify({
      url,
      includeContent: true,
      includeMetadata: true,
      includeLinks: true,
      includeHtml: false,
      includeScreenshot: false,
      waitUntil: "networkidle",
      maxTextLength: 100000,
      maxLinks: 50
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Scrape failed: ${response.status} ${body}`);
  }

  return response.json();
}
```

If your integration needs screenshots, fetch the image through backend code instead of exposing the scraper URL directly to the browser:

```ts
export async function fetchProtectedScreenshot(imagePath: string): Promise<ArrayBuffer> {
  const response = await fetch(`${process.env.SCRAPER_BASE_URL}${imagePath}`, {
    headers: {
      "x-api-key": process.env.SCRAPER_API_KEY!
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Image fetch failed: ${response.status} ${body}`);
  }

  return response.arrayBuffer();
}
```

## AI-Oriented Normalization

After receiving the response, map it into a simpler object for your AI agent.

Recommended normalized shape:

```ts
type AiPageContext = {
  url: string;
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  headings: string[];
  mainText: string;
  linkSummaries: string[];
  scrapedAt: string;
};
```

Example mapper:

```ts
export function toAiPageContext(scrape: any) {
  return {
    url: scrape.sourceUrl,
    finalUrl: scrape.page?.finalUrl ?? null,
    title: scrape.page?.title ?? null,
    description: scrape.page?.description ?? scrape.page?.ogDescription ?? null,
    headings: scrape.content?.headings ?? [],
    mainText: scrape.content?.text ?? "",
    linkSummaries: (scrape.links ?? [])
      .filter((link: any) => link.href)
      .slice(0, 20)
      .map((link: any) => `${link.text || "(no text)"} -> ${link.href}`),
    scrapedAt: scrape.capturedAt
  };
}
```

## Best Practices For The Other Project

- Only call the scraper from backend code.
- Keep the API key in server env vars only.
- Treat `GET /image/:key` as protected API access, not as a public static file.
- Proxy screenshot delivery through your own backend if an end user needs to view it.
- Pass `waitForSelector` for pages that render important content late.
- Use `includeLinks: true` when the AI agent needs navigation context.
- Use `includeHtml: false` unless you specifically need DOM markup.
- Increase `maxTextLength` per request if a specific workflow needs more than `100000`.
- Log `timings.totalMs` and `cached` for observability.
- Treat `content.textLength` as the original extracted size before truncation.

## Failure Handling

The integrating app should handle:

- `401` invalid or missing API key
- `400` invalid request body or blocked URL
- `429` rate-limited client
- request timeout / network error
- empty content on JS-heavy or blocked pages

Suggested pattern:

1. Try a normal scrape with `waitUntil: "networkidle"`.
2. If content is too thin, retry with `waitForSelector`.
3. If still thin, retry with `extraWaitMs`.
4. If the page is still not usable, surface a structured error to the AI workflow.

## Suggested Integration Tasks For An AI Agent

If you want to hand this off to another AI agent, give it this checklist:

1. Add `SCRAPER_BASE_URL` and `SCRAPER_API_KEY` env vars to the target project.
2. Create a server-only scraper client module.
3. Implement a `scrapePageForAi(url)` function that calls `POST /scrape`.
4. If screenshots are needed, fetch `GET /image/:key` from backend code with `x-api-key`.
5. Add a mapper that converts scraper output into a compact AI-ready context object.
6. Replace any old direct page-fetch logic with this scraper-backed flow where appropriate.
7. Ensure no browser/client code ever references `SCRAPER_API_KEY`.
8. Add basic logging and error handling around scraper failures.
9. Add one test or one integration path that verifies a successful scrape call.

## Copy/Paste Prompt For Another AI Agent

```txt
Integrate the existing scraper service into this project.

Requirements:
- Use server-side code only.
- Read SCRAPER_BASE_URL and SCRAPER_API_KEY from environment variables.
- Create a reusable helper that calls POST {SCRAPER_BASE_URL}/scrape with x-api-key.
- If screenshots are used, fetch GET {SCRAPER_BASE_URL}/image/:key from backend code with x-api-key.
- Request includeContent=true, includeMetadata=true, includeLinks=true, includeHtml=false, includeScreenshot=false.
- Use waitUntil=networkidle and maxTextLength=100000 by default.
- Return a normalized AI-friendly object with title, description, headings, main text, links, and final URL.
- Add robust error handling for non-200 responses and network failures.
- Do not expose secrets to client-side code.
- Update the part of the app that currently gathers webpage content so it uses this scraper helper.
- If tests exist, add or update a test for the integration.
```

## Local Verification

Before integrating into the other project, confirm this service is running:

```bash
docker compose up -d --build
```

Then verify:

```bash
curl -sS -X POST "http://localhost:4010/scrape" ^
  -H "content-type: application/json" ^
  -H "x-api-key: replace-with-strong-api-key" ^
  -d "{\"url\":\"https://example.com\",\"includeContent\":true,\"includeMetadata\":true,\"includeLinks\":true,\"maxTextLength\":100000}"
```

If that returns JSON with `content.text`, the service is ready to integrate.

If you enable `PUBLIC_BASE_URL`, make sure it points at your real HTTPS origin. Otherwise, `imageUrl` will stay as a relative path so consuming apps do not accidentally trust spoofable forwarded headers.
