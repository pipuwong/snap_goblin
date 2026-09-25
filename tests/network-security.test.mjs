import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../dist/src/config.js';
import { startSafeEgressProxy } from '../dist/src/safe-egress-proxy.js';
import { resolveTargetAddress } from '../dist/src/url-policy.js';

test('rejects credentials, nonstandard ports, and IPv4-mapped loopback', async () => {
  const config = loadConfig({ SNAP_GOBLIN_API_KEY: 'test' });
  await assert.rejects(resolveTargetAddress('http://user:pass@example.com/', config));
  await assert.rejects(resolveTargetAddress('https://example.com:8443/', config));
  await assert.rejects(resolveTargetAddress('http://[::ffff:127.0.0.1]/', config));
  await assert.rejects(resolveTargetAddress('http://[fec0::1]/', config));
});

test('proxy pins a permitted address and rejects private requests', async () => {
  let hits = 0;
  const target = createServer((_request, response) => {
    hits += 1;
    response.end('ok');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  const proxy = await startSafeEgressProxy(async (url) => {
    if (new URL(url).hostname !== 'public.test') throw new Error('blocked');
    return { address: '127.0.0.1', family: 4 };
  });
  const proxyPort = new URL(proxy.url).port;
  const requestThroughProxy = (url) => new Promise((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port: proxyPort, path: url }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject).end();
  });

  try {
    assert.equal(await requestThroughProxy(`http://public.test:${targetPort}/safe`), 200);
    assert.equal(await requestThroughProxy(`http://127.0.0.1:${targetPort}/private`), 403);
    assert.equal(hits, 1);
  } finally {
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test('CONNECT does not open an upstream socket after the client disconnects', async () => {
  let connections = 0;
  const target = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  let releaseResolution;
  let resolutionStarted;
  const resolutionStartedPromise = new Promise((resolve) => { resolutionStarted = resolve; });
  const resolution = new Promise((resolve) => { releaseResolution = resolve; });
  const proxy = await startSafeEgressProxy(async (url) => {
    if (new URL(url).hostname !== 'public.test') throw new Error('blocked');
    resolutionStarted();
    return resolution;
  });
  const proxyPort = Number(new URL(proxy.url).port);

  try {
    const client = connectTcp(proxyPort, '127.0.0.1');
    await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
    client.write(`CONNECT public.test:${targetPort} HTTP/1.1\r\nHost: public.test:${targetPort}\r\n\r\n`);
    await resolutionStartedPromise;
    const clientClosed = new Promise((resolve) => client.once('close', resolve));
    client.destroy();
    await clientClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseResolution({ address: '127.0.0.1', family: 4 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(connections, 0);
  } finally {
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test('CONNECT tunnels through the pinned address', async () => {
  const target = createTcpServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  const proxy = await startSafeEgressProxy(async () => ({ address: '127.0.0.1', family: 4 }));
  const proxyPort = Number(new URL(proxy.url).port);

  try {
    const tunnel = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `public.test:${targetPort}` });
      request.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`CONNECT returned ${response.statusCode}`));
          return;
        }
        resolve(socket);
      });
      request.on('error', reject);
      request.end();
    });
    tunnel.write('ping');
    const echoed = await new Promise((resolve, reject) => tunnel.once('data', resolve).once('error', reject));
    assert.equal(echoed.toString(), 'ping');
    tunnel.destroy();
  } finally {
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});
