import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type {
  Finding,
  Issue,
  Project,
  ProjectInput,
  Scan,
} from '../../../packages/shared/src/index.js';
export const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(resolve(dataDir, 'artifacts'), { recursive: true });
const db = new DatabaseSync(resolve(dataDir, 'webprobe.sqlite'));
db.exec(
  'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));',
);
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function all<T>(kind: string): T[] {
  return (
    db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind) as {
      body: string;
    }[]
  ).map((r) => JSON.parse(r.body));
}
export function get<T>(kind: string, id: string): T | undefined {
  const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id) as
    { body: string } | undefined;
  return row ? JSON.parse(row.body) : undefined;
}
export function put<T extends { id: string }>(kind: string, item: T): T {
  db.prepare(
    'INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
  ).run(kind, item.id, JSON.stringify(item));
  return item;
}
export function createProject(input: ProjectInput): Project {
  return put('project', { ...input, id: uid(), createdAt: now() });
}
export function fingerprint(f: Omit<Finding, 'fingerprint'>, identity = ''): string {
  const url = new URL(f.url);
  url.hash = '';
  return createHash('sha256')
    .update([f.rule, url.href, f.browser, f.device, identity].join('|'))
    .digest('hex')
    .slice(0, 24);
}
export function reconcile(scan: Scan) {
  const previous = all<Issue>('issue').filter(
    (i) => i.projectId === scan.projectId && i.environmentId === scan.environmentId,
  );
  const byKey = new Map(previous.map((i) => [i.fingerprint, i]));
  const seen = new Set<string>();
  db.exec('BEGIN');
  try {
    for (const f of scan.findings) {
      if (seen.has(f.fingerprint)) continue;
      seen.add(f.fingerprint);
      const old = byKey.get(f.fingerprint);
      put<Issue>('issue', {
        ...old,
        ...f,
        id: old?.id ?? uid(),
        projectId: scan.projectId,
        environmentId: scan.environmentId,
        status: old?.status === 'resolved' ? 'open' : (old?.status ?? 'open'),
        firstSeen: old?.firstSeen ?? scan.createdAt,
        lastSeen: scan.completedAt!,
        occurrences: (old?.occurrences ?? 0) + 1,
        lastScanId: scan.id,
      });
    }
    for (const old of previous) {
      const covered = scan.pages.some(
        (p) =>
          p.status === 'completed' &&
          p.url === old.url &&
          p.browser === old.browser &&
          p.device === old.device &&
          p.sources.includes(old.source),
      );
      if (covered && !seen.has(old.fingerprint) && old.status !== 'ignored')
        put('issue', { ...old, status: 'resolved' });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function finalize(scan: Scan, project: Project) {
  const checks = scan.pages
    .filter((p) => p.metrics)
    .flatMap((p) => {
      const m = p.metrics!;
      return [
        {
          name: `${new URL(p.url).pathname} · ${p.device} 性能评分`,
          passed: m.performance !== null && m.performance >= project.gate.minPerformance,
          actual: String(m.performance ?? '无数据'),
          expected: `≥ ${project.gate.minPerformance}`,
        },
        {
          name: `${p.device} LCP`,
          passed: m.lcp !== null && m.lcp <= project.gate.maxLcp,
          actual: m.lcp === null ? '无数据' : `${Math.round(m.lcp)} ms`,
          expected: `≤ ${project.gate.maxLcp} ms`,
        },
        {
          name: `${p.device} CLS`,
          passed: m.cls !== null && m.cls <= project.gate.maxCls,
          actual: String(m.cls ?? '无数据'),
          expected: `≤ ${project.gate.maxCls}`,
        },
      ];
    });
  checks.push({
    name: '检测完整性',
    passed: scan.status === 'completed',
    actual: scan.status,
    expected: 'completed',
  });
  if (!scan.pages.some((p) => p.metrics))
    checks.push({
      name: '性能质量依据',
      passed: false,
      actual: '未执行 Lighthouse',
      expected: '取得真实性能指标',
    });
  const critical = scan.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1').length;
  checks.push({
    name: '严重问题数',
    passed: critical <= project.gate.maxCritical,
    actual: String(critical),
    expected: `≤ ${project.gate.maxCritical}`,
  });
  scan.gate = { passed: checks.every((c) => c.passed), checks };
  const baseline = all<Scan>('scan').find(
    (s) =>
      s.id !== scan.id &&
      s.status === 'completed' &&
      s.projectId === scan.projectId &&
      s.environmentId === scan.environmentId &&
      JSON.stringify([s.browsers, s.devices, s.paths, s.maxPages, s.lighthouse]) ===
        JSON.stringify([scan.browsers, scan.devices, scan.paths, scan.maxPages, scan.lighthouse]),
  );
  if (baseline) {
    const covered = (f: Finding, pages: Scan['pages']) =>
      pages.some(
        (p) =>
          p.status === 'completed' &&
          p.url === f.url &&
          p.browser === f.browser &&
          p.device === f.device &&
          p.sources.includes(f.source),
      );
    const current = new Set(scan.findings.map((f) => f.fingerprint));
    const old = new Set(baseline.findings.map((f) => f.fingerprint));
    scan.comparison = {
      baselineId: baseline.id,
      added: scan.findings.filter((f) => !old.has(f.fingerprint) && covered(f, baseline.pages))
        .length,
      persistent: scan.findings.filter((f) => old.has(f.fingerprint)).length,
      removed: baseline.findings.filter(
        (f) => !current.has(f.fingerprint) && covered(f, scan.pages),
      ).length,
      metricDeltas: scan.pages.flatMap((p) => {
        const before = baseline.pages.find(
          (b) => b.url === p.url && b.device === p.device && b.browser === p.browser,
        )?.metrics;
        return (['performance', 'lcp', 'cls', 'tbt'] as const).flatMap((metric) =>
          before?.[metric] != null && p.metrics?.[metric] != null
            ? [
                {
                  metric,
                  before: before[metric]!,
                  after: p.metrics[metric]!,
                  delta: p.metrics[metric]! - before[metric]!,
                  url: p.url,
                  device: p.device,
                },
              ]
            : [],
        );
      }),
    };
  }
  reconcile(scan);
  put('scan', scan);
}
export function recoverInterrupted() {
  for (const s of all<Scan>('scan'))
    if (s.status === 'running' || s.status === 'queued')
      put('scan', {
        ...s,
        status: 'failed',
        stage: '服务重启，检测已中断，请重新运行',
        completedAt: now(),
      });
}
