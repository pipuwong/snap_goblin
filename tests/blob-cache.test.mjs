import assert from 'node:assert/strict';
import { test } from 'node:test';

const caches = await import('../dist/src/blob-cache.js').catch(() => null);

function memoryBlob() {
  const files = new Map();
  return {
    async put(pathname, body, options) {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const blob = {
        pathname,
        contentType: options.contentType,
        size: bytes.length,
        uploadedAt: new Date(),
        etag: `"${bytes.length}"`
      };
      files.set(pathname, { bytes, blob });
      return blob;
    },
    async head(pathname) {
      const item = files.get(pathname);
      if (!item) throw new Error('not found');
      return item.blob;
    },
    async get(pathname) {
      const item = files.get(pathname);
      if (!item) return null;
      return {
        statusCode: 200,
        stream: new ReadableStream({ start(controller) { controller.enqueue(item.bytes); controller.close(); } }),
        blob: item.blob
      };
    }
  };
}

test('screenshot and scrape survive a new cache instance', async () => {
  assert.ok(caches?.BlobSnapshotCache && caches?.BlobScrapeCache, 'Vercel Blob cache implementation is missing');
  const client = memoryBlob();
  const firstImageCache = new caches.BlobSnapshotCache(client);
  const secondImageCache = new caches.BlobSnapshotCache(client);
  const image = Buffer.from('valid-image-bytes');
  await firstImageCache.save({ key: 'a'.repeat(24), sourceUrl: 'https://example.com/', format: 'png', contentType: 'image/png', buffer: image, capturedAt: Date.now() });
  assert.equal((await secondImageCache.getMeta('a'.repeat(24)))?.contentType, 'image/png');
  assert.deepEqual((await secondImageCache.getImage('a'.repeat(24)))?.buffer, image);

  const firstScrapeCache = new caches.BlobScrapeCache(client);
  const secondScrapeCache = new caches.BlobScrapeCache(client);
  const payload = { page: { title: 'Example' }, content: null, links: [], screenshot: null, timings: {} };
  await firstScrapeCache.save({ key: 'b'.repeat(24), sourceUrl: 'https://example.com/', payload, capturedAt: Date.now() });
  assert.deepEqual((await secondScrapeCache.get('b'.repeat(24)))?.payload, payload);
});
