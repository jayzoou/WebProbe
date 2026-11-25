import { all, get, put, uid, now } from '../store.js';
import { validateUrl } from '../security.js';
import { projectSchema, type Project } from '../../../../packages/shared/src/index.js';
import type { TestCase } from '../../../../packages/shared/src/testing.js';
import {
  policyInputSchema,
  releaseInputSchema,
  type ReleasePolicy,
  type Release,
  type ReleaseInput,
  type ReleaseEvent,
  type Deployment,
  type GateEvaluation,
  type RunnerJob,
} from '../../../../packages/shared/src/releases.js';
import { evaluate, profileHash } from './evaluator.js';
export class ReleaseError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 429 = 400,
  ) {
    super(message);
  }
}
export function required<T>(kind: string, id: string): T {
  const item = get<T>(kind, id);
  if (!item) throw new ReleaseError('记录不存在', 404);
  return item;
}
export function projectFor(id: string): Project {
  const p = required<Project>('project', id);
  return { ...projectSchema.parse(p), id: p.id, createdAt: p.createdAt };
}
export function policyFor(projectId: string, environmentId: string): ReleasePolicy {
  const p = projectFor(projectId);
  if (!p.environments.some((e) => e.id === environmentId))
    throw new ReleaseError('环境不存在', 404);
  const id = `${projectId}:${environmentId}`;
  return (
    get<ReleasePolicy>('releasePolicy', id) || {
      ...policyInputSchema.parse({ projectId, environmentId }),
      id,
      revision: 0,
      updatedAt: p.createdAt,
    }
  );
}
export function savePolicy(input: unknown, expectedRevision: number) {
  const data = policyInputSchema.parse(input),
    old = policyFor(data.projectId, data.environmentId);
  if (old.revision !== expectedRevision) throw new ReleaseError('策略已被修改，请重新载入', 409);
  const cases = data.caseIds.map((id) => get<TestCase>('testCase', id));
  if (cases.some((c) => !c || c.projectId !== data.projectId || c.archived))
    throw new ReleaseError('策略包含不可用的测试用例');
  return put<ReleasePolicy>('releasePolicy', {
    ...data,
    browsers: [...new Set(data.browsers)],
    devices: [...new Set(data.devices)],
    caseIds: [...new Set(data.caseIds)],
    id: old.id,
    revision: old.revision + 1,
    updatedAt: now(),
  });
}
export function event(releaseId: string, type: string, message: string) {
  return put<ReleaseEvent>('releaseEvent', {
    id: uid(),
    releaseId,
    type,
    message,
    createdAt: now(),
  });
}
export function createRelease(input: ReleaseInput, parentReleaseId?: string) {
  const data = releaseInputSchema.parse(input),
    project = projectFor(data.projectId),
    env = project.environments.find((e) => e.id === data.environmentId);
  if (!env || env.archived) throw new ReleaseError('环境不存在或已归档');
  if (
    all<Release>('release').some(
      (r) =>
        r.projectId === data.projectId &&
        r.environmentId === data.environmentId &&
        r.version === data.version,
    )
  )
    throw new ReleaseError('此环境中已存在相同版本，请重试原发布记录', 409);
  const targetUrl = validateUrl(data.targetUrl || env.url).href;
  const policy = policyFor(data.projectId, data.environmentId);
  const cases = policy.requireTests
    ? policy.caseIds.map((id) => required<TestCase>('testCase', id))
    : [];
  if (cases.some((c) => c.archived || c.projectId !== data.projectId))
    throw new ReleaseError('策略测试用例不可用');
  if (data.baselineId) {
    const b = required<Release>('release', data.baselineId);
    if (b.projectId !== data.projectId) throw new ReleaseError('基线必须属于同一项目');
  }
  const snapshot = structuredClone(project);
  snapshot.environments = snapshot.environments.map((e) =>
    e.id === env.id ? { ...e, url: targetUrl } : e,
  );
  const item: Release = {
    ...data,
    id: uid(),
    createdAt: now(),
    status: 'draft',
    stage: '等待质量验证',
    progress: 0,
    attempt: 0,
    targetUrl,
    environmentUrl: env.url,
    projectSnapshot: snapshot,
    policy,
    cases,
    profileHash: profileHash(policy, cases),
    parentReleaseId,
  };
  if (data.baselineId) {
    const b = required<Release>('release', data.baselineId);
    if (b.evaluation?.status !== 'passed') throw new ReleaseError('基线必须已通过质量准入');
    const {
      id,
      projectId,
      environmentId,
      version,
      profileHash,
      policy,
      cases,
      evidence,
      evaluation,
    } = b;
    item.baselineSnapshot = structuredClone({
      id,
      projectId,
      environmentId,
      version,
      profileHash,
      policy,
      cases,
      evidence,
      evaluation,
    });
  }
  put('release', item);
  event(item.id, 'created', `创建 ${item.version} · Commit ${item.commit}`);
  return item;
}
export function evaluateRelease(id: string) {
  const release = required<Release>('release', id);
  if (['checking', 'waiting_runner', 'cancelled', 'deployed'].includes(release.status))
    throw new ReleaseError('当前状态不能重新评估', 409);
  const baseline = release.baselineSnapshot;
  const evaluation = evaluate(release, baseline);
  put('gateEvaluation', evaluation);
  release.evaluation = evaluation;
  release.approval = undefined;
  const env = release.projectSnapshot.environments.find((e) => e.id === release.environmentId)!;
  release.status =
    evaluation.status === 'passed' ? (env.protected ? 'awaiting_approval' : 'ready') : 'blocked';
  release.stage = evaluation.status === 'passed' ? '质量标准满足' : '质量标准未满足';
  release.progress = 100;
  put('release', release);
  event(id, 'evaluated', `准入 ${evaluation.status} · 策略 v${release.policy.revision}`);
  return release;
}
export function refreshPolicy(id: string) {
  const release = required<Release>('release', id);
  if (['checking', 'waiting_runner', 'deployed'].includes(release.status))
    throw new ReleaseError('请先结束活动验证，已部署记录不可改写', 409);
  const p = projectFor(release.projectId),
    env = p.environments.find((e) => e.id === release.environmentId);
  if (!env || env.archived) throw new ReleaseError('环境不可用');
  release.policy = policyFor(release.projectId, release.environmentId);
  release.cases = release.policy.requireTests
    ? release.policy.caseIds.map((id) => required<TestCase>('testCase', id))
    : [];
  release.profileHash = profileHash(release.policy, release.cases);
  release.projectSnapshot = {
    ...p,
    environments: p.environments.map((e) =>
      e.id === env.id ? { ...e, url: release.targetUrl } : e,
    ),
  };
  release.approval = undefined;
  release.status = 'draft';
  put('release', release);
  event(id, 'policy-refreshed', `采用当前策略 v${release.policy.revision}，原审批失效`);
  return evaluateRelease(id);
}
export function freshGate(release: Release) {
  if (!release.evaluation || release.evaluation.status !== 'passed')
    throw new ReleaseError('质量准入尚未通过', 409);
  if (release.policy.revision !== policyFor(release.projectId, release.environmentId).revision)
    throw new ReleaseError('质量策略已更新，请采用新策略重新评估', 409);
  const current = evaluate(release, release.baselineSnapshot);
  if (current.status !== 'passed')
    throw new ReleaseError('证据已过期或不再满足准入条件，请重新验证', 409);
  const env = projectFor(release.projectId).environments.find(
      (e) => e.id === release.environmentId,
    ),
    snapshot = release.projectSnapshot.environments.find((e) => e.id === release.environmentId);
  if (
    !env ||
    env.archived ||
    env.url !== release.environmentUrl ||
    env.protected !== snapshot?.protected ||
    env.kind !== snapshot?.kind
  )
    throw new ReleaseError('环境已改变，请重新创建发布', 409);
  return env;
}
export function approveRelease(id: string, actor: string, note: string) {
  const release = required<Release>('release', id);
  if (!['ready', 'awaiting_approval'].includes(release.status))
    throw new ReleaseError('当前状态不能审批', 409);
  freshGate(release);
  release.approval = { evaluationId: release.evaluation!.id, actor, note, createdAt: now() };
  release.status = 'ready';
  put('release', release);
  event(id, 'approved', `${actor} 确认发布风险：${note}`);
  return release;
}
export function registerDeployment(
  id: string,
  input: { commit: string; actor: string; note: string; url: string; source: 'manual' | 'ci' },
) {
  const r = required<Release>('release', id);
  const previous = all<Deployment>('deployment').find((d) => d.releaseId === id);
  if (previous) {
    if (previous.commit !== input.commit) throw new ReleaseError('登记 Commit 与原记录不符', 409);
    return previous;
  }
  if (r.status !== 'ready') throw new ReleaseError('发布尚未就绪或缺少审批', 409);
  const env = freshGate(r);
  if (input.commit.toLowerCase() !== r.commit.toLowerCase())
    throw new ReleaseError('部署 Commit 与验证版本不一致', 409);
  if (env.protected && r.approval?.evaluationId !== r.evaluation?.id)
    throw new ReleaseError('保护环境需要针对本次评估的审批', 409);
  const url = validateUrl(input.url).href;
  if (new URL(url).origin !== new URL(env.url).origin)
    throw new ReleaseError('部署地址必须属于目标环境');
  const old = all<Deployment>('deployment').find(
    (d) => d.projectId === r.projectId && d.environmentId === r.environmentId,
  );
  const deployment: Deployment = {
    ...input,
    url,
    id: uid(),
    releaseId: id,
    projectId: r.projectId,
    environmentId: r.environmentId,
    version: r.version,
    commit: r.commit,
    evaluationId: r.evaluation!.id,
    registeredAt: now(),
    previousId: old?.id,
  };
  put('deployment', deployment);
  put('release', { ...r, status: 'deployed', stage: '部署已登记（由调用方声明）' });
  event(id, 'deployment-registered', `${input.actor} 登记部署 · ${input.source} · ${r.commit}`);
  return deployment;
}
export function promote(id: string, environmentId: string, targetUrl?: string) {
  const source = required<Release>('release', id);
  if (!['ready', 'deployed'].includes(source.status))
    throw new ReleaseError('仅可晋级已通过的版本', 409);
  freshGate(source);
  if (environmentId === source.environmentId) throw new ReleaseError('请选择不同目标环境');
  const promoted = createRelease(
    {
      projectId: source.projectId,
      environmentId,
      version: source.version,
      commit: source.commit,
      branch: source.branch,
      targetUrl,
      notes: `从 ${source.environmentId} 晋级；目标环境需要重新检测`,
      ci: source.ci,
    },
    id,
  );
  event(id, 'promoted', `晋级到 ${environmentId}，新发布 ${promoted.id}`);
  return promoted;
}
export function beginAttempt(release: Release) {
  if (['checking', 'waiting_runner', 'deployed'].includes(release.status))
    throw new ReleaseError('已有活动验证或版本已部署', 409);
  for (const job of all<RunnerJob>('runnerJob').filter(
    (j) => j.releaseId === release.id && ['pending', 'claimed'].includes(j.status),
  ))
    put('runnerJob', { ...job, status: 'cancelled' });
  release.attempt++;
  release.status = 'checking';
  release.stage = '准备质量验证';
  release.progress = 0;
  release.evaluation = undefined;
  release.approval = undefined;
  release.evidence = undefined;
  release.error = undefined;
  release.activeScanId = undefined;
  release.activeTestRunId = undefined;
  return put('release', release);
}
export function recoverReleases() {
  for (const r of all<Release>('release'))
    if (r.status === 'checking') {
      put('release', {
        ...r,
        status: 'blocked',
        error: '服务重启，质量验证已中断',
        stage: '请重新验证',
      });
      event(r.id, 'interrupted', '服务重启，证据未完成，不判为通过');
    }
}

export function selectBaseline(id: string, baselineId: string | null) {
  const r = required<Release>('release', id);
  if (['checking', 'waiting_runner', 'deployed'].includes(r.status))
    throw new ReleaseError('当前状态不能切换基线', 409);
  if (baselineId) {
    const b = required<Release>('release', baselineId);
    if (b.id === r.id || b.projectId !== r.projectId || b.evaluation?.status !== 'passed')
      throw new ReleaseError('基线必须为同项目另一个已通过版本');
    const {
      id,
      projectId,
      environmentId,
      version,
      profileHash,
      policy,
      cases,
      evidence,
      evaluation,
    } = b;
    r.baselineId = b.id;
    r.baselineSnapshot = structuredClone({
      id,
      projectId,
      environmentId,
      version,
      profileHash,
      policy,
      cases,
      evidence,
      evaluation,
    });
  } else {
    r.baselineId = undefined;
    r.baselineSnapshot = undefined;
  }
  r.status = 'draft';
  r.approval = undefined;
  put('release', r);
  event(id, 'baseline-selected', baselineId ? '切换版本基线 ' + baselineId : '清除基线');
  return evaluateRelease(id);
}

export function readiness(r: Release): NonNullable<Release['readiness']> {
  const checkedAt = now();
  if (!['ready', 'deployed'].includes(r.status))
    return { ready: false, reason: '发布状态 ' + r.status, checkedAt };
  try {
    const env = freshGate(r);
    if (env.protected && r.approval?.evaluationId !== r.evaluation?.id)
      throw new ReleaseError('缺少本次评估审批', 409);
    return { ready: true, checkedAt };
  } catch (e) {
    return { ready: false, reason: (e as Error).message, checkedAt };
  }
}
