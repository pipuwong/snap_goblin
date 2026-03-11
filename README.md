# Snap Goblin

Snap Goblin is a self-hosted Playwright service for rendered page scraping and screenshot capture. It is built for server-to-server use behind a shared API key, with deterministic JSON output, on-disk caching, and controls that make dynamic pages easier to handle in production.

## Why use it

- Scrape JavaScript-rendered pages with a real browser instead of raw HTTP fetches.
- Capture screenshots and structured page data from the same service.
- Keep responses predictable for ingestion pipelines, AI workflows, and internal tools.
- Cache results on disk with stable keys so repeated requests stay fast.
- Restrict target hosts and private-network access for safer deployments.

## What it provides

- `GET /health`
- `POST /capture`
- `POST /refresh`
- `POST /scrape`
- `GET /image/:key`

`GET /health` is public. Every other route requires `x-api-key`, including `GET /image/:key`.

## Quick Start

### Docker Compose

1. Copy `.env.example` to `.env`.
2. Set a long random `SNAP_GOBLIN_API_KEY`.
3. Start the service:

```bash
docker compose up -d --build
```

The default local URL is `http://localhost:4010`.

### Local Development

```bash
npm ci
npm run dev
```

The app listens on `PORT`, which defaults to `4000` outside Docker.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SNAP_GOBLIN_API_KEY` | none | Required shared secret for all protected routes. |
| `HOST_PORT` | `4010` | Host port used by `docker-compose.yml`. |
| `PORT` | `4000` | App port inside the process or container. |
| `CACHE_DIR` | `/app/cache` in Docker | Screenshot cache directory. |
| `SCRAPE_CACHE_DIR` | `/app/cache/scrape` in Docker | Scrape JSON cache directory. |
| `PUBLIC_BASE_URL` | empty | Optional absolute base URL used to build `imageUrl`. |
| `CACHE_TTL_SECONDS` | `300` | Default TTL for `/capture` responses. |
| `SCRAPE_CACHE_TTL_SECONDS` | `300` | Default TTL for `/scrape` responses. |
| `NAVIGATION_TIMEOUT_MS` | `15000` | Playwright navigation timeout. |
| `MAX_VIEWPORT_WIDTH` | `1920` | Maximum request width. |
| `MAX_VIEWPORT_HEIGHT` | `1080` | Maximum request height. |
| `MAX_TEXT_LENGTH` | `100000` | Maximum extracted text length. |
| `MAX_HTML_LENGTH` | `100000` | Maximum extracted HTML length. |
| `MAX_LINKS` | `100` | Maximum links returned per scrape. |
| `MAX_CONCURRENT_PAGES` | `2` | Maximum in-flight browser pages. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window duration. |
| `AUTH_RATE_LIMIT_MAX` | `120` | Allowed requests per window for authorized clients. |
| `UNAUTH_RATE_LIMIT_MAX` | `30` | Allowed requests per window for unauthorized clients. |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Whether localhost and private-network targets are allowed. |
| `URL_ALLOWLIST` | empty | Optional comma-separated hostname allowlist. |
| `URL_DENYLIST` | empty | Optional comma-separated hostname denylist. |

`ALLOW_PRIVATE_NETWORKS=false` blocks `localhost`, loopback, and private-network targets by default. For public or VPS deployments, keep that default and prefer an explicit `URL_ALLOWLIST`.

`fetchFullPage` is a request-body alias for `fullPage`. It enables full-page capture without raising the global viewport caps defined by `MAX_VIEWPORT_WIDTH` and `MAX_VIEWPORT_HEIGHT`.

If `PUBLIC_BASE_URL` is unset, `imageUrl` stays relative, such as `/image/<key>`. That is the safer default when the service sits behind a reverse proxy.

## Security Model

- Treat Snap Goblin as a backend service, not a browser-facing API.
- Keep `SNAP_GOBLIN_API_KEY` in server-side environment variables only.
- Proxy image fetches through your own backend if an end user needs to see a screenshot.
- Use `URL_ALLOWLIST` whenever you know the small set of hosts the service should reach.
- Keep `ALLOW_PRIVATE_NETWORKS=false` unless you explicitly need internal network access.

The service also sets conservative response headers and applies simple in-memory rate limiting for both authorized and unauthorized traffic.

## API

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /capture`

Captures a screenshot and returns a stable image reference.

Example request:

```json
{
  "url": "https://example.com",
  "ttlOverrideSeconds": 300,
  "width": 1440,
  "height": 900,
  "fetchFullPage": true,
  "format": "png",
  "quality": 80,
  "waitUntil": "networkidle",
  "waitForSelector": "main",
  "extraWaitMs": 500
}
```

Example response:

```json
{
  "key": "8e744fcdbe1e2b5a1bde44bf",
  "sourceUrl": "https://example.com/",
  "cached": false,
  "capturedAt": "2026-03-11T18:26:00.000Z",
  "expiresAt": "2026-03-11T18:31:00.000Z",
  "ttlSeconds": 300,
  "mimeType": "image/png",
  "imagePath": "/image/8e744fcdbe1e2b5a1bde44bf",
  "imageUrl": "/image/8e744fcdbe1e2b5a1bde44bf"
}
```

### `POST /refresh`

Uses the same payload as `/capture`, but always re-renders the screenshot and overwrites the cached image entry.

### `POST /scrape`

Scrapes metadata, rendered text, links, optional HTML, and optional screenshot metadata from a single page load.

Supported request fields:

- `url` required target URL.
- `ttlOverrideSeconds` optional cache override.
- `width`, `height`, `fetchFullPage`, `fullPage`, `format`, `quality` screenshot settings.
- `waitUntil` one of `domcontentloaded`, `load`, `networkidle`.
- `waitForSelector` optional CSS selector to wait for.
- `extraWaitMs` optional extra delay after navigation, capped at `30000`.
- `includeContent` default `true`.
- `includeMetadata` default `true`.
- `includeLinks` default `false`, except `serper` exports default to `true`.
- `includeHtml` default `false`.
- `includeScreenshot` default `false`.
- `maxTextLength`, `maxHtmlLength`, `maxLinks` optional bounded overrides.
- `exportFormat` optional: `default` or `serper`.
- `query` optional source query used in `serper` exports.
- `engine` optional engine label for `serper` exports, default `playwright`.

Default JSON example:

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

Combined scrape and screenshot example:

```json
{
  "url": "https://example.com/blog/post",
  "includeContent": true,
  "includeMetadata": true,
  "includeLinks": false,
  "includeScreenshot": true,
  "fetchFullPage": true,
  "width": 1440,
  "height": 900,
  "waitUntil": "networkidle",
  "waitForSelector": "article"
}
```

Default response shape:

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
    "maxLinks": 25,
    "exportFormat": "default"
  },
  "page": {
    "requestedUrl": "https://example.com/",
    "finalUrl": "https://example.com/",
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
      "target": null,
      "title": null
    }
  ],
  "screenshot": {
    "key": "8e744fcdbe1e2b5a1bde44bf",
    "mimeType": "image/png",
    "imagePath": "/image/8e744fcdbe1e2b5a1bde44bf",
    "imageUrl": "/image/8e744fcdbe1e2b5a1bde44bf"
  },
  "timings": {
    "navigationMs": 1043,
    "extractionMs": 138,
    "totalMs": 1191
  }
}
```

Serper-style example:

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

Serper-style response shape:

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
    "descriptionSource": "Website",
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
  "peopleAlsoAsk": [
    {
      "question": "What is Apple?",
      "snippet": "Apple Inc. is an American multinational technology company...",
      "title": "Apple",
      "link": "https://www.apple.com/"
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

Returns the stored screenshot bytes for any key returned by `/capture`, `/refresh`, or `/scrape` when `includeScreenshot` is enabled. This route is protected and requires the same `x-api-key` header as the JSON endpoints.

## Integration Example

Use this from a route handler, server action, worker, or any other server-only code:

```ts
const response = await fetch("http://snap_goblin:4000/scrape", {
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

The more detailed integration notes live in [`AI_AGENT_INTEGRATION_GUIDE.md`](./AI_AGENT_INTEGRATION_GUIDE.md).

## Development

```bash
npm ci
npm run typecheck
npm run build
docker build -t snap_goblin .
```

## Operational Notes

- `networkidle` works well for many pages, but long-polling or ad-heavy sites often need `waitForSelector` or `extraWaitMs`.
- Returning rendered HTML is optional and bounded because it can get large quickly.
- The service prefers deterministic extraction over AI-generated post-processing.
- If you set `PUBLIC_BASE_URL`, point it at the real HTTPS origin for the service.

## Contributing

Public contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, validation commands, and PR expectations.

## Quick Test

```bash
curl -sS -X POST "http://localhost:4010/scrape" \
  -H "content-type: application/json" \
  -H "x-api-key: replace-with-strong-api-key" \
  -d "{\"url\":\"https://example.com\",\"includeContent\":true,\"includeMetadata\":true,\"includeScreenshot\":true}"
```
