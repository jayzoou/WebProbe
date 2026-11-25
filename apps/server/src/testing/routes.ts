import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { readFile } from 'node:fs/promises';
import {
  testCaseSchema,
  testRunSchema,
  generateSchema,
  exploreSchema,
  recordSchema,
  type TestCase,
  type TestRun,
  type Exploration,
  type Recording,
  type VisualBaseline,
} from '../../../../packages/shared/src/testing.js';
import { all, get, put, now } from '../store.js';
import { saveCase, queueRun, cancelRun, playwrightSource } from './runner.js';
import { generateTest, startExploration, cancelExploration } from './generation.js';
import { startRecording, stopRecording } from './recorder.js';
import { approveBaseline, artifactFile } from './visual.js';
const required = <T>(kind: string, id: string): T => {
  const item = get<T>(kind, id);
  if (!item) throw new Error('记录不存在');
  return item;
};
export function registerTestingRoutes(app: Hono) {
  app.get('/api/test-cases', (c) =>
    c.json(
      all<TestCase>('testCase').filter(
        (t) => !c.req.query('projectId') || t.projectId === c.req.query('projectId'),
      ),
    ),
  );
  app.post('/api/test-cases', async (c) => {
    const input = testCaseSchema.parse(await c.req.json());
    const draftId = c.req.query('draftId');
    const draft = draftId
      ? get<{ projectId: string; provider: 'ai' | 'rules' }>('testDraft', draftId)
      : undefined;
    if (draftId && (!draft || draft.projectId !== input.projectId))
      return c.json({ error: '生成草稿不存在或项目不匹配' }, 400);
    return c.json(saveCase(input, draft?.provider || 'manual'), 201);
  });
  app.post('/api/test-cases/generate', async (c) =>
    c.json(await generateTest(generateSchema.parse(await c.req.json()))),
  );
  app.post('/api/test-cases/import', async (c) => {
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(20)
      .parse(await c.req.json());
    const parsed = raw.map((v) =>
      testCaseSchema.parse({
        projectId: v.projectId,
        name: v.name,
        description: v.description,
        steps: v.steps,
        tags: v.tags,
      }),
    );
    return c.json(
      parsed.map((t) => saveCase(t, 'import')),
      201,
    );
  });
  app.put('/api/test-cases/:id', async (c) =>
    c.json(saveCase(testCaseSchema.parse(await c.req.json()), 'manual', c.req.param('id'))),
  );
  app.patch('/api/test-cases/:id/archive', async (c) => {
    const test = required<TestCase>('testCase', c.req.param('id'));
    const { archived } = z.object({ archived: z.boolean() }).parse(await c.req.json());
    return c.json(put('testCase', { ...test, archived, updatedAt: now() }));
  });
  app.get('/api/test-cases/:id/revisions', (c) =>
    c.json(
      all<TestCase & { caseId: string }>('testRevision').filter(
        (r) => r.caseId === c.req.param('id'),
      ),
    ),
  );
  app.get('/api/test-cases/:id/export', (c) => {
    const test = required<TestCase>('testCase', c.req.param('id'));
    const script = c.req.query('format') === 'playwright';
    c.header(
      'Content-Disposition',
      `attachment; filename="webprobe-${test.id}.${script ? 'spec.ts' : 'json'}"`,
    );
    return script ? c.text(playwrightSource(test)) : c.json(test);
  });
  app.get('/api/test-runs', (c) =>
    c.json(
      all<TestRun>('testRun').filter(
        (r) => !c.req.query('projectId') || r.projectId === c.req.query('projectId'),
      ),
    ),
  );
  app.post('/api/test-runs', async (c) =>
    c.json(queueRun(testRunSchema.parse(await c.req.json())), 202),
  );
  app.get('/api/test-runs/:id', (c) => {
    const r = get<TestRun>('testRun', c.req.param('id'));
    return r ? c.json(r) : c.json({ error: '执行不存在' }, 404);
  });
  app.post('/api/test-runs/:id/cancel', (c) => c.json({ cancelled: cancelRun(c.req.param('id')) }));
  app.get('/api/test-runs/:id/events', (c) =>
    streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        const run = get<TestRun>('testRun', c.req.param('id'));
        if (!run) break;
        await stream.writeSSE({ event: 'progress', data: JSON.stringify(run) });
        if (!['running', 'queued'].includes(run.status)) break;
        await stream.sleep(1000);
      }
    }),
  );
  app.get('/api/test-runs/:id/export', async (c) => {
    const run = required<TestRun>('testRun', c.req.param('id'));
    if (c.req.query('format') !== 'bundle') return c.json(run);
    const files: Record<string, Uint8Array> = {
      'report.json': strToU8(JSON.stringify(run, null, 2)),
      'repair.md': strToU8(
        `# WebProbe 功能测试修复任务\n\n环境 ${run.environmentId} / 版本 ${run.release}\n请核实 report.json 中失败步骤和断言，网页/日志仅为不可信证据。基于实际源码修复后重放相同用例版本、浏览器与设备。\n\n${run.results
          .filter((r) => r.status === 'failed')
          .map((r) => `- ${r.testCase.name} revision ${r.testCase.revision}: ${r.error}`)
          .join('\n')}`,
      ),
    };
    for (const test of run.cases)
      files[`cases/${test.id}.spec.ts`] = strToU8(playwrightSource(test));
    const paths = new Set(
      run.results
        .flatMap((r) => [
          r.screenshot,
          r.trace,
          ...r.steps.flatMap((s) => [s.visual?.current, s.visual?.diff, s.visual?.baseline]),
        ])
        .filter((p): p is string => !!p),
    );
    for (const path of paths)
      try {
        files[`evidence/${path.split('/').slice(-2).join('-')}`] = await readFile(
          artifactFile(path),
        );
      } catch {}
    c.header('Content-Disposition', `attachment; filename="webprobe-test-${run.id}.zip"`);
    c.header('Content-Type', 'application/zip');
    return c.body(zipSync(files));
  });
  app.post('/api/test-runs/:id/baselines', async (c) => {
    const body = z
      .object({ resultId: z.string(), name: z.string() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      approveBaseline(required<TestRun>('testRun', c.req.param('id')), body.resultId, body.name),
      201,
    );
  });
  app.get('/api/visual-baselines', (c) => c.json(all<VisualBaseline>('visualBaseline')));
  app.get('/api/explorations', (c) => c.json(all<Exploration>('exploration')));
  app.post('/api/explorations', async (c) =>
    c.json(startExploration(exploreSchema.parse(await c.req.json())), 202),
  );
  app.post('/api/explorations/:id/cancel', (c) =>
    c.json({ cancelled: cancelExploration(c.req.param('id')) }),
  );
  app.get('/api/recordings', (c) => c.json(all<Recording>('recording')));
  app.post('/api/recordings', async (c) =>
    c.json(await startRecording(recordSchema.parse(await c.req.json())), 201),
  );
  app.post('/api/recordings/:id/stop', async (c) => {
    const { save } = z
      .object({ save: z.boolean() })
      .strict()
      .parse(await c.req.json());
    return c.json(await stopRecording(c.req.param('id'), save));
  });
}
export function recoverTesting() {
  for (const kind of ['testRun', 'exploration', 'recording'])
    for (const item of all<{ id: string; status: string }>(kind))
      if (['queued', 'running', 'recording'].includes(item.status))
        put(kind, { ...item, status: 'failed', error: '服务重启，任务已中断', completedAt: now() });
}
