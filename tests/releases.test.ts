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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'webprobe-release-core-'));
const { app } = await import('../apps/server/src/index.js');
const { createProject, put, get, all } = await import('../apps/server/src/store.js');
const { projectSchema } = await import('../packages/shared/src/index.js');
const { saveCase } = await import('../apps/server/src/testing/runner.js');
const { policyInputSchema } = await import('../packages/shared/src/releases.js');
const {
  createRelease,
  savePolicy,
  policyFor,
  evaluateRelease,
  approveRelease,
  registerDeployment,
  refreshPolicy,
} = await import('../apps/server/src/releases/service.js');
const { evaluate, median, profileHash } = await import('../apps/server/src/releases/evaluator.js');
const { releaseJUnit } = await import('../apps/server/src/releases/reports.js');
const { exitCode } = await import('../apps/server/src/release-cli.js');
import type { Release, ReleaseEvidence } from '../packages/shared/src/releases.js';
const project = createProject(
  projectSchema.parse({
    name: 'Release tests',
    environments: [
      { id: 'preview', name: '预览', url: 'https://preview.example.test/' },
      { id: 'production', name: '生产', url: 'https://example.test/' },
    ],
  }),
);
const testcase = saveCase({
  projectId: project.id,
  name: 'Smoke',
  description: '',
  tags: [],
  steps: [{ action: 'navigate', path: '/' }, { action: 'assertNoErrors' }],
});
for (const environmentId of ['preview', 'production'])
  savePolicy(
    policyInputSchema.parse({ projectId: project.id, environmentId, caseIds: [testcase.id] }),
    0,
  );
let sequence = 0;
function release(environmentId = 'preview', baselineId?: string) {
  return createRelease({
    projectId: project.id,
    environmentId,
    version: 'v' + ++sequence,
    commit: 'abcdef1',
    branch: 'main',
    notes: '',
    baselineId,
  });
}
function evidence(r: Release, values = [90, 94]): ReleaseEvidence {
  return {
    id: crypto.randomUUID(),
    source: 'platform',
    profileHash: r.profileHash,
    receivedAt: new Date().toISOString(),
    artifacts: [],
    scans: values.map((v, i) => ({
      id: crypto.randomUUID(),
      status: 'completed',
      completedAt: new Date().toISOString(),
      findings: [],
      pages: [
        {
          url: r.targetUrl,
          browser: 'chromium',
          device: 'desktop',
          status: 'completed',
          sources: ['runtime', 'network', 'layout', 'accessibility', 'seo', 'lighthouse'],
          metrics: {
            performance: v,
            accessibility: 100,
            seo: 100,
            bestPractices: 100,
            lcp: 1000 + i * 100,
            fcp: 500,
            cls: 0.01,
            tbt: 30,
            ttfb: 20,
          },
        },
      ],
    })),
    tests: {
      id: crypto.randomUUID(),
      status: 'passed',
      completedAt: new Date().toISOString(),
      results: [
        {
          caseId: testcase.id,
          revision: 1,
          browser: 'chromium',
          device: 'desktop',
          status: 'passed',
          stepCount: 2,
          passedSteps: 2,
        },
      ],
    },
  };
}
function passed(environmentId = 'preview') {
  const r = release(environmentId);
  r.evidence = evidence(r);
  put('release', r);
  return evaluateRelease(r.id);
}
test('旧环境兼容并默认保护生产；策略更新要求版本一致', () => {
  assert.equal(project.environments[1].kind, 'production');
  assert.equal(project.environments[1].protected, true);
  const p = policyFor(project.id, 'preview');
  const { id, revision, updatedAt, ...data } = p;
  assert.throws(() => savePolicy(data, 0), /修改/);
});
test('真实证据语义：采样中位数，缺失/重复/部分覆盖/空测试均不通过', () => {
  assert.equal(median([100, 10, 50]), 50);
  const r = release();
  r.evidence = evidence(r);
  assert.equal(evaluate(r).status, 'passed');
  assert.equal(evaluate(r).metrics[0].metrics.performance, 92);
  for (const mutate of [
    (e: ReleaseEvidence) => {
      e.scans[0].pages[0].metrics!.lcp = null;
    },
    (e: ReleaseEvidence) => {
      e.scans[1].id = e.scans[0].id;
    },
    (e: ReleaseEvidence) => {
      e.scans[0].status = 'partial';
    },
    (e: ReleaseEvidence) => {
      e.tests = undefined;
    },
    (e: ReleaseEvidence) => {
      e.scans[0].pages[0].sources = ['lighthouse'];
    },
  ]) {
    const next = structuredClone(r);
    mutate(next.evidence!);
    assert.notEqual(evaluate(next).status, 'passed');
  }
});
test('指标边界、时效与来源失败闭合', () => {
  const r = release();
  r.evidence = evidence(r, [0, 10]);
  assert.notEqual(evaluate(r).status, 'passed');
  r.evidence = evidence(r);
  r.evidence.source = 'local-runner';
  assert.equal(evaluate(r).status, 'blocked');
  r.evidence.source = 'platform';
  r.evidence.scans[0].completedAt = new Date(Date.now() - 172800000).toISOString();
  assert.notEqual(evaluate(r).status, 'passed');
  r.evidence = evidence(r);
  r.evidence.profileHash = '0'.repeat(64);
  assert.equal(evaluate(r).status, 'blocked');
});
test('固定用例版本与完整步骤，待视觉基线不可被当成通过', () => {
  const r = release();
  r.evidence = evidence(r);
  r.evidence.tests!.results[0].revision = 2;
  assert.notEqual(evaluate(r).status, 'passed');
  r.evidence = evidence(r);
  r.evidence.tests!.results[0].passedSteps = 1;
  assert.notEqual(evaluate(r).status, 'passed');
  r.evidence = evidence(r);
  r.evidence.tests!.results[0].status = 'needs_baseline';
  assert.notEqual(evaluate(r).status, 'passed');
});
test('版本基线固定证据，跨环境匹配路径，退化与配置不兼容会阻断', () => {
  const b = passed(),
    r = release('production', b.id);
  r.evidence = evidence(r);
  put('release', r);
  let evaluated = evaluateRelease(r.id);
  assert.equal(evaluated.evaluation?.comparison?.compatible, true);
  assert.ok(evaluated.evaluation?.comparison?.metrics.length);
  const changed = structuredClone(b);
  changed.evidence!.scans[0].pages[0].metrics!.performance = 1;
  put('release', changed);
  evaluated = evaluateRelease(r.id);
  assert.equal(
    evaluated.evaluation?.comparison?.metrics.find((m) => m.metric === 'performance')?.before,
    92,
  );
  const regression = structuredClone(r);
  regression.evidence!.scans.forEach((s) => {
    s.pages[0].metrics!.lcp = 3000;
  });
  assert.notEqual(evaluate(regression, r.baselineSnapshot).status, 'passed');
  const incompatible = structuredClone(r);
  incompatible.policy.devices = ['mobile'];
  assert.equal(evaluate(incompatible, r.baselineSnapshot).comparison?.compatible, false);
});
test('保护环境审批绑定具体评估，部署 Commit 必须相同，登记幂等', () => {
  let r = passed('production');
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(exitCode(r), 3);
  assert.match(releaseJUnit(r), /release|发布就绪状态/);
  assert.throws(
    () =>
      registerDeployment(r.id, {
        commit: r.commit,
        actor: 'tester',
        note: '',
        url: r.environmentUrl,
        source: 'manual',
      }),
    /就绪/,
  );
  r = approveRelease(r.id, 'reviewer', '已核实风险');
  assert.equal(r.status, 'ready');
  r = evaluateRelease(r.id);
  assert.equal(r.approval, undefined);
  r = approveRelease(r.id, 'reviewer', '再次审批');
  assert.throws(
    () =>
      registerDeployment(r.id, {
        commit: 'fffffff',
        actor: 'tester',
        note: '',
        url: r.environmentUrl,
        source: 'ci',
      }),
    /Commit/,
  );
  const d = registerDeployment(r.id, {
    commit: r.commit,
    actor: 'tester',
    note: '已完成外部部署',
    url: r.environmentUrl,
    source: 'manual',
  });
  assert.equal(
    registerDeployment(r.id, {
      commit: r.commit,
      actor: 'again',
      note: '',
      url: r.environmentUrl,
      source: 'manual',
    }).id,
    d.id,
  );
  assert.equal(get<Release>('release', r.id)!.status, 'deployed');
});
test('策略变更不改历史结论，但会撤销部署资格，显式刷新后重新判断', () => {
  let r = passed();
  const p = policyFor(project.id, 'preview'),
    { id, revision, updatedAt, ...input } = p;
  savePolicy({ ...input, minPerformance: 99 }, revision);
  assert.throws(
    () =>
      registerDeployment(r.id, {
        commit: r.commit,
        actor: 'CI',
        note: '',
        url: r.environmentUrl,
        source: 'ci',
      }),
    /策略/,
  );
  r = refreshPolicy(r.id);
  assert.equal(r.status, 'blocked');
  assert.equal(r.policy.revision, revision + 1);
  assert.ok(all('gateEvaluation').length > 1);
});

test('CI 实时资格失效时不能返回成功，报告序列化不修改历史检查', () => {
  const r = release();
  r.evidence = evidence(r);
  r.evaluation = evaluate(r);
  r.status = 'ready';
  r.readiness = { ready: false, reason: '策略已更新', checkedAt: new Date().toISOString() };
  const previous = JSON.stringify(r.evaluation);
  assert.equal(exitCode(r), 1);
  assert.match(releaseJUnit(r), /当前准入资格/);
  assert.equal(JSON.stringify(r.evaluation), previous);
});
test('Local Runner 库拒绝在已初始化平台数据库的进程内执行', async () => {
  const { runLocalJob } = await import('../apps/server/src/releases/local-runner.js');
  let called = false;
  await assert.rejects(
    runLocalJob(
      async () => {
        called = true;
        return {};
      },
      'job',
      '/tmp',
      async () => Buffer.alloc(0),
    ),
    /独立进程/,
  );
  assert.equal(called, false);
});
