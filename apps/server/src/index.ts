import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { resolve } from 'node:path';
import { all, createProject, dataDir, get, put, recoverInterrupted } from './store.js';
import {
  projectSchema,
  scanSchema,
  issueStatuses,
  type Issue,
  type Project,
  type Scan,
} from '../../../packages/shared/src/index.js';
import { activeScanCount, cancelScan, createScan, enqueue } from './scanner.js';
import { diagnose, repairPrompt } from './reports.js';
import { validateUrl } from './security.js';

import { registerTestingRoutes, recoverTesting } from './testing/routes.js';
export const app = new Hono();
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.WEBPROBE_API_TOKEN)
  throw new Error('非本地监听必须配置 WEBPROBE_API_TOKEN');
app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
app.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  if (
    ['127.0.0.1', 'localhost', '::1'].includes(host) &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
  )
    return c.json({ error: '非法 Host' }, 403);
  const origin = c.req.header('origin');
  if (
    origin &&
    ![
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      `http://${host}:${port}`,
    ].includes(origin)
  )
    return c.json({ error: '不允许跨站请求' }, 403);
  if (c.req.path.startsWith('/api') || c.req.path.startsWith('/artifacts')) {
    const token = process.env.WEBPROBE_API_TOKEN;
    if (token && c.req.header('authorization') !== `Bearer ${token}`)
      return c.json({ error: '需要 API Token，请在设置中配置' }, 401);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  }
  await next();
});
app.onError((error, c) =>
  c.json(
    {
      error:
        error instanceof z.ZodError
          ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')
          : error.message,
    },
    error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
  ),
);
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    version: '2.0.0',
    aiConfigured: !!process.env.AI_API_KEY,
    aiModel: process.env.AI_MODEL || 'deepseek-chat',
    privateNetworkAllowed: process.env.ALLOW_PRIVATE_NETWORK === 'true',
  }),
);
app.get('/api/projects', (c) => c.json(all<Project>('project')));
app.post('/api/projects', async (c) => {
  const input = projectSchema.parse(await c.req.json());
  for (const e of input.environments) validateUrl(e.url);
  return c.json(createProject(input), 201);
});
app.put('/api/projects/:id', async (c) => {
  const old = get<Project>('project', c.req.param('id'));
  if (!old) return c.json({ error: '项目不存在' }, 404);
  const input = projectSchema.parse(await c.req.json());
  for (const e of input.environments) validateUrl(e.url);
  if (
    all<Scan>('scan').some(
      (s) => s.projectId === old.id && ['queued', 'running'].includes(s.status),
    )
  )
    return c.json({ error: '请等待当前检测结束再编辑项目' }, 409);
  return c.json(put('project', { ...old, ...input }));
});
app.get('/api/scans', (c) =>
  c.json(
    all<Scan>('scan').filter(
      (s) => !c.req.query('projectId') || s.projectId === c.req.query('projectId'),
    ),
  ),
);
app.post('/api/scans', async (c) => {
  const config = scanSchema.parse(await c.req.json());
  const project = get<Project>('project', config.projectId);
  if (!project?.environments.some((e) => e.id === config.environmentId))
    return c.json({ error: '项目或环境不存在' }, 404);
  if (config.lighthouse && !config.browsers.includes('chromium'))
    return c.json({ error: 'Lighthouse 检测需要选择 Chromium' }, 400);
  if (activeScanCount() >= 10) return c.json({ error: '队列已满，请稍后再试' }, 429);
  return c.json(enqueue(createScan(config)), 202);
});
app.get('/api/scans/:id', (c) => {
  const scan = get<Scan>('scan', c.req.param('id'));
  return scan ? c.json(scan) : c.json({ error: '检测不存在' }, 404);
});
app.post('/api/scans/:id/cancel', (c) => c.json({ cancelled: cancelScan(c.req.param('id')) }));
app.get('/api/scans/:id/events', (c) =>
  streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      const scan = get<Scan>('scan', c.req.param('id'));
      if (!scan) break;
      await stream.writeSSE({ event: 'progress', data: JSON.stringify(scan) });
      if (!['queued', 'running'].includes(scan.status)) break;
      await stream.sleep(1000);
    }
  }),
);
app.get('/api/issues', (c) =>
  c.json(
    all<Issue>('issue').filter(
      (i) => !c.req.query('projectId') || i.projectId === c.req.query('projectId'),
    ),
  ),
);
app.patch('/api/issues/:id', async (c) => {
  const issue = get<Issue>('issue', c.req.param('id'));
  if (!issue) return c.json({ error: '问题不存在' }, 404);
  const input = z.object({ status: z.enum(issueStatuses) }).parse(await c.req.json());
  if (input.status === 'resolved')
    return c.json({ error: '请通过重新检测验证修复；可先标记为待验证' }, 400);
  return c.json(put('issue', { ...issue, status: input.status }));
});
app.post('/api/issues/:id/diagnose', async (c) => {
  const issue = get<Issue>('issue', c.req.param('id'));
  if (!issue) return c.json({ error: '问题不存在' }, 404);
  const diagnosis = await diagnose(issue);
  return c.json(put('issue', { ...get<Issue>('issue', issue.id)!, diagnosis }));
});
app.get('/api/scans/:id/export', async (c) => {
  const scan = get<Scan>('scan', c.req.param('id'));
  if (!scan) return c.json({ error: '检测不存在' }, 404);
  const project = get<Project>('project', scan.projectId)!;
  const issues = all<Issue>('issue').filter(
    (i) => i.projectId === project.id && i.environmentId === scan.environmentId,
  );
  if (c.req.query('format') === 'bundle') {
    const files: Record<string, Uint8Array> = {
      'repair-prompt.md': strToU8(repairPrompt(project, scan, issues)),
      'report.json': strToU8(JSON.stringify({ schemaVersion: '1.0', project, scan }, null, 2)),
    };
    const paths = new Set(
      scan.pages
        .flatMap((p) => [
          p.screenshot,
          p.lighthouseReport,
          p.lighthouseReport?.replace(/\.html$/, '.json'),
        ])
        .filter((p): p is string => !!p),
    );
    for (const path of paths) {
      const name = path.split('/').pop()!;
      try {
        files[`evidence/${name}`] = await readFile(resolve(dataDir, 'artifacts', scan.id, name));
      } catch {}
    }
    c.header('Content-Disposition', `attachment; filename="webprobe-${scan.id}.zip"`);
    c.header('Content-Type', 'application/zip');
    return c.body(zipSync(files));
  }
  const markdown = c.req.query('format') === 'markdown';
  c.header(
    'Content-Disposition',
    `attachment; filename="webprobe-${scan.id}.${markdown ? 'md' : 'json'}"`,
  );
  if (markdown) return c.text(repairPrompt(project, scan, issues));
  return c.json({
    schemaVersion: '1.0',
    project,
    scan,
    issues: issues.filter((i) => scan.findings.some((f) => f.fingerprint === i.fingerprint)),
    repairPrompt: repairPrompt(project, scan, issues),
  });
});
registerTestingRoutes(app);
app.all('/api/*', (c) => c.json({ error: 'API 不存在' }, 404));
app.get(
  '/artifacts/*',
  async (c, next) => {
    c.header(
      'Content-Security-Policy',
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    );
    await next();
  },
  serveStatic({
    root: resolve(dataDir, 'artifacts'),
    rewriteRequestPath: (path) => path.replace(/^\/artifacts/, ''),
  }),
);
app.all('/artifacts/*', (c) => c.json({ error: '证据文件不存在' }, 404));
if (existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}
recoverInterrupted();
recoverTesting();
if (process.env.NODE_ENV !== 'test')
  serve({ fetch: app.fetch, port, hostname: host }, () =>
    console.log(`WebProbe API http://${host}:${port}`),
  );
