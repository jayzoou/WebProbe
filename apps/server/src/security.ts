import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
export function isPublicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export function validateUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('仅支持不含凭证的 HTTP / HTTPS 地址');
  if (['169.254.169.254', 'metadata.google.internal'].includes(url.hostname))
    throw new Error('不允许访问云元数据地址');
  return url;
}
export async function resolveTarget(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !records.length ||
    (process.env.ALLOW_PRIVATE_NETWORK !== 'true' &&
      records.some((r) => !isPublicAddress(r.address)))
  )
    throw new Error('目标解析为内网地址；本地检测需在 .env 显式启用 ALLOW_PRIVATE_NETWORK');
  if (records.some((r) => ipaddr.process(r.address).toString() === '169.254.169.254'))
    throw new Error('禁止访问云元数据地址');
  return records[0];
}
// All browser traffic, including Lighthouse redirects/subresources, passes through
// this proxy. DNS is resolved once per connection and the validated IP is pinned.
export async function createEgressProxy(options?: { writeOrigin: string }) {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(async (req, res) => {
    try {
      const url = validateUrl(req.url || '');
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') &&
        options?.writeOrigin !== url.origin
      ) {
        res.writeHead(405).end('WebProbe read-only scan');
        return;
      }
      const target = await resolveTarget(url.hostname);
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const outbound = http.request(
        {
          hostname: target.address,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          timeout: 25000,
        },
        (r) => {
          res.writeHead(r.statusCode || 502, r.headers);
          r.pipe(res);
        },
      );
      outbound.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      outbound.on('timeout', () => outbound.destroy());
      req.pipe(outbound);
    } catch {
      res.writeHead(403).end('Blocked target');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', async (req, socket, head) => {
    try {
      const url = validateUrl(`https://${req.url}`);
      const target = await resolveTarget(url.hostname);
      const upstream = net.connect({
        host: target.address,
        port: Number(url.port || 443),
        timeout: 25000,
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      upstream.on('timeout', () => upstream.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
