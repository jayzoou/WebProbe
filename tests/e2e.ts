import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';
import { createFixture } from '../fixtures/site.js';
import type { Scan, Issue } from '../packages/shared/src/index.js';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
process.env.ALLOW_PRIVATE_NETWORK = 'true';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-e2e-'));
process.env.PORT = '4179';
const { app } = await import('../apps/server/src/index.js');
const { all } = await import('../apps/server/src/store.js');
const fixture = createFixture();
await new Promise<void>((r) => fixture.server.listen(0, '127.0.0.1', r));
const fixturePort = (fixture.server.address() as { port: number }).port;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4179 });
const browser = await chromium.launch({ headless: true });
mkdirSync('test-results', { recursive: true });
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
page.on('pageerror', (e) => errors.push(e.message));
async function waitScan(id: string) {
  const deadline = Date.now() + 360000;
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:4179/api/scans/${id}`);
    const s = (await r.json()) as Scan;
    if (!['queued', 'running'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Scan timeout');
}
try {
  await page.goto('http://127.0.0.1:4179');
  await page.getByRole('button', { name: '接入第一个项目' }).click();
  await page.getByPlaceholder('例如：个人博客').fill('WebProbe 验证项目');
  await page.getByPlaceholder('https://example.com').fill(`http://127.0.0.1:${fixturePort}/`);
  await page.getByRole('button', { name: '保存项目' }).click();
  await page.getByText('项目已创建，可以开始第一次检测').waitFor();
  await page.screenshot({
    path: 'test-results/initial-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  console.log('PASS UI 项目创建');
  const projects = await (await fetch('http://127.0.0.1:4179/api/projects')).json();
  const browsers = (process.env.WEBPROBE_TEST_BROWSERS || 'chromium,firefox,webkit').split(',');
  const config = {
    projectId: projects[0].id,
    environmentId: 'production',
    browsers,
    devices: ['desktop'],
    maxPages: 2,
    lighthouse: true,
    release: 'before',
  };
  let res = await fetch('http://127.0.0.1:4179/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const first = await waitScan((await res.json()).id);
  assert.equal(first.status, 'completed', JSON.stringify(first.pages.map((p) => p.error)));
  assert.equal(first.pages.length, browsers.length * 2);
  assert.ok(first.pages.some((p) => p.url.endsWith('/about')));
  assert.ok(first.findings.some((f) => f.rule === 'js-uncaught'));
  assert.ok(first.findings.some((f) => f.rule === 'horizontal-overflow'));
  assert.ok(first.findings.some((f) => f.rule === 'axe-button-name'));
  assert.ok(
    first.pages
      .filter((p) => p.browser === 'chromium')
      .every((p) => typeof p.metrics?.performance === 'number'),
  );
  console.log(
    'PASS 真实浏览器检测、站内发现、异常与无障碍、Lighthouse',
    browsers.join(','),
    first.findings.length,
  );
  await page.goto(`http://127.0.0.1:4179/scans/${first.id}`);
  await page.getByRole('heading', { name: '发布质量准入' }).waitFor();
  await page.screenshot({
    path: 'test-results/report-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  fixture.fix();
  res = await fetch('http://127.0.0.1:4179/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, release: 'after' }),
  });
  const second = await waitScan((await res.json()).id);
  assert.equal(second.status, 'completed', JSON.stringify(second.pages.map((p) => p.error)));
  assert.ok(second.comparison!.removed > 0);
  assert.ok(
    all<Issue>('issue')
      .filter((i) => i.rule === 'js-uncaught')
      .every((i) => i.status === 'resolved'),
  );
  console.log('PASS 修复回归、问题自动验证、指标对比', second.comparison?.removed);
  res = await fetch('http://127.0.0.1:4179/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...config,
      browsers: ['chromium'],
      devices: ['mobile'],
      maxPages: 1,
      lighthouse: false,
    }),
  });
  const mobile = await waitScan((await res.json()).id);
  assert.equal(mobile.status, 'completed');
  assert.equal(mobile.pages[0].device, 'mobile');
  console.log('PASS 移动端检测');
  const zip = await fetch(`http://127.0.0.1:4179/api/scans/${first.id}/export?format=bundle`);
  assert.ok((await zip.arrayBuffer()).byteLength > 10000);
  console.log('PASS 包含截图与原始报告的修复任务 ZIP');
  await page.goto('http://127.0.0.1:4179/issues');
  await page.getByRole('button', { name: /已修复/ }).click();
  await page.locator('.issue-row').first().click();
  await page.getByRole('heading', { name: '检测证据' }).waitFor();
  await page.getByRole('button', { name: '生成规则建议' }).click();
  await page.getByText('规则生成 · 非 AI 输出').waitFor();
  console.log('PASS 问题详情与规则诊断');
  await page.goto('http://127.0.0.1:4179');
  await page.screenshot({
    path: 'test-results/dashboard-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/dashboard-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.getByRole('link', { name: '项目管理' }).click();
  await page.getByRole('button', { name: '开始检测' }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS 移动端导航、无横向溢出、无前端运行异常');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => fixture.server.close(() => r()));
}
