import type { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { zipSync, strToU8 } from 'fflate';
import { readFile } from 'node:fs/promises';
import {
  releaseInputSchema,
  type Release,
  type ReleaseEvent,
  type GateEvaluation,
  type Deployment,
} from '../../../../packages/shared/src/releases.js';
import { all, get } from '../store.js';
import { artifactFile } from '../testing/visual.js';
import {
  createRelease,
  policyFor,
  savePolicy,
  required,
  approveRelease,
  refreshPolicy,
  evaluateRelease,
  registerDeployment,
  promote,
  selectBaseline,
  readiness,
} from './service.js';
import { startChecks, cancelRelease } from './orchestrator.js';
import {
  createRunnerJob,
  authorizeRunner,
  claimJob,
  submitEvidence,
  beginUpload,
  uploadPart,
  completeUpload,
  failRunnerJob,
} from './runner-jobs.js';
import { compareReleases } from './evaluator.js';
import { releaseMarkdown, releaseJUnit } from './reports.js';
export function registerReleaseRoutes(app: Hono) {
  app.get('/api/release-policies', (c) =>
    c.json(policyFor(c.req.query('projectId') || '', c.req.query('environmentId') || '')),
  );
  app.put('/api/release-policies', async (c) => {
    const { policy, expectedRevision } = z
      .object({ policy: z.unknown(), expectedRevision: z.number().int().min(0) })
      .strict()
      .parse(await c.req.json());
    return c.json(savePolicy(policy, expectedRevision));
  });
  app.get('/api/releases', (c) =>
    c.json(
      all<Release>('release').filter(
        (r) =>
          (!c.req.query('projectId') || r.projectId === c.req.query('projectId')) &&
          (!c.req.query('environmentId') || r.environmentId === c.req.query('environmentId')),
      ),
    ),
  );
  app.post('/api/releases', async (c) =>
    c.json(createRelease(releaseInputSchema.parse(await c.req.json())), 201),
  );
  app.get('/api/releases/:id', (c) => {
    const r = required<Release>('release', c.req.param('id'));
    return c.json({ ...r, readiness: readiness(r) });
  });
  app.get('/api/releases/:id/readiness', (c) =>
    c.json(readiness(required<Release>('release', c.req.param('id')))),
  );
  app.get('/api/releases/:id/events', (c) =>
    streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        const r = get<Release>('release', c.req.param('id'));
        if (!r) break;
        await stream.writeSSE({ event: 'progress', data: JSON.stringify(r) });
        if (!['checking', 'waiting_runner'].includes(r.status)) break;
        await stream.sleep(1000);
      }
    }),
  );
  app.get('/api/releases/:id/history', (c) =>
    c.json({
      events: all<ReleaseEvent>('releaseEvent')
        .filter((e) => e.releaseId === c.req.param('id'))
        .reverse(),
      evaluations: all<GateEvaluation>('gateEvaluation').filter(
        (e) => e.releaseId === c.req.param('id'),
      ),
    }),
  );
  app.post('/api/releases/:id/check', (c) => c.json(startChecks(c.req.param('id')), 202));
  app.post('/api/releases/:id/cancel', (c) => c.json(cancelRelease(c.req.param('id'))));
  app.post('/api/releases/:id/evaluate', async (c) => {
    const body = z
      .object({ refreshPolicy: z.boolean().default(false) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      body.refreshPolicy ? refreshPolicy(c.req.param('id')) : evaluateRelease(c.req.param('id')),
    );
  });
  app.post('/api/releases/:id/baseline', async (c) => {
    const { baselineId } = z
      .object({ baselineId: z.string().nullable() })
      .strict()
      .parse(await c.req.json());
    return c.json(selectBaseline(c.req.param('id'), baselineId));
  });
  app.post('/api/releases/:id/approve', async (c) => {
    const { actor, note } = z
      .object({
        actor: z.string().trim().min(1).max(100),
        note: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(approveRelease(c.req.param('id'), actor, note));
  });
  app.post('/api/releases/:id/promote', async (c) => {
    const { environmentId, targetUrl } = z
      .object({ environmentId: z.string().min(1), targetUrl: z.string().url().optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(promote(c.req.param('id'), environmentId, targetUrl), 201);
  });
  app.post('/api/releases/:id/deployments', async (c) => {
    const body = z
      .object({
        commit: z.string().min(7).max(64),
        actor: z.string().trim().min(1).max(100),
        note: z.string().max(1000).default(''),
        url: z.string().url(),
        source: z.enum(['manual', 'ci']).default('manual'),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(registerDeployment(c.req.param('id'), body), 201);
  });
  app.get('/api/deployments', (c) =>
    c.json(
      all<Deployment>('deployment').filter(
        (d) => !c.req.query('projectId') || d.projectId === c.req.query('projectId'),
      ),
    ),
  );
  app.get('/api/releases/:id/compare', (c) =>
    c.json(
      compareReleases(
        required<Release>('release', c.req.param('id')),
        required<Release>('release', c.req.query('baselineId') || ''),
      ),
    ),
  );
  app.get('/api/releases/:id/export', async (c) => {
    const r = required<Release>('release', c.req.param('id')),
      format = c.req.query('format');
    c.header(
      'Content-Disposition',
      `attachment; filename="webprobe-release-${r.id}.${format === 'markdown' ? 'md' : format === 'junit' ? 'xml' : format === 'bundle' ? 'zip' : 'json'}"`,
    );
    if (format === 'markdown') return c.text(releaseMarkdown(r));
    if (format === 'junit') {
      c.header('Content-Type', 'application/xml');
      return c.body(releaseJUnit(r));
    }
    if (format === 'bundle') {
      const files: Record<string, Uint8Array> = {
        'release.json': strToU8(JSON.stringify(r, null, 2)),
        'quality-report.md': strToU8(releaseMarkdown(r)),
        'junit.xml': strToU8(releaseJUnit(r)),
      };
      let size = 0;
      for (const a of r.evidence?.artifacts || []) {
        if (size + a.bytes > 32 * 1024 * 1024) continue;
        try {
          files[`evidence/${a.url.split('/').slice(-2).join('-')}`] = await readFile(
            artifactFile(a.url),
          );
          size += a.bytes;
        } catch {}
      }
      c.header('Content-Type', 'application/zip');
      return c.body(zipSync(files));
    }
    return c.json(r);
  });
  app.post('/api/releases/:id/runner-jobs', (c) => c.json(createRunnerJob(c.req.param('id')), 201));
  const auth = (c: {
    req: { param: (n: string) => string; header: (n: string) => string | undefined };
  }) => authorizeRunner(c.req.param('id'), c.req.header('authorization'));
  app.get('/api/runner-jobs/:id', (c) => c.json(claimJob(auth(c))));
  app.get('/api/runner-jobs/:id/baselines/:baselineId', async (c) => {
    const job = auth(c),
      baseline = job.baselines?.find((b) => b.id === c.req.param('baselineId'));
    if (!baseline) return c.json({ error: '基线不在任务授权范围' }, 403);
    const bytes = await readFile(artifactFile(baseline.image));
    if (bytes.length > 8 * 1024 * 1024) return c.json({ error: '基线超过 Runner 限额' }, 413);
    c.header('Content-Type', 'image/png');
    return c.body(bytes);
  });
  app.post('/api/runner-jobs/:id/fail', async (c) => {
    const { reason } = z
      .object({ reason: z.string().min(1).max(1000) })
      .strict()
      .parse(await c.req.json());
    return c.json(failRunnerJob(auth(c), reason));
  });
  app.post('/api/runner-jobs/:id/submit', async (c) => {
    const body = await c.req.json();
    return c.json(submitEvidence(auth(c), body));
  });
  app.post('/api/runner-jobs/:id/artifacts', async (c) => {
    const body = await c.req.json();
    return c.json(beginUpload(auth(c), body), 201);
  });
  app.put('/api/runner-jobs/:id/artifacts/:uploadId/parts', async (c) => {
    const body = await c.req.json();
    return c.json(await uploadPart(auth(c), c.req.param('uploadId'), body));
  });
  app.post('/api/runner-jobs/:id/artifacts/:uploadId/complete', (c) =>
    completeUpload(auth(c), c.req.param('uploadId')).then((r) => c.json(r)),
  );
}
