import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
delete process.env.ALLOW_PRIVATE_NETWORK;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-unit-'));
const { app } = await import('../apps/server/src/index.js');
const { all, createProject, put, get, fingerprint, reconcile, finalize } =
  await import('../apps/server/src/store.js');
const { createScan } = await import('../apps/server/src/scanner.js');
const { projectSchema, scanSchema } = await import('../packages/shared/src/index.js');
import type { Finding, Issue, Scan } from '../packages/shared/src/index.js';
const project = createProject(
  projectSchema.parse({
    name: '测试项目',
    environments: [{ id: 'prod', name: '生产', url: 'https://example.com/' }],
  }),
);
const config = scanSchema.parse({
  projectId: project.id,
  environmentId: 'prod',
  lighthouse: false,
});
function finding(rule = 'js-uncaught'): Finding {
  const f: Omit<Finding, 'fingerprint'> = {
    rule,
    source: 'runtime',
    title: 'JS 异常',
    severity: 'P1',
    url: 'https://example.com/',
    browser: 'chromium',
    device: 'desktop',
    evidence: 'Error: test',
    recommendation: '核实错误',
    certainty: 'confirmed',
  };
  return { ...f, fingerprint: fingerprint(f, 'Error: test') };
}
function scan(findings: Finding[]): Scan {
  return {
    ...createScan(config),
    status: 'completed',
    completedAt: new Date().toISOString(),
    findings,
    pages: [
      {
        url: 'https://example.com/',
        browser: 'chromium',
        device: 'desktop',
        title: 'Example',
        status: 'completed',
        duration: 1,
        sources: ['runtime'],
      },
    ],
  };
}
test('输入校验：拒绝非法路径、重复环境及过量页面', () => {
  assert.equal(scanSchema.safeParse({ ...config, paths: ['//evil.com'] }).success, false);
  assert.equal(scanSchema.safeParse({ ...config, maxPages: 100 }).success, false);
  assert.equal(
    projectSchema.safeParse({
      ...project,
      environments: [project.environments[0], project.environments[0]],
    }).success,
    false,
  );
});
test('问题聚合、待验证、部分检查不误判修复、回归修复和复发', () => {
  const f = finding();
  reconcile(scan([f]));
  reconcile(scan([f]));
  let issue = all<Issue>('issue').find((i) => i.fingerprint === f.fingerprint)!;
  assert.equal(issue.occurrences, 2);
  put('issue', { ...issue, status: 'pending_verification' });
  const partial = scan([]);
  partial.pages[0].sources = ['seo'];
  reconcile(partial);
  assert.equal(get<Issue>('issue', issue.id)!.status, 'pending_verification');
  const failed = scan([]);
  failed.pages[0].status = 'failed';
  reconcile(failed);
  assert.equal(get<Issue>('issue', issue.id)!.status, 'pending_verification');
  reconcile(scan([]));
  assert.equal(get<Issue>('issue', issue.id)!.status, 'resolved');
  reconcile(scan([f]));
  assert.equal(get<Issue>('issue', issue.id)!.status, 'open');
});
test('质量准入不把缺失性能数据视为通过，回归对比遵守覆盖范围', () => {
  const baseline = scan([finding()]);
  put('scan', baseline);
  const current = scan([]);
  current.pages[0].sources = ['seo'];
  finalize(current, project);
  assert.equal(current.gate?.passed, false);
  assert.equal(current.comparison?.removed, 0);
});
test('API：持久化项目、拒绝非法请求、跨站请求、人工假定已修复', async () => {
  assert.equal((await app.request('http://localhost/api/health')).status, 200);
  assert.equal(
    (
      await app.request('http://localhost/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request('http://localhost/api/projects', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  const issue = all<Issue>('issue')[0];
  assert.equal(
    (
      await app.request(`http://localhost/api/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      })
    ).status,
    400,
  );
});
test('导出：JSON、Markdown 与修复 ZIP 包', async () => {
  const s = scan([finding()]);
  put('scan', s);
  const json = await app.request(`http://localhost/api/scans/${s.id}/export`);
  assert.equal((await json.json()).schemaVersion, '1.0');
  const md = await app.request(`http://localhost/api/scans/${s.id}/export?format=markdown`);
  assert.match(await md.text(), /WebProbe 修复任务/);
  const zip = await app.request(`http://localhost/api/scans/${s.id}/export?format=bundle`);
  assert.equal(zip.headers.get('Content-Type'), 'application/zip');
  assert.ok((await zip.arrayBuffer()).byteLength > 300);
});
test('无模型凭证时返回明确标识的规则建议', async () => {
  const issue = all<Issue>('issue')[0];
  const r = await app.request(`http://localhost/api/issues/${issue.id}/diagnose`, {
    method: 'POST',
  });
  assert.equal((await r.json()).diagnosis.provider, 'rules');
});
