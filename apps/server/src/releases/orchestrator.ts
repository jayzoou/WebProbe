import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { all, get, put, now } from '../store.js';
import { enqueue, createScan, cancelScan } from '../scanner.js';
import { queueRun, cancelRun } from '../testing/runner.js';
import { artifactFile } from '../testing/visual.js';
import type { Release, ReleaseEvidence } from '../../../../packages/shared/src/releases.js';
import type { Scan } from '../../../../packages/shared/src/index.js';
import type { TestRun } from '../../../../packages/shared/src/testing.js';
import { scanEvidence, testEvidence } from './evaluator.js';
import { required, beginAttempt, event, evaluateRelease, ReleaseError } from './service.js';
const running = new Map<string, AbortController>();
export function startChecks(id: string) {
  if (running.size >= 2) throw new ReleaseError('发布验证资源已满，请稍后重试', 429);
  const release = beginAttempt(required<Release>('release', id));
  const control = new AbortController();
  running.set(id, control);
  void perform(release, control);
  event(id, 'checks-started', `平台检测开始 · 第 ${release.attempt} 次`);
  return release;
}
export function cancelRelease(id: string) {
  const r = required<Release>('release', id);
  if (!['checking', 'waiting_runner'].includes(r.status))
    throw new ReleaseError('没有可取消的活动任务', 409);
  put('release', { ...r, status: 'cancelled', stage: '已取消质量验证' });
  if (r.activeScanId) cancelScan(r.activeScanId);
  if (r.activeTestRunId) cancelRun(r.activeTestRunId);
  if (r.runnerJobId) {
    const j = get<{ id: string }>('runnerJob', r.runnerJobId);
    if (j) put('runnerJob', { ...j, status: 'cancelled' });
  }
  running.get(id)?.abort();
  event(id, 'cancelled', '取消验证；未完成证据不参与发布通过');
  return required<Release>('release', id);
}
async function waitRecord<T extends { status: string }>(
  kind: string,
  id: string,
  signal: AbortSignal,
): Promise<T> {
  while (true) {
    if (signal.aborted) throw new Error('验证已取消或超时');
    const value = required<T>(kind, id);
    if (!['queued', 'running'].includes(value.status)) return value;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 400);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
async function perform(r: Release, control: AbortController) {
  const timer = setTimeout(() => control.abort(), 900000);
  const scans: Scan[] = [],
    artifacts: ReleaseEvidence['artifacts'] = [];
  let tests: TestRun | undefined;
  const sync = () => {
    const old = required<Release>('release', r.id);
    if (old.status === 'cancelled') throw new Error('验证已取消');
    put('release', r);
  };
  try {
    for (let i = 0; i < r.policy.samples; i++) {
      if (control.signal.aborted) throw new Error('验证超时');
      const scan = createScan({
        projectId: r.projectId,
        environmentId: r.environmentId,
        release: r.version,
        browsers: r.policy.browsers,
        devices: r.policy.devices,
        maxPages: r.policy.maxPages,
        paths: r.policy.paths,
        lighthouse: true,
      });
      scan.projectSnapshot = r.projectSnapshot;
      scan.releaseId = r.id;
      r.activeScanId = scan.id;
      r.stage = `性能及页面质量采样 ${i + 1}/${r.policy.samples}`;
      sync();
      enqueue(scan);
      const result = await waitRecord<Scan>('scan', scan.id, control.signal);
      scans.push(result);
      r.progress = Math.round(((i + 1) / (r.policy.samples + 1)) * 80);
      sync();
      if (result.status !== 'completed') break;
    }
    if (control.signal.aborted) throw new Error('验证超时');
    if (r.policy.requireTests && r.cases.length) {
      r.stage = '执行固定版本的回归用例';
      sync();
      const run = queueRun(
        {
          projectId: r.projectId,
          environmentId: r.environmentId,
          caseIds: r.cases.map((c) => c.id),
          browsers: r.policy.browsers,
          devices: r.policy.devices,
          allowInteractions: r.policy.allowInteractions,
          allowWrites: r.policy.allowWrites,
          release: r.version,
        },
        { project: r.projectSnapshot, cases: r.cases, releaseId: r.id },
      );
      r.activeTestRunId = run.id;
      sync();
      tests = await waitRecord<TestRun>('testRun', run.id, control.signal);
    }
    const paths = new Set(
      [
        ...scans.flatMap((s) =>
          s.pages.flatMap((p) => [
            p.screenshot,
            p.lighthouseReport,
            p.lighthouseReport?.replace(/\.html$/, '.json'),
          ]),
        ),
        ...(tests?.results.flatMap((t) => [
          t.screenshot,
          t.trace,
          ...t.steps.flatMap((s) => [s.visual?.current, s.visual?.baseline, s.visual?.diff]),
        ]) || []),
      ].filter((p): p is string => !!p),
    );
    for (const url of paths)
      try {
        const file = await stat(artifactFile(url));
        artifacts.push({ name: url.split('/').pop()!, url, bytes: file.size });
      } catch {}
    if (control.signal.aborted) throw new Error('验证已中止');
    r.evidence = {
      id: randomUUID(),
      source: 'platform',
      profileHash: r.profileHash,
      scans: scans.map(scanEvidence),
      tests: tests ? testEvidence(tests) : undefined,
      receivedAt: now(),
      artifacts,
    };
    r.status = 'draft';
    r.stage = '生成发布准入结论';
    sync();
    evaluateRelease(r.id);
  } catch (error) {
    const latest = required<Release>('release', r.id);
    if (latest.status !== 'cancelled') {
      if (r.activeScanId) cancelScan(r.activeScanId);
      if (r.activeTestRunId) cancelRun(r.activeTestRunId);
      put('release', {
        ...r,
        status: 'blocked',
        error: (error as Error).message,
        stage: '验证未完整完成',
      });
      event(r.id, 'checks-failed', (error as Error).message);
    }
  } finally {
    clearTimeout(timer);
    running.delete(r.id);
  }
}
