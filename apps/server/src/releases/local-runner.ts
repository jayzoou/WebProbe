import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RunnerJob, Release, Submission } from '../../../../packages/shared/src/releases.js';
import type { Scan } from '../../../../packages/shared/src/index.js';
import type { TestRun } from '../../../../packages/shared/src/testing.js';
export type RunnerClient = (path: string, body?: unknown, method?: string) => Promise<any>;
export async function runLocalJob(
  client: RunnerClient,
  jobId: string,
  output: string,
  downloadBaseline: (id: string) => Promise<Buffer>,
  progress: (s: string) => void = () => {},
) {
  if ((globalThis as Record<symbol, unknown>)[Symbol.for('webprobe.store.directory')])
    throw new Error('Local Runner 必须在独立进程中执行，不能复用平台数据库进程');
  const job = (await client(`/runner-jobs/${jobId}`)) as Omit<RunnerJob, 'tokenHash'>;
  // Load execution modules only after selecting an isolated data directory.
  process.env.DATA_DIR = await mkdtemp(resolve(tmpdir(), 'webprobe-local-runner-'));
  const store = await import('../store.js'),
    { executeScan, createScan, cancelScan } = await import('../scanner.js'),
    { queueRun, cancelRun } = await import('../testing/runner.js'),
    { artifactFile } = await import('../testing/visual.js'),
    { profileHash, scanEvidence, testEvidence } = await import('./evaluator.js');
  if (profileHash(job.policy, job.cases) !== job.profileHash)
    throw new Error('Runner 与服务端配置指纹不一致');
  store.put('project', job.projectSnapshot);
  for (const c of job.cases) store.put('testCase', c);
  for (const b of job.baselines || []) {
    const bytes = await downloadBaseline(b.id);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('基线超过 Runner 限额');
    const file = artifactFile(b.image);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    store.put('visualBaseline', b);
  }
  let activeScan: string | undefined,
    activeTest: string | undefined,
    aborted = false;
  const stop = () => {
    aborted = true;
    if (activeScan) cancelScan(activeScan);
    if (activeTest) cancelRun(activeTest);
  };
  const timeout = setTimeout(stop, 900000);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const scans: Scan[] = [];
  let tests: TestRun | undefined;
  const check = () => {
    if (aborted) throw new Error('Local Runner 已取消');
  };
  try {
    for (let i = 0; i < job.policy.samples; i++) {
      check();
      progress(`性能采样 ${i + 1}/${job.policy.samples}`);
      const s = createScan({
        projectId: job.projectSnapshot.id,
        environmentId: job.policy.environmentId,
        release: job.version,
        browsers: job.policy.browsers,
        devices: job.policy.devices,
        maxPages: job.policy.maxPages,
        paths: job.policy.paths,
        lighthouse: true,
      });
      s.projectSnapshot = job.projectSnapshot;
      activeScan = s.id;
      store.put('scan', s);
      scans.push(await executeScan(s));
      check();
      if (scans.at(-1)?.status !== 'completed') break;
    }
    if (job.policy.requireTests && job.cases.length) {
      progress('执行固定版本回归用例');
      const r = queueRun(
        {
          projectId: job.projectSnapshot.id,
          environmentId: job.policy.environmentId,
          caseIds: job.cases.map((c) => c.id),
          browsers: job.policy.browsers,
          devices: job.policy.devices,
          allowInteractions: job.policy.allowInteractions,
          allowWrites: job.policy.allowWrites,
          release: job.version,
        },
        { project: job.projectSnapshot, cases: job.cases, releaseId: job.releaseId },
      );
      activeTest = r.id;
      const until = Date.now() + 900000;
      while (Date.now() < until) {
        check();
        const current = store.get<TestRun>('testRun', r.id)!;
        if (!['running', 'queued'].includes(current.status)) {
          tests = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!tests) {
        cancelRun(r.id);
        throw new Error('Local Runner 回归测试超时');
      }
    }
    check();
    const submission: Submission = {
      profileHash: job.profileHash,
      scans: scans.map(scanEvidence),
      tests: tests ? testEvidence(tests) : undefined,
      platform: { os: process.platform, node: process.version, runnerVersion: '3.0.0' },
    };
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'runner-report.json'), JSON.stringify(submission, null, 2));
    const paths = new Set(
      [
        ...scans.flatMap((s) =>
          s.pages.flatMap((p) => [
            p.screenshot,
            p.lighthouseReport,
            p.lighthouseReport?.replace(/\.html$/, '.json'),
          ]),
        ),
        ...(tests?.results.flatMap((r) => [
          r.screenshot,
          r.trace,
          ...r.steps.flatMap((s) => [s.visual?.current, s.visual?.diff]),
        ]) || []),
      ].filter((v): v is string => !!v),
    );
    let total = 0;
    const skipped: string[] = [];
    for (const path of paths) {
      check();
      const file = artifactFile(path);
      const size = (await stat(file)).size,
        name = path.split('/').slice(-2).join('-');
      if (size > 8 * 1024 * 1024 || total + size > 32 * 1024 * 1024) {
        skipped.push(name);
        continue;
      }
      const bytes = await readFile(file);
      await mkdir(resolve(output, 'evidence'), { recursive: true });
      await writeFile(resolve(output, 'evidence', name), bytes);
      const meta = await client(`/runner-jobs/${jobId}/artifacts`, {
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        parts: Math.ceil(bytes.length / (128 * 1024)),
      });
      for (let index = 0; index < meta.parts; index++)
        await client(
          `/runner-jobs/${jobId}/artifacts/${meta.id}/parts`,
          {
            index,
            data: bytes.subarray(index * 128 * 1024, (index + 1) * 128 * 1024).toString('base64'),
          },
          'PUT',
        );
      await client(`/runner-jobs/${jobId}/artifacts/${meta.id}/complete`, {});
      total += size;
    }
    if (skipped.length)
      await writeFile(
        resolve(output, 'omitted-artifacts.json'),
        JSON.stringify({ reason: '超过单文件 8MB 或总量 32MB 限额', files: skipped }, null, 2),
      );
    progress('回传证据，等待平台准入判断');
    return (await client(`/runner-jobs/${jobId}/submit`, submission)) as Release;
  } catch (error) {
    stop();
    try {
      await client(`/runner-jobs/${jobId}/fail`, {
        reason: (error as Error).message.slice(0, 1000),
      });
    } catch {}
    throw error;
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
