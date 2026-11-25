import { createHash } from 'node:crypto';
import type { Finding, Scan, Metrics } from '../../../../packages/shared/src/index.js';
import type { TestCase, TestRun } from '../../../../packages/shared/src/testing.js';
import type {
  ReleasePolicy,
  Release,
  ScanEvidence,
  TestEvidence,
  ReleaseEvidence,
  GateEvaluation,
  ReleaseComparison,
  GateCheck,
} from '../../../../packages/shared/src/releases.js';
export function profileHash(policy: ReleasePolicy, cases: TestCase[]) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        browsers: policy.browsers,
        devices: policy.devices,
        samples: policy.samples,
        maxPages: policy.maxPages,
        paths: policy.paths,
        allowInteractions: policy.allowInteractions,
        allowWrites: policy.allowWrites,
        cases: cases.map((c) => ({ id: c.id, revision: c.revision, steps: c.steps })),
      }),
    )
    .digest('hex');
}
export function pagePath(url: string) {
  const u = new URL(url);
  return u.pathname + u.search;
}
export function findingKey(f: Finding) {
  let identity = '';
  if (f.source === 'runtime') {
    try {
      identity = JSON.parse(f.evidence).message || f.evidence.split('\n')[0];
    } catch {
      identity = f.evidence.split('\n')[0];
    }
  } else if (f.source === 'network')
    identity = f.evidence.replace(/https?:\/\/[^/\s]+/g, '').split('\n')[0];
  return createHash('sha256')
    .update(JSON.stringify([f.rule, pagePath(f.url), f.browser, f.device, identity]))
    .digest('hex')
    .slice(0, 24);
}
export function scanEvidence(scan: Scan): ScanEvidence {
  return {
    id: scan.id,
    status: scan.status === 'queued' || scan.status === 'running' ? 'failed' : scan.status,
    completedAt: scan.completedAt || new Date().toISOString(),
    pages: scan.pages.map((p) => ({
      url: p.url,
      browser: p.browser,
      device: p.device,
      status: p.status,
      sources: p.sources.filter((s) => s !== 'functional'),
      ...(p.metrics ? { metrics: p.metrics } : {}),
      ...(p.error ? { error: p.error.slice(0, 5000) } : {}),
    })),
    findings: scan.findings.map((f) => ({
      key: findingKey(f),
      severity: f.severity,
      title: f.title,
      path: pagePath(f.url),
      browser: f.browser,
      device: f.device,
    })),
  };
}
export function testEvidence(run: TestRun): TestEvidence {
  return {
    id: run.id,
    status: run.status === 'queued' || run.status === 'running' ? 'failed' : run.status,
    completedAt: run.completedAt || new Date().toISOString(),
    results: run.results.map((r) => ({
      caseId: r.testCase.id,
      revision: r.testCase.revision,
      browser: r.browser,
      device: r.device,
      status: r.status,
      stepCount: r.steps.length,
      passedSteps: r.steps.filter(
        (s) => s.status === 'passed' && (!s.visual || s.visual.status === 'passed'),
      ).length,
      ...(r.error ? { error: r.error.slice(0, 6000) } : {}),
    })),
  };
}
export function median(values: number[]) {
  if (!values.length) return null;
  const a = [...values].sort((a, b) => a - b),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function aggregated(evidence?: ReleaseEvidence) {
  const groups = new Map<
    string,
    { path: string; browser: string; device: string; list: Metrics[] }
  >();
  for (const s of evidence?.scans || [])
    for (const p of s.pages) {
      if (p.status !== 'completed' || !p.metrics) continue;
      const path = pagePath(p.url),
        key = JSON.stringify([path, p.browser, p.device]);
      const g = groups.get(key) || { path, browser: p.browser, device: p.device, list: [] };
      g.list.push(p.metrics);
      groups.set(key, g);
    }
  return [...groups.values()].map((g) => ({
    path: g.path,
    browser: g.browser,
    device: g.device,
    samples: g.list.length,
    metrics: Object.fromEntries(
      (
        [
          'performance',
          'accessibility',
          'seo',
          'bestPractices',
          'lcp',
          'fcp',
          'cls',
          'tbt',
          'ttfb',
        ] as const
      ).map((k) => [k, median(g.list.flatMap((m) => (m[k] === null ? [] : [m[k]])))]),
    ) as Metrics,
  }));
}
const findings = (e?: ReleaseEvidence) =>
  new Map((e?.scans || []).flatMap((s) => s.findings).map((f) => [f.key, f]));
export function compareReleases(
  current: Release,
  baseline: NonNullable<Release['baselineSnapshot']>,
): ReleaseComparison {
  const compatible =
    current.projectId === baseline.projectId &&
    JSON.stringify([
      current.policy.browsers,
      current.policy.devices,
      current.policy.samples,
      current.policy.maxPages,
      current.policy.paths,
    ]) ===
      JSON.stringify([
        baseline.policy.browsers,
        baseline.policy.devices,
        baseline.policy.samples,
        baseline.policy.maxPages,
        baseline.policy.paths,
      ]) &&
    !!baseline.evidence &&
    baseline.evaluation?.status === 'passed';
  const result: ReleaseComparison = {
    baselineId: baseline.id,
    compatible,
    reason: compatible
      ? undefined
      : '需要同一项目、相同页面/浏览器/设备/采样配置且已通过的基线证据',
    metrics: [],
    added: [],
    removed: [],
    persistent: 0,
    tests: [],
  };
  if (!compatible) return result;
  const before = aggregated(baseline.evidence),
    after = aggregated(current.evidence);
  for (const p of after) {
    const old = before.find(
      (o) => o.path === p.path && o.browser === p.browser && o.device === p.device,
    );
    if (!old) continue;
    for (const metric of ['performance', 'lcp', 'cls', 'tbt'] as const) {
      const a = old.metrics[metric],
        b = p.metrics[metric];
      if (a !== null && b !== null)
        result.metrics.push({
          path: p.path,
          browser: p.browser,
          device: p.device,
          metric,
          before: a,
          after: b,
          delta: b - a,
          percent: a === 0 ? (b === 0 ? 0 : null) : ((b - a) / a) * 100,
        });
    }
  }
  const covered = (
    r: Pick<Release, 'evidence' | 'policy'>,
    path: string,
    browser: string,
    device: string,
  ) =>
    r.evidence?.scans.length === r.policy.samples &&
    r.evidence.scans.every(
      (s) =>
        s.status === 'completed' &&
        s.pages.some(
          (p) =>
            pagePath(p.url) === path &&
            p.browser === browser &&
            p.device === device &&
            p.status === 'completed' &&
            !p.error,
        ),
    );
  const a = findings(baseline.evidence),
    b = findings(current.evidence);
  for (const [key, f] of b) {
    if (a.has(key)) result.persistent++;
    else if (covered(baseline, f.path, f.browser, f.device)) result.added.push(key);
  }
  for (const [key, f] of a)
    if (!b.has(key) && covered(current, f.path, f.browser, f.device)) result.removed.push(key);
  for (const t of current.evidence?.tests?.results || []) {
    const old = baseline.evidence?.tests?.results.find(
      (o) =>
        o.caseId === t.caseId &&
        o.revision === t.revision &&
        o.browser === t.browser &&
        o.device === t.device,
    );
    if (old)
      result.tests.push({
        caseId: t.caseId,
        browser: t.browser,
        device: t.device,
        before: old.status,
        after: t.status,
      });
  }
  return result;
}
export function evaluate(
  release: Release,
  baseline?: NonNullable<Release['baselineSnapshot']>,
  time = Date.now(),
): GateEvaluation {
  const p = release.policy,
    e = release.evidence,
    checks: GateCheck[] = [];
  const add = (
    id: string,
    name: string,
    pass: boolean,
    actual: string,
    expected: string,
    blocked = false,
  ) =>
    checks.push({
      id,
      name,
      status: pass ? 'passed' : blocked ? 'blocked' : 'failed',
      actual,
      expected,
    });
  add('evidence', '检测证据', !!e, e?.source || '尚无证据', '完整的真实检测结果', !e);
  add(
    'profile',
    '固定配置一致性',
    !!e && e.profileHash === release.profileHash,
    e?.profileHash.slice(0, 12) || '缺失',
    release.profileHash.slice(0, 12),
    true,
  );
  add(
    'source',
    '证据来源信任',
    !!e && (e.source === 'platform' || p.allowRunnerEvidence),
    e?.source || '缺失',
    p.allowRunnerEvidence ? '平台或明确授权的 Runner' : '平台执行；Runner 需策略显式信任',
    true,
  );
  const scans = e?.scans || [];
  add(
    'samples',
    '性能采样数量',
    scans.length === p.samples && new Set(scans.map((s) => s.id)).size === p.samples,
    String(scans.length),
    `${p.samples} 个独立采样`,
  );
  const times = [
    ...scans.map((s) => Date.parse(s.completedAt)),
    ...(e?.tests ? [Date.parse(e.tests.completedAt)] : []),
  ];
  const fresh =
    times.length > 0 &&
    times.every(
      (t) =>
        Number.isFinite(t) &&
        t >= Date.parse(release.createdAt) - 60000 &&
        t <= time + 300000 &&
        time - t <= p.maxAgeMinutes * 60000,
    );
  add(
    'freshness',
    '证据时效',
    fresh,
    fresh ? '在有效期内' : '缺失、早于本版本、过期或时间异常',
    `${p.maxAgeMinutes} 分钟内`,
  );
  add(
    'complete',
    '检测完整性',
    scans.length > 0 &&
      scans.every(
        (s) =>
          s.status === 'completed' &&
          s.pages.length > 0 &&
          s.pages.every(
            (pg) =>
              pg.status === 'completed' &&
              !pg.error &&
              ['runtime', 'network', 'layout', 'accessibility', 'seo'].every((src) =>
                pg.sources.includes(src as never),
              ),
          ),
      ),
    scans.map((s) => s.status).join(', ') || '无检测',
    '所有页面和必需检查完整完成',
  );
  const required = [
    ...new Set([
      pagePath(release.targetUrl),
      ...p.paths.map((path) => pagePath(new URL(path, release.targetUrl).href)),
    ]),
  ];
  const coverage =
    scans.length === p.samples &&
    scans.every((s) =>
      required.every((path) =>
        p.browsers.every((browser) =>
          p.devices.every(
            (device) =>
              s.pages.filter(
                (pg) => pagePath(pg.url) === path && pg.browser === browser && pg.device === device,
              ).length === 1,
          ),
        ),
      ),
    );
  add(
    'coverage',
    '页面与设备覆盖',
    coverage,
    `${required.length} 个指定页面 · ${p.browsers.length} 引擎 · ${p.devices.length} 设备`,
    '每次采样覆盖完整指定矩阵',
  );
  const metrics = aggregated(e);
  const expectedMetrics = required.length * p.devices.length;
  add(
    'metrics',
    'Lighthouse 指标依据',
    metrics.filter(
      (m) => m.browser === 'chromium' && required.includes(m.path) && m.samples === p.samples,
    ).length === expectedMetrics &&
      scans.length === p.samples &&
      scans.every((s) =>
        s.pages
          .filter((pg) => pg.browser === 'chromium')
          .every(
            (pg) =>
              pg.sources.includes('lighthouse') &&
              pg.metrics &&
              ['performance', 'lcp', 'cls', 'tbt'].every(
                (k) => pg.metrics![k as keyof Metrics] !== null,
              ),
          ),
      ),
    `${metrics.length} 个页面设备指标组`,
    'Chromium 所有采样具备真实指标',
  );
  for (const m of metrics.filter((m) => m.browser === 'chromium'))
    for (const [key, limit, minimum] of [
      ['performance', p.minPerformance, true],
      ['lcp', p.maxLcp, false],
      ['cls', p.maxCls, false],
      ['tbt', p.maxTbt, false],
    ] as const) {
      const v = m.metrics[key];
      add(
        `${m.path}:${m.device}:${key}`,
        `${m.path} · ${m.device} · ${key} 中位数`,
        v !== null && (minimum ? v >= limit : v <= limit),
        v === null ? '缺失' : String(Math.round(v * 1000) / 1000),
        `${minimum ? '≥' : '≤'} ${limit}`,
      );
    }
  const critical = [...findings(e).values()].filter(
    (f) => f.severity === 'P0' || f.severity === 'P1',
  ).length;
  add(
    'critical',
    '严重问题预算',
    critical <= p.maxCritical,
    String(critical),
    `≤ ${p.maxCritical} 个独立 P0/P1 问题`,
  );
  if (p.requireTests) {
    const t = e?.tests;
    const expected = release.cases.length * p.browsers.length * p.devices.length;
    const matched =
      release.cases.length === p.caseIds.length &&
      release.cases.length > 0 &&
      !!t &&
      t.results.length === expected &&
      new Set(t.results.map((r) => [r.caseId, r.browser, r.device].join('|'))).size === expected &&
      release.cases.every((c) =>
        p.browsers.every((b) =>
          p.devices.every((d) =>
            t.results.some(
              (r) =>
                r.caseId === c.id &&
                r.revision === c.revision &&
                r.browser === b &&
                r.device === d &&
                r.stepCount === c.steps.length,
            ),
          ),
        ),
      );
    add(
      'test-coverage',
      '必需测试版本与覆盖',
      matched,
      `${t?.results.length || 0}/${expected} 个组合`,
      '所有指定用例版本与矩阵完整执行',
    );
    const passed =
        t?.results.filter((r) => r.status === 'passed' && r.stepCount === r.passedSteps).length ||
        0,
      rate = expected ? (passed / expected) * 100 : 0;
    add(
      'test-pass',
      '功能测试通过率',
      matched &&
        rate >= p.minTestPassRate &&
        !!t &&
        ['passed', 'failed'].includes(t.status) &&
        t.results.every((r) => ['passed', 'failed'].includes(r.status)),
      `${Math.round(rate * 100) / 100}%`,
      `≥ ${p.minTestPassRate}% 且批次通过，无受阻或待基线`,
    );
  } else
    checks.push({
      id: 'tests-disabled',
      name: '功能测试范围',
      status: 'not_applicable',
      actual: '策略明确未要求功能测试',
      expected: '此结论不证明业务功能正确',
    });
  let comparison: ReleaseComparison | undefined;
  if (release.baselineId) {
    comparison = baseline ? compareReleases(release, baseline) : undefined;
    add(
      'baseline',
      '版本基线可比性',
      !!comparison?.compatible,
      comparison?.reason || baseline?.version || '基线不存在',
      '同项目、同配置、基线通过',
      true,
    );
    if (comparison?.compatible) {
      add(
        'new-issues',
        '新增问题预算',
        comparison.added.length <= p.maxNewIssues,
        String(comparison.added.length),
        `≤ ${p.maxNewIssues}`,
      );
      const lcp = comparison.metrics.filter((m) => m.metric === 'lcp');
      add(
        'regression',
        'LCP 相对退化预算',
        lcp.length >= expectedMetrics &&
          lcp.every((m) => m.percent !== null && m.percent <= p.maxLcpRegressionPct),
        lcp
          .map(
            (m) =>
              `${m.path} ${m.device}: ${m.percent === null ? '不可比' : m.percent.toFixed(1) + '%'}`,
          )
          .join('; ') || '无可比指标',
        `退化 ≤ ${p.maxLcpRegressionPct}%`,
      );
    }
  } else if (p.requireBaseline)
    add('baseline', '版本基线', false, '未选择基线', '策略要求一个已通过基线', true);
  else
    checks.push({
      id: 'baseline',
      name: '版本回归范围',
      status: 'not_applicable',
      actual: '首版或未选择基线，仅判断绝对标准',
      expected: '不声称已有版本回归结论',
    });
  return {
    id: crypto.randomUUID(),
    releaseId: release.id,
    policyRevision: p.revision,
    evidenceId: e?.id,
    createdAt: new Date(time).toISOString(),
    status: checks.some((c) => c.status === 'blocked')
      ? 'blocked'
      : checks.some((c) => c.status === 'failed')
        ? 'failed'
        : 'passed',
    checks,
    metrics,
    comparison,
  };
}
