# Website Scraper API

Playwright-powered internal API for screenshots and rendered page scraping. It is built to sit behind a shared API key and be consumed by other Next.js apps running on your VPS or inside Docker.

## What it does

- Protects scrape and screenshot routes with `x-api-key`
- Captures screenshots via Playwright + Chromium
- Scrapes rendered page content into deterministic JSON
- Optionally returns both JSON content and screenshot metadata from one request
- Caches screenshots and scrape payloads on disk by deterministic key
- Supports dynamic pages with configurable wait controls

## API overview

- `GET /health`
- `POST /capture`
- `POST /refresh`
- `POST /scrape`
- `GET /image/:key`

## Environment variables

- `SNAP_GOBLIN_API_KEY` required shared API key
- `PORT` default `4000`
- `CACHE_DIR` default `/app/cache`
- `SCRAPE_CACHE_DIR` default `/app/cache/scrape`
- `CACHE_TTL_SECONDS` default `300`
- `SCRAPE_CACHE_TTL_SECONDS` default `300`
- `NAVIGATION_TIMEOUT_MS` default `15000`
- `MAX_VIEWPORT_WIDTH` default `1920`
- `MAX_VIEWPORT_HEIGHT` default `1080`
- `MAX_TEXT_LENGTH` default `100000`
- `MAX_HTML_LENGTH` default `100000`
- `MAX_LINKS` default `100`
- `MAX_CONCURRENT_PAGES` default `2`
- `ALLOW_PRIVATE_NETWORKS` default `false`
- `URL_ALLOWLIST` optional comma-separated hostname allowlist
- `URL_DENYLIST` optional comma-separated hostname denylist

`ALLOW_PRIVATE_NETWORKS=false` blocks `localhost`, loopback, and private-network targets by default. For VPS use, prefer keeping that default and setting `URL_ALLOWLIST` for the external hosts you trust.

## Run with Docker

```bash
docker build -t website-scraper-api .
docker run --rm -p 4000:4000 --env-file .env website-scraper-api
```

Example `.env`:

```env
SNAP_GOBLIN_API_KEY=replace-with-strong-api-key
PORT=4000
CACHE_DIR=/app/cache
SCRAPE_CACHE_DIR=/app/cache/scrape
CACHE_TTL_SECONDS=300
SCRAPE_CACHE_TTL_SECONDS=300
NAVIGATION_TIMEOUT_MS=15000
MAX_VIEWPORT_WIDTH=1920
MAX_VIEWPORT_HEIGHT=1080
MAX_TEXT_LENGTH=100000
MAX_HTML_LENGTH=100000
MAX_LINKS=100
MAX_CONCURRENT_PAGES=2
ALLOW_PRIVATE_NETWORKS=false
# URL_ALLOWLIST=example.com,news.ycombinator.com
```

## Endpoints

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /capture`

Captures a screenshot and returns a stable `imageUrl`.

Request:

```json
{
  "url": "https://example.com",
  "ttlOverrideSeconds": 300,
  "width": 1440,
  "height": 900,
  "fullPage": true,
  "format": "png",
  "quality": 80,
  "waitUntil": "networkidle",
  "waitForSelector": "main",
  "extraWaitMs": 500
}
```

### `POST /refresh`

Same payload as `/capture`, but always re-renders the screenshot and overwrites the cached entry.

### `POST /scrape`

Flexible JSON-first route for scraping metadata, text, links, optional HTML, and optional screenshot metadata from a single page load.

Request fields:

- `url` required target URL
- `ttlOverrideSeconds` optional cache override
- `width`, `height`, `fullPage`, `format`, `quality` screenshot settings
- `waitUntil` one of `domcontentloaded`, `load`, `networkidle`
- `waitForSelector` optional CSS selector to wait for
- `extraWaitMs` optional extra delay after navigation
- `includeContent` default `true`
- `includeMetadata` default `true`
- `includeLinks` default `false`
- `includeHtml` default `false`
- `includeScreenshot` default `false`
- `maxTextLength`, `maxHtmlLength`, `maxLinks` optional bounded overrides
- `exportFormat` optional: `default` or `serper`
- `query` optional source query used in Serper-style exports
- `engine` optional engine label for Serper-style exports, default `playwright`

JSON-only example:

```json
{
  "url": "https://example.com",
  "includeContent": true,
  "includeMetadata": true,
  "includeLinks": true,
  "maxTextLength": 25000,
  "maxLinks": 25
}
```

Combined scrape + screenshot example:

```json
{
  "url": "https://example.com/blog/post",
  "includeContent": true,
  "includeMetadata": true,
  "includeLinks": false,
  "includeScreenshot": true,
  "fullPage": true,
  "width": 1440,
  "height": 900,
  "waitUntil": "networkidle",
  "waitForSelector": "article"
}
```

Serper-style export example:

```json
{
  "url": "https://www.apple.com",
  "exportFormat": "serper",
  "query": "apple inc",
  "engine": "google",
  "includeContent": true,
  "includeMetadata": true,
  "includeLinks": true
}
```

Example response:

```json
{
  "key": "2ff4f5d91d54c0cc2d4da8b0",
  "sourceUrl": "https://example.com/",
  "cached": false,
  "capturedAt": "2026-03-11T18:26:00.000Z",
  "expiresAt": "2026-03-11T18:31:00.000Z",
  "ttlSeconds": 300,
  "request": {
    "width": 1920,
    "height": 1080,
    "fullPage": false,
    "format": "png",
    "quality": 80,
    "waitUntil": "networkidle",
    "waitForSelector": null,
    "extraWaitMs": 0,
    "includeContent": true,
    "includeMetadata": true,
    "includeLinks": true,
    "includeHtml": false,
    "includeScreenshot": true,
    "maxTextLength": 25000,
    "maxHtmlLength": 100000,
    "maxLinks": 25
  },
  "page": {
    "requestedUrl": "https://example.com/",
    "finalUrl": "https://example.com/",
    "title": "Example Domain",
    "description": null,
    "ogTitle": null,
    "ogDescription": null,
    "canonicalUrl": null,
    "lang": "en"
  },
  "content": {
    "text": "Example Domain...",
    "textLength": 127,
    "headings": ["Example Domain"],
    "html": null,
    "htmlLength": 1256
  },
  "links": [
    {
      "href": "https://www.iana.org/domains/example",
      "text": "More information...",
      "rel": null,
      "target": null
    }
  ],
  "screenshot": {
    "key": "8e744fcdbe1e2b5a1bde44bf",
    "mimeType": "image/png",
    "imagePath": "/image/8e744fcdbe1e2b5a1bde44bf",
    "imageUrl": "http://localhost:4000/image/8e744fcdbe1e2b5a1bde44bf"
  },
  "timings": {
    "navigationMs": 1043,
    "extractionMs": 138,
    "totalMs": 1191
  }
}
```

When `exportFormat` is set to `serper`, `/scrape` returns a Serper-inspired response shape:

```json
{
  "searchParameters": {
    "q": "apple inc",
    "type": "webpage",
    "engine": "google"
  },
  "knowledgeGraph": {
    "title": "Apple",
    "imageUrl": "https://www.apple.com/example-og-image.jpg",
    "description": "Apple Inc. is an American multinational technology company...",
    "descriptionSource": "Apple",
    "descriptionLink": "https://www.apple.com/",
    "attributes": {
      "URL": "https://www.apple.com/",
      "Canonical URL": "https://www.apple.com/",
      "Website": "Apple",
      "Language": "en"
    }
  },
  "organic": [
    {
      "title": "Apple",
      "link": "https://www.apple.com/",
      "snippet": "Apple Inc. is an American multinational technology company...",
      "sitelinks": [
        {
          "title": "Store",
          "link": "https://www.apple.com/store"
        }
      ],
      "position": 1
    }
  ],
  "relatedSearches": [
    {
      "query": "Mac"
    }
  ],
  "credits": 1
}
```

### `GET /image/:key`

Returns the stored screenshot bytes for any key returned by `/capture`, `/refresh`, or `/scrape` when `includeScreenshot` is enabled.

## Next.js example

Use this from a server action, route handler, or any server-only utility:

```ts
const response = await fetch("http://scraper:4000/scrape", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.SCRAPER_API_KEY!
  },
  body: JSON.stringify({
    url: "https://example.com",
    includeContent: true,
    includeMetadata: true,
    includeLinks: true,
    includeScreenshot: false,
    maxTextLength: 25000
  }),
  cache: "no-store"
});

if (!response.ok) {
  throw new Error(`Scrape failed: ${response.status}`);
}

const data = await response.json();
```

## Operational notes

- `networkidle` works well for many pages, but long-polling or ad-heavy sites may need `waitForSelector` or `extraWaitMs`.
- Keep `URL_ALLOWLIST` populated in production when possible.
- Returning rendered HTML is optional and bounded because it can get large quickly.
- The service currently favors deterministic extraction over AI-generated formatting.

## OpenAI follow-up

This version does not call OpenAI yet. The intended next step is to keep `/scrape` deterministic and add an optional `ai` field later when `OPENAI_API_KEY` is configured, so your chat app can choose between raw structured scrape data and enriched summaries/classifications.

## Quick test

```bash
curl -sS -X POST "http://localhost:4000/scrape" \
  -H "content-type: application/json" \
  -H "x-api-key: replace-with-strong-api-key" \
  -d "{\"url\":\"https://example.com\",\"includeContent\":true,\"includeMetadata\":true,\"includeScreenshot\":true}"
```
