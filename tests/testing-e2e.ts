import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createTestingFixture } from '../fixtures/testing-site.js';
import type { TestRun, Exploration, Recording } from '../packages/shared/src/testing.js';
import type { Issue } from '../packages/shared/src/index.js';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '4189';
process.env.ALLOW_PRIVATE_NETWORK = 'true';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-v2-e2e-'));
const { app } = await import('../apps/server/src/index.js');
const { all, get } = await import('../apps/server/src/store.js');
const { startRecording, recordingPage, stopRecording } =
  await import('../apps/server/src/testing/recorder.js');
const fixture = createTestingFixture();
await new Promise<void>((r) => fixture.server.listen(0, '127.0.0.1', r));
const port = (fixture.server.address() as { port: number }).port;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4189 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
mkdirSync('test-results', { recursive: true });
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const r = await fetch('http://127.0.0.1:4189/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
async function waitRun(id: string) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const r = (await api('/test-runs/' + id)) as TestRun;
    if (!['queued', 'running'].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('测试执行超时');
}
try {
  const project = await api('/projects', {
    name: 'V2 交互验证',
    environments: [{ id: 'preview', name: '预览', url: `http://127.0.0.1:${port}/` }],
  });
  const base = { projectId: project.id, environmentId: 'preview' };
  const generated = await api('/test-cases/generate', {
    ...base,
    path: '/',
    goal: '在“搜索”中输入“Vue”；点击“查找”；显示“结果列表”；无运行异常',
  });
  assert.equal(generated.provider, 'rules');
  assert.ok(generated.draft.steps.some((s: any) => s.action === 'fill'));
  console.log('PASS 基于真实 DOM 的自然语言规则草稿');
  process.env.AI_API_KEY = 'isolated-model-test';
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/model`;
  const ai = await api('/test-cases/generate', {
    ...base,
    path: '/',
    goal: '搜索 Vue 后应该展示结果',
  });
  assert.equal(ai.provider, 'ai');
  const aiCase = await api('/test-cases?draftId=' + ai.draftId, ai.draft);
  assert.equal(aiCase.origin, 'ai');
  fixture.modelMode('invalid');
  let bad = await fetch('http://127.0.0.1:4189/api/test-cases/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, path: '/', goal: '搜索功能' }),
  });
  assert.equal(bad.status, 400);
  fixture.modelMode('failure');
  bad = await fetch('http://127.0.0.1:4189/api/test-cases/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, path: '/', goal: '搜索功能' }),
  });
  assert.equal(bad.status, 500);
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  console.log('PASS 隔离模型的 AI 草稿、来源保存、非法输出与服务错误');

  const test = await api('/test-cases', {
    projectId: project.id,
    name: '运行功能不能报错',
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'click', target: { by: 'testId', value: 'feature' } },
      { action: 'assertNoErrors' },
    ],
  });
  const config = {
    ...base,
    caseIds: [test.id],
    browsers: ['chromium', 'firefox', 'webkit'],
    devices: ['desktop'],
    allowInteractions: true,
  };
  const failed = await waitRun((await api('/test-runs', config)).id);
  assert.equal(failed.status, 'failed');
  assert.ok(
    failed.results.every(
      (r) =>
        r.status === 'failed' &&
        r.errors.some((e) => e.includes('reproducible-feature-bug')) &&
        r.trace &&
        r.screenshot,
    ),
  );
  console.log('PASS 三浏览器真实功能缺陷执行与证据');
  const blocked = await waitRun(
    (await api('/test-runs', { ...base, caseIds: [test.id], allowInteractions: false })).id,
  );
  assert.equal(blocked.results[0].status, 'blocked');
  const writeCase = await api('/test-cases', {
    projectId: project.id,
    name: '请求策略边界',
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'click', target: { by: 'testId', value: 'write' } },
      { action: 'assertNoErrors' },
    ],
  });
  const noWrite = await waitRun(
    (
      await api('/test-runs', {
        ...base,
        caseIds: [writeCase.id],
        allowInteractions: true,
        allowWrites: false,
      })
    ).id,
  );
  assert.equal(noWrite.results[0].status, 'blocked');
  assert.equal(fixture.writes(), 0);
  assert.ok(!all<Issue>('issue').some((i) => i.testCaseId === writeCase.id));
  const allowedWrite = await waitRun(
    (
      await api('/test-runs', {
        ...base,
        caseIds: [writeCase.id],
        allowInteractions: true,
        allowWrites: true,
      })
    ).id,
  );
  assert.equal(allowedWrite.status, 'passed');
  assert.equal(fixture.writes(), 1);
  console.log('PASS 交互授权、写请求边界及受阻不误报功能缺陷');

  const explore = await api('/explorations', {
    ...base,
    path: '/',
    maxActions: 4,
    allowInteractions: true,
  });
  const until = Date.now() + 90000;
  let exploration: Exploration;
  do {
    exploration = (await api('/explorations')).find((e: Exploration) => e.id === explore.id);
    if (!['queued', 'running'].includes(exploration.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < until);
  assert.equal(exploration!.status, 'completed', exploration!.error);
  assert.ok(exploration!.discoveries.some((d) => d.reproduced));
  assert.ok(
    all<Issue>('issue').some((i) => i.source === 'functional' && i.certainty === 'confirmed'),
  );
  console.log('PASS 页面探索、自动保存复现用例和再次重放确认');
  fixture.fix();
  const passed = await waitRun((await api('/test-runs', config)).id);
  assert.equal(passed.status, 'passed', JSON.stringify(passed.results));
  assert.ok(
    all<Issue>('issue')
      .filter((i) => i.testCaseId === test.id)
      .every((i) => i.status === 'resolved'),
  );
  console.log('PASS 功能修复回归与问题状态验证');
  const rec = await startRecording(
    { ...base, path: '/', name: '录制搜索', allowWrites: false },
    true,
  );
  const rp = recordingPage(rec.id)!;
  await rp.getByTestId('query').fill('Vue');
  await rp.getByTestId('search').click();
  await rp.getByTestId('color').selectOption('blue');
  await rp.getByTestId('remember').check();
  await rp.getByTestId('password').fill('never-store-this');
  await rp.getByTestId('query').click();
  await rp.waitForTimeout(200);
  const saved = await stopRecording(rec.id, true);
  assert.equal(saved.status, 'saved');
  assert.ok(saved.steps.some((s) => s.action === 'fill' && s.value === 'Vue'));
  assert.ok(!JSON.stringify(saved).includes('never-store-this'));
  const replay = await waitRun(
    (await api('/test-runs', { ...base, caseIds: [saved.caseId], allowInteractions: true })).id,
  );
  assert.equal(replay.status, 'passed', JSON.stringify(replay.results));
  console.log('PASS 真实操作录制、敏感输入省略及用例重放');
  const visual = await api('/test-cases', {
    projectId: project.id,
    name: '首页视觉',
    steps: [
      { action: 'navigate', path: '/' },
      { action: 'visual', name: 'home', maxDiffRatio: 0.001, masks: [] },
    ],
  });
  const vconfig = { ...base, caseIds: [visual.id] };
  const first = await waitRun((await api('/test-runs', vconfig)).id);
  assert.equal(first.status, 'needs_baseline');
  await api(`/test-runs/${first.id}/baselines`, { resultId: first.results[0].id, name: 'home' });
  const equal = await waitRun((await api('/test-runs', vconfig)).id);
  assert.equal(equal.status, 'passed');
  fixture.changeVisual();
  const diff = await waitRun((await api('/test-runs', vconfig)).id);
  assert.equal(diff.status, 'failed');
  assert.ok(diff.results[0].steps.find((s) => s.visual)?.visual?.diffRatio! > 0.1);
  console.log('PASS 显式基线审批、相同截图通过及真实视觉差异');
  await page.goto('http://127.0.0.1:4189/testing');
  await page.getByRole('button', { name: '创建用例', exact: true }).waitFor();
  await page.screenshot({
    path: 'test-results/v2-testing-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '创建用例', exact: true }).click();
  await page.getByRole('heading', { name: '创建测试用例' }).waitFor();
  await page.getByPlaceholder('例如：搜索结果应正常展示').fill('从界面创建的测试');
  await page.getByRole('button', { name: '保存用例' }).click();
  await page.getByText('测试用例已保存', { exact: true }).waitFor();
  console.log('PASS V2 用例编辑界面');
  await page.goto(`http://127.0.0.1:4189/testing/runs/${diff.id}`);
  await page.getByText('像素差异', { exact: true }).waitFor();
  await page.screenshot({
    path: 'test-results/v2-visual-diff.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4189/testing');
  await page.getByRole('button', { name: '创建用例', exact: true }).waitFor();
  await page.screenshot({
    path: 'test-results/v2-testing-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS 视觉证据界面与移动适配');
  const bundle = await fetch(
    `http://127.0.0.1:4189/api/test-runs/${failed.id}/export?format=bundle`,
  );
  assert.ok((await bundle.arrayBuffer()).byteLength > 10000);
  const slow = await api('/test-cases', {
    projectId: project.id,
    name: '取消用例',
    steps: [{ action: 'navigate', path: '/slow' }, { action: 'assertNoErrors' }],
  });
  const pending = await api('/test-runs', { ...base, caseIds: [slow.id] });
  await new Promise((r) => setTimeout(r, 400));
  await api(`/test-runs/${pending.id}/cancel`, {});
  assert.equal((await waitRun(pending.id)).status, 'cancelled');
  console.log('PASS 执行取消与复现包导出');
} finally {
  for (const r of all<Recording>('recording'))
    if (r.status === 'recording') await stopRecording(r.id, false);
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  fixture.server.closeAllConnections();
  await new Promise<void>((r) => fixture.server.close(() => r()));
}
