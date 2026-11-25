import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY;
delete process.env.ALLOW_PRIVATE_NETWORK;
process.env.WEBPROBE_API_TOKEN = 'release-admin-test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-runner-security-'));
const { app } = await import('../apps/server/src/index.js');
const { createProject, get, put } = await import('../apps/server/src/store.js');
const { projectSchema } = await import('../packages/shared/src/index.js');
const { createRelease } = await import('../apps/server/src/releases/service.js');
const { createRunnerJob, hash } = await import('../apps/server/src/releases/runner-jobs.js');
import type { RunnerJob, Release } from '../packages/shared/src/releases.js';
const project = createProject(
  projectSchema.parse({
    name: 'Scope tests',
    environments: [{ id: 'preview', name: 'Preview', url: 'https://example.test/' }],
  }),
);
let sequence = 0;
function issue() {
  const r = createRelease({
    projectId: project.id,
    environmentId: 'preview',
    version: 'scope-' + ++sequence,
    commit: 'abcdef1',
    branch: '',
    notes: '',
  });
  return createRunnerJob(r.id);
}
const call = (path: string, token?: string, body?: unknown, method = body ? 'POST' : 'GET') =>
  app.request('http://localhost/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
test('Runner 凭证只授权单任务，不能读取管理 API 或其他任务', async () => {
  const a = issue(),
    b = issue();
  assert.equal((await call('/runner-jobs/' + a.job.id)).status, 401);
  assert.equal((await call('/runner-jobs/' + a.job.id, 'release-admin-test')).status, 401);
  assert.equal((await call('/runner-jobs/' + b.job.id, a.token)).status, 401);
  assert.equal((await call('/projects', a.token)).status, 401);
  const result = await call('/runner-jobs/' + a.job.id, a.token);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).tokenHash, undefined);
  assert.notEqual(get<RunnerJob>('runnerJob', a.job.id)!.tokenHash, a.token);
});
test('过期、取消、错误配置、站外证据和重放都拒绝', async () => {
  const a = issue(),
    auth = a.token;
  await call('/runner-jobs/' + a.job.id, auth);
  const payload = {
    profileHash: '0'.repeat(64),
    scans: [],
    platform: { os: 'test', node: process.version, runnerVersion: '3.0.0' },
  };
  assert.equal((await call('/runner-jobs/' + a.job.id + '/submit', auth, payload)).status, 409);
  const stored = get<RunnerJob>('runnerJob', a.job.id)!;
  payload.profileHash = stored.profileHash;
  const outside = {
    ...payload,
    scans: [
      {
        id: 'outside',
        status: 'completed',
        completedAt: new Date().toISOString(),
        pages: [
          {
            url: 'https://outside.example/',
            browser: 'chromium',
            device: 'desktop',
            status: 'completed',
            sources: [],
          },
        ],
        findings: [],
      },
    ],
  };
  assert.equal((await call('/runner-jobs/' + a.job.id + '/submit', auth, outside)).status, 400);
  const finished = await call('/runner-jobs/' + a.job.id + '/submit', auth, payload);
  assert.equal(finished.status, 200);
  assert.equal((await finished.json()).status, 'blocked');
  assert.equal((await call('/runner-jobs/' + a.job.id, auth)).status, 409);
  const b = issue();
  put('runnerJob', {
    ...get<RunnerJob>('runnerJob', b.job.id)!,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal((await call('/runner-jobs/' + b.job.id, b.token)).status, 410);
  const c = issue();
  await call('/releases/' + c.job.releaseId + '/cancel', 'release-admin-test', {});
  assert.equal((await call('/runner-jobs/' + c.job.id, c.token)).status, 409);
});
test('附件路径、分片范围、摘要与跨任务访问不能越权', async () => {
  const a = issue(),
    b = issue(),
    prefix = '/runner-jobs/' + a.job.id;
  await call(prefix, a.token);
  await call('/runner-jobs/' + b.job.id, b.token);
  assert.equal(
    (
      await call(prefix + '/artifacts', a.token, {
        name: '../escape.json',
        bytes: 4,
        sha256: '0'.repeat(64),
        parts: 1,
      })
    ).status,
    400,
  );
  const bytes = Buffer.from('{"ok":true}');
  const upload = await (
    await call(prefix + '/artifacts', a.token, {
      name: 'report.json',
      bytes: bytes.length,
      sha256: hash(bytes),
      parts: 1,
    })
  ).json();
  assert.equal(
    (
      await call(
        '/runner-jobs/' + b.job.id + '/artifacts/' + upload.id + '/parts',
        b.token,
        { index: 0, data: bytes.toString('base64') },
        'PUT',
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(prefix + '/artifacts/' + upload.id + '/complete', a.token, {})).status,
    409,
  );
  assert.equal(
    (
      await call(
        prefix + '/artifacts/' + upload.id + '/parts',
        a.token,
        { index: 0, data: bytes.toString('base64') },
        'PUT',
      )
    ).status,
    200,
  );
  const complete = await call(prefix + '/artifacts/' + upload.id + '/complete', a.token, {});
  assert.equal(complete.status, 200);
  const { url } = await complete.json();
  assert.equal(
    (
      await app.request('http://localhost' + url, {
        headers: { authorization: 'Bearer ' + a.token },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request('http://localhost' + url, {
        headers: { authorization: 'Bearer release-admin-test' },
      })
    ).status,
    200,
  );
  assert.equal((await call(prefix + '/baselines/not-authorized', a.token)).status, 403);
});
