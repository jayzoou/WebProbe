import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  submissionSchema,
  type RunnerJob,
  type Release,
  type ReleaseEvidence,
} from '../../../../packages/shared/src/releases.js';
import { all, get, put, uid, now, dataDir } from '../store.js';
import type { VisualBaseline } from '../../../../packages/shared/src/testing.js';
import { artifactFile } from '../testing/visual.js';
import { required, ReleaseError, beginAttempt, event, evaluateRelease } from './service.js';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function createRunnerJob(releaseId: string) {
  const r = beginAttempt(required<Release>('release', releaseId));
  const token = randomBytes(32).toString('base64url');
  const job: RunnerJob = {
    id: uid(),
    releaseId,
    attempt: r.attempt,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    status: 'pending',
    createdAt: now(),
    profileHash: r.profileHash,
    projectSnapshot: r.projectSnapshot,
    policy: r.policy,
    cases: r.cases,
    baselines: [
      ...new Map(
        all<VisualBaseline>('visualBaseline')
          .filter(
            (b) =>
              b.projectId === r.projectId &&
              b.environmentId === r.environmentId &&
              r.cases.some((c) => c.id === b.caseId),
          )
          .map((b) => [b.key, b] as const)
          .reverse(),
      ).values(),
    ].slice(0, 60),
    commit: r.commit,
    version: r.version,
    artifactBytes: 0,
    artifacts: [],
  };
  put('runnerJob', job);
  put('release', {
    ...r,
    status: 'waiting_runner',
    stage: '等待 Local Runner',
    runnerJobId: job.id,
  });
  event(releaseId, 'runner-created', `创建一次性 Runner 任务 ${job.id}，1 小时有效`);
  return { job: publicJob(job), token };
}
export function publicJob(job: RunnerJob) {
  const { tokenHash, ...safe } = job;
  return safe;
}
export function authorizeRunner(jobId: string, authorization?: string) {
  const job = get<RunnerJob>('runnerJob', jobId),
    token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!job || !token || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(job.tokenHash)))
    throw new ReleaseError('Runner 凭证无效', 401);
  if (Date.parse(job.expiresAt) < Date.now()) throw new ReleaseError('Runner 任务已过期', 410);
  if (!['pending', 'claimed'].includes(job.status))
    throw new ReleaseError('Runner 任务已结束或已取消', 409);
  const r = required<Release>('release', job.releaseId);
  if (r.status !== 'waiting_runner' || r.attempt !== job.attempt || r.runnerJobId !== job.id)
    throw new ReleaseError('Runner 已不属于当前验证尝试', 409);
  return job;
}
export function claimJob(job: RunnerJob) {
  if (job.status === 'pending') {
    job.status = 'claimed';
    put('runnerJob', job);
    event(job.releaseId, 'runner-claimed', `Runner 已领取 ${job.id}`);
  }
  return publicJob(job);
}
export function submitEvidence(job: RunnerJob, input: unknown) {
  const data = submissionSchema.parse(input);
  if (data.profileHash !== job.profileHash) throw new ReleaseError('Runner 配置指纹不匹配', 409);
  const r = required<Release>('release', job.releaseId),
    target = r.targetUrl;
  const current = required<RunnerJob>('runnerJob', job.id);
  if (current.status !== 'claimed' || r.status !== 'waiting_runner' || r.attempt !== job.attempt)
    throw new ReleaseError('任务已提交、取消或尚未领取', 409);
  for (const scan of data.scans)
    for (const p of scan.pages)
      if (new URL(p.url).origin !== new URL(target).origin)
        throw new ReleaseError('报告包含任务范围外的页面');
  const evidence: ReleaseEvidence = {
    id: uid(),
    source: 'local-runner',
    profileHash: data.profileHash,
    scans: data.scans,
    tests: data.tests,
    platform: data.platform,
    runnerJobId: job.id,
    receivedAt: now(),
    artifacts: required<RunnerJob>('runnerJob', job.id).artifacts,
  };
  put('runnerJob', { ...required<RunnerJob>('runnerJob', job.id), status: 'completed' });
  put('release', { ...r, evidence, status: 'draft', stage: 'Runner 已回传，正在判定准入' });
  event(r.id, 'runner-submitted', `接收 Runner 证据 · ${data.platform.os} · 单任务凭证已失效`);
  return evaluateRelease(r.id);
}
const uploadSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
      .refine((n) => /\.(png|json|html|zip)$/.test(n)),
    bytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    parts: z.number().int().min(1).max(64),
  })
  .strict();
type Upload = z.infer<typeof uploadSchema> & {
  id: string;
  jobId: string;
  received: number[];
  completed: boolean;
  url?: string;
};
const CHUNK = 128 * 1024;
export function beginUpload(job: RunnerJob, input: unknown) {
  const data = uploadSchema.parse(input);
  if (data.parts !== Math.ceil(data.bytes / CHUNK)) throw new ReleaseError('分片数量不正确');
  const current = required<RunnerJob>('runnerJob', job.id);
  if (current.artifactBytes + data.bytes > 32 * 1024 * 1024 || (current.uploadCount || 0) >= 60)
    throw new ReleaseError('Runner 附件额度已满', 429);
  const upload: Upload = { ...data, id: uid(), jobId: job.id, received: [], completed: false };
  put('runnerUpload', upload);
  put('runnerJob', {
    ...current,
    artifactBytes: current.artifactBytes + data.bytes,
    uploadCount: (current.uploadCount || 0) + 1,
  });
  return upload;
}
function scopedUpload(job: RunnerJob, id: string) {
  const u = required<Upload>('runnerUpload', id);
  if (u.jobId !== job.id) throw new ReleaseError('附件不属于此任务', 403);
  return u;
}
export async function uploadPart(job: RunnerJob, id: string, input: unknown) {
  const data = z
    .object({
      index: z.number().int().min(0).max(63),
      data: z
        .string()
        .max(180000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .strict()
    .parse(input);
  const upload = scopedUpload(job, id);
  if (upload.completed || data.index >= upload.parts) throw new ReleaseError('分片状态无效', 409);
  const bytes = Buffer.from(data.data, 'base64'),
    expected = data.index === upload.parts - 1 ? upload.bytes - (upload.parts - 1) * CHUNK : CHUNK;
  if (bytes.length !== expected || bytes.toString('base64') !== data.data)
    throw new ReleaseError('分片内容或长度无效');
  const folder = resolve(dataDir, 'runner-staging', id);
  await mkdir(folder, { recursive: true });
  const file = resolve(folder, String(data.index));
  try {
    await writeFile(file, bytes, { flag: 'wx' });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      hash(await readFile(file)) !== hash(bytes)
    )
      throw new ReleaseError('重复分片内容不一致', 409);
  }
  const current = scopedUpload(job, id);
  current.received = [...new Set([...current.received, data.index])];
  put('runnerUpload', current);
  return { received: current.received.length };
}
export async function completeUpload(job: RunnerJob, id: string) {
  const u = scopedUpload(job, id);
  if (u.completed) return { url: u.url };
  if (u.received.length !== u.parts) throw new ReleaseError('附件分片未完整上传', 409);
  const buffers = await Promise.all(
    Array.from({ length: u.parts }, (_, i) =>
      readFile(resolve(dataDir, 'runner-staging', id, String(i))),
    ),
  );
  const bytes = Buffer.concat(buffers);
  if (bytes.length !== u.bytes || hash(bytes) !== u.sha256) throw new ReleaseError('附件校验失败');
  const url = `/artifacts/${job.id}/${id}-${u.name}`;
  await mkdir(resolve(dataDir, 'artifacts', job.id), { recursive: true });
  await writeFile(artifactFile(url), bytes);
  const current = required<RunnerJob>('runnerJob', job.id);
  if (!current.artifacts.some((a) => a.url === url))
    put('runnerJob', {
      ...current,
      artifacts: [...current.artifacts, { name: u.name, url, bytes: u.bytes }],
    });
  put('runnerUpload', { ...u, completed: true, url });
  return { url };
}

export function failRunnerJob(job: RunnerJob, reason: string) {
  const current = required<RunnerJob>('runnerJob', job.id);
  if (!['pending', 'claimed'].includes(current.status)) throw new ReleaseError('任务已结束', 409);
  put('runnerJob', { ...current, status: 'cancelled' });
  const r = required<Release>('release', job.releaseId);
  put('release', { ...r, status: 'blocked', error: reason, stage: 'Runner 未完成验证' });
  event(r.id, 'runner-failed', reason);
  return required<Release>('release', r.id);
}
