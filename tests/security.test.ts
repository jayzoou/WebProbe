import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
delete process.env.ALLOW_PRIVATE_NETWORK;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-security-'));
const { app } = await import('../apps/server/src/index.js');
const { isPublicAddress, validateUrl, resolveTarget, createEgressProxy } =
  await import('../apps/server/src/security.js');

// 从 core.test.ts 保留并迁入既有地址与代理用例，使安全门禁可独立执行。
test('SSRF：阻止 IPv4、IPv6 与映射 IPv6 私有地址', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.2',
    '169.254.169.254',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => validateUrl('file:///etc/passwd'));
  assert.throws(() => validateUrl('http://user:pass@example.com'));
  await assert.rejects(resolveTarget('127.0.0.1'));
});

test('出口代理拒绝 HTTP 与 CONNECT 内网连接', async () => {
  const proxy = await createEgressProxy();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get(
        { hostname: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1:1/' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('proxy request timeout')));
    });
    assert.equal(status, 403);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () =>
        socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
      );
      socket.once('error', reject);
      socket.setTimeout(5000, () => socket.destroy(new Error('CONNECT timeout')));
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.destroy();
      });
    });
    assert.match(response, /403 Forbidden/);
  } finally {
    await proxy.close();
  }
});

test('启用内网测试也始终阻止云元数据地址', async (t) => {
  process.env.ALLOW_PRIVATE_NETWORK = 'true';
  t.after(() => {
    delete process.env.ALLOW_PRIVATE_NETWORK;
  });
  assert.equal((await resolveTarget('127.0.0.1')).address, '127.0.0.1');
  await assert.rejects(resolveTarget('169.254.169.254'), /云元数据/);
  await assert.rejects(resolveTarget('::ffff:169.254.169.254'), /云元数据/);
  assert.throws(() => validateUrl('http://metadata.google.internal/'), /云元数据/);
});

test('API 保留 Host、Origin 与 Token 边界', async (t) => {
  process.env.WEBPROBE_API_TOKEN = 'isolated-test-token';
  t.after(() => {
    delete process.env.WEBPROBE_API_TOKEN;
  });
  assert.equal((await app.request('http://evil.example/api/health')).status, 403);
  assert.equal(
    (
      await app.request('http://localhost/api/health', {
        headers: { origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await app.request('http://localhost/api/health')).status, 401);
  assert.equal(
    (
      await app.request('http://localhost/api/health', {
        headers: { authorization: 'Bearer wrong' },
      })
    ).status,
    401,
  );
  const response = await app.request('http://localhost/api/health', {
    headers: { authorization: 'Bearer isolated-test-token' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('出口代理拒绝写操作，不向目标建立请求', async () => {
  const proxy = await createEgressProxy();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1:1/', method: 'POST' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('proxy request timeout')));
      request.end('must-not-be-forwarded');
    });
    assert.equal(status, 405);
  } finally {
    await proxy.close();
  }
});

test('V2 写权限限定明确环境的 origin，不能扩大到其他目标', async () => {
  const proxy = await createEgressProxy({ writeOrigin: 'https://allowed.example' });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1:1/', method: 'POST' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('timeout')));
      request.end('must-not-leave');
    });
    assert.equal(status, 405);
  } finally {
    await proxy.close();
  }
});
