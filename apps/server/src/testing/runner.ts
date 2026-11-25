import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  testCaseSchema,
  type TestCaseInput,
  type TestCase,
  type TestRunConfig,
  type TestRun,
  type CaseResult,
  type TestStep,
} from '../../../../packages/shared/src/testing.js';
import type { Issue } from '../../../../packages/shared/src/index.js';
import { all, get, put, uid, now, dataDir } from '../store.js';
import {
  browserSession,
  environment,
  scopedUrl,
  locatorFor,
  checkAction,
  sensitive,
} from './browser.js';
import { artifactFile, visualCheckpoint } from './visual.js';
import { resolve } from 'node:path';
export function saveCase(input: TestCaseInput, origin: TestCase['origin'] = 'manual', id?: string) {
  const data = testCaseSchema.parse(input);
  for (const step of data.steps)
    if (
      ['fill', 'select'].includes(step.action) &&
      'target' in step &&
      sensitive.test(step.target.value + ' ' + (step.target.name || ''))
    )
      throw new Error('用例不能保存敏感字段');
  const old = id ? get<TestCase>('testCase', id) : undefined;
  if (id && !old) throw new Error('用例不存在');
  if (old && old.projectId !== data.projectId) throw new Error('不能移动用例到其他项目');
  if (!all<{ id: string }>('project').some((p) => p.id === data.projectId))
    throw new Error('项目不存在');
  const item: TestCase = {
    ...data,
    id: old?.id || uid(),
    origin: old?.origin || origin,
    revision: (old?.revision || 0) + 1,
    archived: false,
    createdAt: old?.createdAt || now(),
    updatedAt: now(),
  };
  put('testRevision', { ...item, id: `${item.id}:${item.revision}`, caseId: item.id });
  return put('testCase', item);
}
export function playwrightSource(test: TestCase) {
  const q = (s: string) => JSON.stringify(s);
  const loc = (t: import('../../../../packages/shared/src/testing.js').Target) =>
    t.by === 'css'
      ? `page.locator(${q(t.value)})`
      : t.by === 'role'
        ? `page.getByRole(${q(t.value)}${t.name ? `, { name: ${q(t.name)}, exact: true }` : ''})`
        : `page.${({ testId: 'getByTestId', label: 'getByLabel', text: 'getByText' } as const)[t.by]}(${q(t.value)})`;
  const lines = test.steps.map((s) => {
    switch (s.action) {
      case 'navigate':
        return `await page.goto(${q(s.path)});`;
      case 'click':
        return `await ${loc(s.target)}.click();`;
      case 'fill':
        return `await ${loc(s.target)}.fill(${q(s.value)});`;
      case 'select':
        return `await ${loc(s.target)}.selectOption(${q(s.value)});`;
      case 'check':
        return `await ${loc(s.target)}.setChecked(${s.checked});`;
      case 'press':
        return `await ${loc(s.target)}.press(${q(s.key)});`;
      case 'assertVisible':
        return `await expect(${loc(s.target)}).toBeVisible();`;
      case 'assertHidden':
        return `await expect(${loc(s.target)}).toBeHidden();`;
      case 'assertText':
        return `await expect(${loc(s.target)}).toContainText(${q(s.text)});`;
      case 'assertUrl':
        return `await expect(page).toHaveURL(new URL(${q(s.path)}, process.env.TEST_BASE_URL!).href);`;
      case 'assertNoErrors':
        return 'expect(runtimeErrors).toEqual([]);';
      case 'visual':
        return `await expect(page).toHaveScreenshot(${q(s.name + '.png')}, { maxDiffPixelRatio: ${s.maxDiffRatio}, mask: [${s.masks.map((m) => `page.locator(${q(m)})`).join(', ')}] });`;
    }
  });
  return `// WebProbe ${test.id} revision ${test.revision}\n// Run in your trusted Playwright project. Set TEST_BASE_URL and review interactions.\nimport { test, expect } from '@playwright/test';\ntest.use({ baseURL: process.env.TEST_BASE_URL });\ntest(${q(test.name)}, async ({ page }) => {\n  const runtimeErrors: string[] = [];\n  page.on('pageerror', e => runtimeErrors.push(e.message));\n  page.on('response', r => { if (r.status() >= 400) runtimeErrors.push(r.status() + ' ' + r.url()); });\n${lines.map((l) => '  ' + l).join('\n')}\n});\n`;
}
const queue: string[] = [];
let working = false;
const controls = new Map<string, AbortController>();
export function queueRun(
  config: TestRunConfig,
  snapshot?: {
    project: import('../../../../packages/shared/src/index.js').Project;
    cases: TestCase[];
    releaseId: string;
  },
) {
  if (all<TestRun>('testRun').filter((r) => ['queued', 'running'].includes(r.status)).length >= 20)
    throw new Error('测试队列已满');
  if (!snapshot) environment(config.projectId, config.environmentId);
  const cases =
    snapshot?.cases || [...new Set(config.caseIds)].map((id) => get<TestCase>('testCase', id));
  if (cases.some((c) => !c || c.archived || c.projectId !== config.projectId))
    throw new Error('用例不存在、已归档或不属于当前项目');
  const run: TestRun = {
    ...config,
    ...(snapshot ? { projectSnapshot: snapshot.project, releaseId: snapshot.releaseId } : {}),
    browsers: [...new Set(config.browsers)],
    devices: [...new Set(config.devices)],
    id: uid(),
    cases: cases as TestCase[],
    results: [],
    status: 'queued',
    createdAt: now(),
    progress: 0,
    stage: '等待执行',
  };
  put('testRun', run);
  queue.push(run.id);
  void pump();
  return run;
}
export function cancelRun(id: string) {
  const run = get<TestRun>('testRun', id);
  if (!run || !['queued', 'running'].includes(run.status)) return false;
  put('testRun', { ...run, status: 'cancelled', stage: '已取消', completedAt: now() });
  controls.get(id)?.abort();
  return true;
}
async function pump() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const run = get<TestRun>('testRun', queue.shift()!);
      if (run?.status === 'queued') await executeRun(run);
    }
  } finally {
    working = false;
  }
}
export async function executeCase(
  run: TestRun,
  test: TestCase,
  browser: CaseResult['browser'],
  device: CaseResult['device'],
  signal: AbortSignal,
): Promise<CaseResult> {
  const start = Date.now(),
    result: CaseResult = {
      id: uid(),
      testCase: test,
      browser,
      device,
      status: 'passed',
      steps: [],
      errors: [],
      duration: 0,
    };
  const base = (
    run.projectSnapshot?.environments.find((e) => e.id === run.environmentId) ||
    environment(run.projectId, run.environmentId)
  ).url;
  await mkdir(resolve(dataDir, 'artifacts', run.id), { recursive: true });
  let session: Awaited<ReturnType<typeof browserSession>> | undefined;
  let tracing = false;
  try {
    session = await browserSession({
      url: base,
      browser,
      device,
      allowWrites: run.allowWrites,
      signal,
    });
    const { page, context } = session;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    tracing = true;
    page.on('pageerror', (e) => {
      if (result.errors.length < 50) result.errors.push(`JS: ${e.message.slice(0, 2000)}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && result.errors.length < 50)
        result.errors.push(`HTTP ${r.status()}: ${r.url().slice(0, 1000)}`);
    });
    for (let i = 0; i < test.steps.length; i++) {
      if (signal.aborted) throw new Error('任务已取消');
      const step = test.steps[i],
        started = Date.now();
      try {
        await checkAction(page, step, base, run.allowInteractions);
        switch (step.action) {
          case 'navigate': {
            const r = await page.goto(scopedUrl(step.path, base), {
              waitUntil: 'domcontentloaded',
            });
            if (!r || r.status() >= 400) throw new Error(`页面访问失败 HTTP ${r?.status()}`);
            break;
          }
          case 'click':
            await locatorFor(page, step.target).click();
            break;
          case 'fill':
            await locatorFor(page, step.target).fill(step.value);
            break;
          case 'select':
            await locatorFor(page, step.target).selectOption(step.value);
            break;
          case 'check':
            await locatorFor(page, step.target).setChecked(step.checked);
            break;
          case 'press':
            await locatorFor(page, step.target).press(step.key);
            break;
          case 'assertVisible':
            await locatorFor(page, step.target).waitFor({ state: 'visible' });
            break;
          case 'assertHidden':
            await locatorFor(page, step.target).waitFor({ state: 'hidden' });
            break;
          case 'assertText':
            await retry(async () => {
              if (!(await locatorFor(page, step.target).innerText()).includes(step.text))
                throw new Error(`文本断言失败：预期包含 ${step.text}`);
            });
            break;
          case 'assertUrl':
            await page.waitForURL(scopedUrl(step.path, base));
            break;
          case 'assertNoErrors':
            await page.waitForTimeout(350);
            if (session.blockedRequests.length)
              throw new Error('请求被检测策略阻止：' + session.blockedRequests.join(', '));
            if (result.errors.length) throw new Error(`运行异常：${result.errors.join('\n')}`);
            break;
          case 'visual': {
            const visual = await visualCheckpoint(
              page,
              run,
              test,
              browser,
              device,
              step,
              result.id,
            );
            result.steps.push({
              index: i,
              action: step.action,
              status: visual.status === 'failed' ? 'failed' : 'passed',
              duration: Date.now() - started,
              visual,
            });
            if (visual.status === 'failed') {
              result.status = 'failed';
              result.error = `视觉差异超过阈值：${step.name}`;
              result.failureSignature = `visual:${step.name}`;
            } else if (visual.status === 'needs_baseline' && result.status === 'passed')
              result.status = 'needs_baseline';
            continue;
          }
        }
        if (['navigate', 'click', 'press', 'select', 'check'].includes(step.action))
          await page.waitForTimeout(200);
        result.steps.push({
          index: i,
          action: step.action,
          status: 'passed',
          duration: Date.now() - started,
        });
      } catch (error) {
        const message = String((error as Error).message).slice(0, 6000);
        const blocked =
          session.blockedRequests.length > 0 ||
          /需要启用|危险业务|敏感字段|不允许站外|定位目标必须唯一|检测策略阻止/.test(message);
        result.status = blocked ? 'blocked' : 'failed';
        result.error = message;
        result.failureSignature = createHash('sha256')
          .update(
            [
              test.id,
              test.revision,
              i,
              step.action,
              message.split('\n')[0].replace(/\d+ms/g, 'timeout'),
            ].join('|'),
          )
          .digest('hex')
          .slice(0, 24);
        result.steps.push({
          index: i,
          action: step.action,
          status: blocked ? 'blocked' : 'failed',
          duration: Date.now() - started,
          error: message,
        });
        break;
      }
    }
    result.screenshot = `/artifacts/${run.id}/${result.id}.png`;
    await page
      .screenshot({ path: artifactFile(result.screenshot), animations: 'disabled', timeout: 7000 })
      .catch(() => {
        result.screenshot = undefined;
      });
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'blocked';
    result.error = (error as Error).message;
  } finally {
    if (session) {
      if (tracing) {
        const trace = `/artifacts/${run.id}/${result.id}.trace.zip`;
        try {
          await session.context.tracing.stop({ path: artifactFile(trace) });
          result.trace = trace;
        } catch {}
      }
      await session.close();
    }
    result.duration = Date.now() - start;
  }
  return result;
}
async function retry(check: () => Promise<void>) {
  let last: unknown;
  const until = Date.now() + 7000;
  do {
    try {
      return await check();
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < until);
  throw last;
}
export function updateTestIssue(run: TestRun, result: CaseResult, confirmed = false) {
  const previous = all<Issue>('issue').filter(
    (i) =>
      i.source === 'functional' &&
      i.projectId === run.projectId &&
      i.environmentId === run.environmentId &&
      i.testCaseId === result.testCase.id &&
      i.testRevision === result.testCase.revision &&
      i.browser === result.browser &&
      i.device === result.device,
  );
  if (result.status === 'passed') {
    for (const i of previous)
      if (i.status !== 'ignored') put('issue', { ...i, status: 'resolved' });
    return;
  }
  if (result.status !== 'failed') return;
  const key = createHash('sha256')
    .update(
      [
        run.projectId,
        run.environmentId,
        result.testCase.id,
        result.testCase.revision,
        result.browser,
        result.device,
        result.failureSignature,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 24);
  const old = previous.find((i) => i.fingerprint === key);
  const sameRun = old?.lastTestRunId === run.id;
  const item: Issue = {
    id: old?.id || uid(),
    fingerprint: key,
    rule: 'functional-test',
    source: 'functional',
    title: `功能测试失败：${result.testCase.name}`,
    severity: 'P1',
    url: scopedUrl(
      result.testCase.steps[0].action === 'navigate' ? result.testCase.steps[0].path : '/',
      (
        run.projectSnapshot?.environments.find((e) => e.id === run.environmentId) ||
        environment(run.projectId, run.environmentId)
      ).url,
    ),
    browser: result.browser,
    device: result.device,
    evidence: JSON.stringify(
      {
        testCaseId: result.testCase.id,
        revision: result.testCase.revision,
        steps: result.testCase.steps,
        failedStep: result.steps.find((s) => s.status === 'failed'),
        errors: result.errors,
        trace: result.trace,
      },
      null,
      2,
    ),
    recommendation: '按保存的步骤和浏览器设备重放，核实显式断言后修复实际业务实现。',
    certainty:
      confirmed || old?.certainty === 'confirmed' || (old && !sameRun) ? 'confirmed' : 'suspected',
    screenshot: result.screenshot,
    projectId: run.projectId,
    environmentId: run.environmentId,
    status: old?.status === 'resolved' ? 'open' : old?.status || 'open',
    firstSeen: old?.firstSeen || run.createdAt,
    lastSeen: now(),
    occurrences: (old?.occurrences || 0) + (sameRun ? 0 : 1),
    lastScanId: '',
    lastTestRunId: run.id,
    testCaseId: result.testCase.id,
    testRevision: result.testCase.revision,
  };
  put('issue', item);
  result.issueId = item.id;
}
async function executeRun(run: TestRun) {
  const controller = new AbortController();
  controls.set(run.id, controller);
  const timer = setTimeout(() => controller.abort(), 900000);
  try {
    run.status = 'running';
    put('testRun', run);
    for (const test of run.cases)
      for (const b of run.browsers)
        for (const d of run.devices) {
          if (controller.signal.aborted) throw new Error('执行已中止');
          run.stage = `${test.name} · ${b} / ${d}`;
          put('testRun', run);
          const result = await executeCase(run, test, b, d, controller.signal);
          run.results.push(result);
          if (controller.signal.aborted) throw new Error('执行已中止');
          updateTestIssue(run, result);
          run.progress = Math.round(
            (run.results.length / (run.cases.length * run.browsers.length * run.devices.length)) *
              100,
          );
          put('testRun', run);
        }
    run.status = run.results.some((r) => ['failed', 'blocked'].includes(r.status))
      ? 'failed'
      : run.results.some((r) => r.status === 'needs_baseline')
        ? 'needs_baseline'
        : 'passed';
    run.stage = '执行完成';
  } catch (e) {
    run.status = get<TestRun>('testRun', run.id)?.status === 'cancelled' ? 'cancelled' : 'failed';
    run.error = (e as Error).message;
  } finally {
    run.completedAt = now();
    put('testRun', run);
    controls.delete(run.id);
    clearTimeout(timer);
  }
}
