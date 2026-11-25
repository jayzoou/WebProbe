import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY;
delete process.env.WEBPROBE_API_TOKEN;
delete process.env.ALLOW_PRIVATE_NETWORK;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-testing-core-'));
const { app } = await import('../apps/server/src/index.js');
const { createProject, all, put } = await import('../apps/server/src/store.js');
const { projectSchema } = await import('../packages/shared/src/index.js');
const { testCaseSchema, testRunSchema } = await import('../packages/shared/src/testing.js');
const { saveCase, playwrightSource, updateTestIssue } =
  await import('../apps/server/src/testing/runner.js');
const { compareImages, baselineKey, approveBaseline } =
  await import('../apps/server/src/testing/visual.js');
import type { TestCase, TestRun, CaseResult } from '../packages/shared/src/testing.js';
import type { Issue } from '../packages/shared/src/index.js';
const project = createProject(
  projectSchema.parse({
    name: 'V2',
    environments: [{ id: 'preview', name: '预览', url: 'https://example.com' }],
  }),
);
const input = {
  projectId: project.id,
  name: '功能',
  description: '明确预期',
  steps: [{ action: 'navigate' as const, path: '/' }, { action: 'assertNoErrors' as const }],
  tags: [],
};
function run(test: TestCase): TestRun {
  return {
    ...testRunSchema.parse({ projectId: project.id, environmentId: 'preview', caseIds: [test.id] }),
    id: crypto.randomUUID(),
    status: 'passed',
    createdAt: new Date().toISOString(),
    progress: 100,
    stage: '完成',
    cases: [test],
    results: [],
  };
}
function result(test: TestCase): CaseResult {
  return {
    id: crypto.randomUUID(),
    testCase: test,
    browser: 'chromium',
    device: 'desktop',
    status: 'failed',
    steps: [],
    errors: ['JS defect'],
    failureSignature: 'defect',
    error: '断言失败',
    duration: 1,
  };
}
test('用例只接受受限步骤、站内导航和显式断言', () => {
  assert.equal(
    testCaseSchema.safeParse({
      ...input,
      steps: [{ action: 'navigate', path: '//evil.example' }, { action: 'assertNoErrors' }],
    }).success,
    false,
  );
  assert.equal(
    testCaseSchema.safeParse({ ...input, steps: [{ action: 'evaluate', code: 'process.exit()' }] })
      .success,
    false,
  );
  assert.equal(
    testCaseSchema.safeParse({ ...input, steps: [{ action: 'navigate', path: '/' }] }).success,
    false,
  );
  assert.equal(
    testCaseSchema.safeParse({
      ...input,
      steps: [
        ...input.steps,
        { action: 'visual', name: 'same' },
        { action: 'visual', name: 'same' },
      ],
    }).success,
    false,
  );
});
test('编辑保留版本快照，敏感字段不能持久化', () => {
  const first = saveCase(input);
  const snapshot = run(first);
  const second = saveCase({ ...input, name: '第二版' }, 'manual', first.id);
  assert.equal(second.revision, 2);
  assert.equal(snapshot.cases[0].revision, 1);
  assert.equal(all('testRevision').length, 2);
  assert.throws(
    () =>
      saveCase({
        ...input,
        steps: [
          input.steps[0],
          { action: 'fill', target: { by: 'css', value: '#password' }, value: 'secret' },
          input.steps[1],
        ],
      }),
    /敏感/,
  );
});
test('Playwright 导出转义外部文本，JSON 导入不能执行源代码', async () => {
  const item = saveCase({ ...input, name: 'bad"); process.exit(); //' });
  const code = playwrightSource(item);
  assert.match(code, /test\("bad\\"\); process.exit\(\); \/\//);
  const response = await app.request('http://localhost/api/test-cases/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ ...input, steps: [{ action: 'evaluate', code: 'process.exit()' }] }]),
  });
  assert.equal(response.status, 400);
});
test('功能问题按版本/环境聚合，重放确认，受阻不误判修复', () => {
  const item = saveCase(input),
    first = run(item),
    r = result(item);
  updateTestIssue(first, r);
  let issue = all<Issue>('issue').find((i) => i.testCaseId === item.id)!;
  assert.equal(issue.certainty, 'suspected');
  updateTestIssue(first, r);
  assert.equal(all<Issue>('issue').find((i) => i.id === issue.id)!.occurrences, 1);
  updateTestIssue(run(item), result(item));
  assert.equal(all<Issue>('issue').find((i) => i.id === issue.id)!.certainty, 'confirmed');
  updateTestIssue(run(item), { ...r, status: 'blocked' });
  assert.equal(all<Issue>('issue').find((i) => i.id === issue.id)!.status, 'open');
  updateTestIssue(run({ ...item, revision: 2 }), {
    ...r,
    testCase: { ...item, revision: 2 },
    status: 'passed',
  });
  assert.equal(all<Issue>('issue').find((i) => i.id === issue.id)!.status, 'open');
  updateTestIssue(run(item), { ...r, status: 'passed' });
  assert.equal(all<Issue>('issue').find((i) => i.id === issue.id)!.status, 'resolved');
});
test('像素比较与视觉基线按环境/步骤/浏览器/设备隔离', () => {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(255);
  const a = PNG.sync.write(png);
  assert.equal(compareImages(a, a).diffRatio, 0);
  png.data.fill(0);
  assert.ok(compareImages(a, PNG.sync.write(png)).diffRatio > 0);
  const item = saveCase(input),
    r = run(item),
    key = baselineKey(r, item, 'chromium', 'desktop', 'main');
  assert.notEqual(
    key,
    baselineKey({ ...r, environmentId: 'production' }, item, 'chromium', 'desktop', 'main'),
  );
  assert.notEqual(key, baselineKey(r, item, 'firefox', 'desktop', 'main'));
  assert.notEqual(
    key,
    baselineKey(
      r,
      { ...item, steps: [...item.steps, { action: 'assertUrl', path: '/about' }] },
      'chromium',
      'desktop',
      'main',
    ),
  );
  assert.throws(() => approveBaseline({ ...r, status: 'running' }, 'missing', 'main'), /仅可批准/);
});
test('测试接口同样受 Token 与 Origin 保护', async () => {
  process.env.WEBPROBE_API_TOKEN = 'test-v2';
  try {
    assert.equal((await app.request('http://localhost/api/test-runs')).status, 401);
    assert.equal(
      (
        await app.request('http://localhost/api/test-cases', {
          headers: { origin: 'https://evil.example', authorization: 'Bearer test-v2' },
        })
      ).status,
      403,
    );
  } finally {
    delete process.env.WEBPROBE_API_TOKEN;
  }
});
