import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createTestingFixture } from '../fixtures/testing-site.js';
import type { Release } from '../packages/shared/src/releases.js';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '4199';
process.env.ALLOW_PRIVATE_NETWORK = 'true';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-release-e2e-'));
const { app } = await import('../apps/server/src/index.js');
const fixture = createTestingFixture(),
  candidateFixture = createTestingFixture();
await Promise.all([
  new Promise<void>((r) => fixture.server.listen(0, '127.0.0.1', r)),
  new Promise<void>((r) => candidateFixture.server.listen(0, '127.0.0.1', r)),
]);
const target = `http://127.0.0.1:${(fixture.server.address() as { port: number }).port}/`,
  candidate = `http://127.0.0.1:${(candidateFixture.server.address() as { port: number }).port}/`;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4199 }),
  browser = await chromium.launch(),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const uiErrors: string[] = [];
page.on('pageerror', (e) => uiErrors.push(e.message));
mkdirSync('test-results', { recursive: true });
const output = mkdtempSync(join(tmpdir(), 'webprobe-ci-reports-'));
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const r = await fetch('http://127.0.0.1:4199/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
async function waitRelease(id: string) {
  const until = Date.now() + 240000;
  while (Date.now() < until) {
    const r = (await api('/releases/' + id)) as Release;
    if (!['checking', 'waiting_runner'].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('发布超时');
}
async function cli(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/server/src/release-cli.ts', ...args],
      {
        env: {
          ...process.env,
          WEBPROBE_URL: 'http://127.0.0.1:4199',
          AI_API_KEY: '',
          WEBPROBE_API_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const timeout = setTimeout(() => {
      processChild.kill('SIGKILL');
      reject(new Error('CLI timeout\n' + output));
    }, 240000);
    processChild.stdout.on('data', (data) => {
      output += data.toString();
    });
    processChild.stderr.on('data', (data) => {
      output += data.toString();
    });
    processChild.on('error', reject);
    processChild.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}
try {
  const project = await api('/projects', {
    name: 'V3 发布验证',
    environments: [
      { id: 'preview', name: '预览环境', url: target, kind: 'preview', protected: false },
      { id: 'production', name: '生产环境', url: candidate, kind: 'production', protected: true },
    ],
  });
  const testcase = await api('/test-cases', {
    projectId: project.id,
    name: '关键按钮不抛错',
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'click', target: { by: 'testId', value: 'feature' } },
      { action: 'assertNoErrors' },
    ],
  });
  const policy = {
    projectId: project.id,
    environmentId: 'preview',
    name: '受控集成测试标准',
    samples: 1,
    minPerformance: 0,
    maxLcp: 30000,
    maxCls: 1,
    maxTbt: 30000,
    maxCritical: 1000,
    maxNewIssues: 1000,
    maxLcpRegressionPct: 1000,
    requireTests: true,
    caseIds: [testcase.id],
    allowInteractions: true,
  };
  await api('/release-policies', { policy, expectedRevision: 0 }, 'PUT');
  await api(
    '/release-policies',
    { policy: { ...policy, environmentId: 'production' }, expectedRevision: 0 },
    'PUT',
  );
  const broken = await api('/releases', {
    projectId: project.id,
    environmentId: 'preview',
    version: 'v3-broken',
    commit: 'abcdef1',
  });
  await api(`/releases/${broken.id}/check`, {});
  const rejected = await waitRelease(broken.id);
  assert.equal(rejected.status, 'blocked');
  assert.ok(rejected.evaluation!.checks.some((c) => c.id === 'test-pass' && c.status === 'failed'));
  const badCli = await cli(['status', '--release', broken.id, '--output', join(output, 'blocked')]);
  assert.equal(badCli.code, 1, badCli.output);
  assert.match(await readFile(join(output, 'blocked', 'junit.xml'), 'utf8'), /<failure/);
  console.log('PASS 真实回归失败阻断发布，CI 退出 1 和 JUnit 失败证据');
  fixture.fix();
  candidateFixture.fix();
  const base = await api('/releases', {
    projectId: project.id,
    environmentId: 'preview',
    version: 'v3-baseline',
    commit: 'abcdef2',
  });
  await api(`/releases/${base.id}/check`, {});
  const baseline = await waitRelease(base.id);
  assert.equal(baseline.status, 'ready', JSON.stringify(baseline.evaluation));
  const scansBefore = (await api('/scans')).length;
  const local = await cli([
    'check',
    '--project',
    project.id,
    '--environment',
    'preview',
    '--version',
    'v3-candidate',
    '--commit',
    'abcdef3',
    '--target',
    candidate,
    '--baseline',
    base.id,
    '--mode',
    'local',
    '--allow-private-network',
    '--output',
    join(output, 'local'),
  ]);
  assert.equal(local.code, 1, local.output);
  const localReport = JSON.parse(
    await readFile(join(output, 'local', 'release.json'), 'utf8'),
  ) as Release;
  assert.equal(localReport.evidence!.source, 'local-runner');
  assert.ok(localReport.evidence!.artifacts.length > 0);
  assert.equal((await api('/scans')).length, scansBefore);
  assert.ok(
    localReport.evaluation!.checks.some((c) => c.id === 'source' && c.status === 'blocked'),
  );
  console.log('PASS Local Runner 真实执行、证据附件回传、隔离数据及默认来源阻断');
  const currentPolicy = await api(
    `/release-policies?projectId=${project.id}&environmentId=preview`,
  );
  const { id, revision, updatedAt, ...input } = currentPolicy;
  await api(
    '/release-policies',
    { policy: { ...input, allowRunnerEvidence: true }, expectedRevision: revision },
    'PUT',
  );
  const ready = (await api(`/releases/${localReport.id}/evaluate`, {
    refreshPolicy: true,
  })) as Release;
  assert.equal(ready.status, 'ready', JSON.stringify(ready.evaluation));
  assert.equal(ready.evaluation!.comparison!.compatible, true);
  assert.ok(ready.evaluation!.comparison!.metrics.length);
  const goodCli = await cli(['status', '--release', ready.id, '--output', join(output, 'ready')]);
  assert.equal(goodCli.code, 0, goodCli.output);
  console.log('PASS 明确信任 Runner 后准入通过、跨 URL 版本比较、CI 退出 0');
  const next = await api(`/releases/${ready.id}/promote`, { environmentId: 'production' });
  assert.equal(next.parentReleaseId, ready.id);
  assert.equal(next.commit, ready.commit);
  assert.equal(next.evidence, undefined);
  await api(`/releases/${next.id}/check`, {});
  const production = await waitRelease(next.id);
  assert.equal(production.status, 'awaiting_approval', JSON.stringify(production.evaluation));
  const approvalCli = await cli([
    'status',
    '--release',
    production.id,
    '--output',
    join(output, 'approval'),
  ]);
  assert.equal(approvalCli.code, 3);
  await api(`/releases/${production.id}/approve`, {
    actor: '集成验收',
    note: '已查看真实采样和回归证据',
  });
  const wrong = await fetch(`http://127.0.0.1:4199/api/releases/${production.id}/deployments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: 'fffffff', actor: 'CI', url: candidate, source: 'ci' }),
  });
  assert.equal(wrong.status, 409);
  const deployment = await cli([
    'deploy',
    '--release',
    production.id,
    '--commit',
    production.commit,
    '--deployment-url',
    candidate,
    '--actor',
    'CI-fixture',
    '--output',
    join(output, 'deployed'),
  ]);
  assert.equal(deployment.code, 0, deployment.output);
  assert.equal((await api('/releases/' + production.id)).status, 'deployed');
  console.log('PASS 环境晋级重新检测、人工审批、Commit 校验和部署登记');
  await page.goto('http://127.0.0.1:4199/releases');
  await page.getByRole('heading', { name: '让每次上线，都有质量依据。' }).waitFor();
  await page.getByRole('button', { name: /质量策略/ }).click();
  await page.getByRole('heading', { name: /发布质量策略/ }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({
    path: 'test-results/v3-release-center.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('http://127.0.0.1:4199/releases/' + ready.id);
  await page.getByRole('button', { name: '版本对比', exact: true }).click();
  await page.getByRole('heading', { name: '与固定基线比较' }).waitFor();
  await page.screenshot({
    path: 'test-results/v3-release-comparison.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('http://127.0.0.1:4199/environments');
  await page.getByRole('heading', { name: '从开发到生产，清楚每一站。' }).waitFor();
  await page.getByRole('button', { name: '管理环境' }).click();
  await page.getByRole('heading', { name: '管理项目环境' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4199/releases/' + production.id);
  await page.getByRole('heading', { name: '部署结果已由调用方登记' }).waitFor();
  await page.screenshot({
    path: 'test-results/v3-release-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(uiErrors, []);
  console.log('PASS 发布中心、策略、版本对比、环境管理、移动端无溢出及无 UI 异常');
  const running = await api('/releases', {
    projectId: project.id,
    environmentId: 'preview',
    version: 'v3-cancel',
    commit: 'abcdef4',
  });
  await api(`/releases/${running.id}/check`, {});
  await api(`/releases/${running.id}/cancel`, {});
  assert.equal((await waitRelease(running.id)).status, 'cancelled');
  const bundle = await fetch(`http://127.0.0.1:4199/api/releases/${ready.id}/export?format=bundle`);
  assert.ok((await bundle.arrayBuffer()).byteLength > 10000);
  console.log('PASS 取消、发布报告包与证据闭环');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  for (const f of [fixture, candidateFixture]) {
    f.server.closeAllConnections();
    await new Promise<void>((r) => f.server.close(() => r()));
  }
}
