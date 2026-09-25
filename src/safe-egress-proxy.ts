import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { ResolvedTargetAddress } from "./url-policy.js";

type ResolveAddress = (url: string) => Promise<ResolvedTargetAddress>;

export async function startSafeEgressProxy(resolveAddress: ResolveAddress): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer(async (request, response) => {
    try {
      if (closed || response.destroyed) throw new Error("Proxy closed.");
      const target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("Unsupported proxy request.");
      const resolved = await resolveAddress(target.href);
      if (closed || response.destroyed) throw new Error("Proxy closed.");
      const headers: IncomingHttpHeaders = { ...request.headers, host: target.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest({
        hostname: resolved.address,
        family: resolved.family,
        port: Number(target.port || 80),
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on("aborted", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(403).end();
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("connect", async (request, client, head) => {
    let upstream: Socket | undefined;
    const pending: Buffer[] = [];
    let pendingBytes = head.length;
    const collectPending = (chunk: Buffer) => {
      pendingBytes += chunk.length;
      if (pendingBytes > 64 * 1024) client.destroy();
      else pending.push(chunk);
    };
    client.on("error", () => client.destroy());
    client.on("end", () => client.destroy());
    client.on("close", () => upstream?.destroy());
    client.on("data", collectPending);
    client.resume();
    try {
      if (closed || client.destroyed) throw new Error("Proxy closed.");
      const authority = request.url ?? "";
      const target = new URL(`https://${authority}`);
      if (target.pathname !== "/" || target.search) throw new Error("Invalid CONNECT target.");
      const resolved = await resolveAddress(target.href);
      if (closed || client.destroyed) throw new Error("Proxy closed.");
      const socket = connectTcp({
        host: resolved.address,
        family: resolved.family,
        port: Number(target.port || 443)
      });
      upstream = socket;
      const connectionTimer = setTimeout(() => socket.destroy(), 10_000);
      socket.once("connect", () => {
        clearTimeout(connectionTimer);
        client.pause();
        client.off("data", collectPending);
        if (client.destroyed) {
          socket.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) socket.write(head);
        for (const chunk of pending) socket.write(chunk);
        client.pipe(socket).pipe(client);
      });
      socket.once("close", () => clearTimeout(connectionTimer));
      socket.on("error", () => client.destroy());
      socket.on("close", () => client.destroy());
    } catch {
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to start safe egress proxy.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
