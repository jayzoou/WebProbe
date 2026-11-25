import { z } from 'zod';
import type { Project, Metrics } from './index.js';
import type { TestCase, VisualBaseline } from './testing.js';
const path = z
  .string()
  .max(2048)
  .refine((p) => p.startsWith('/') && !p.startsWith('//') && !p.includes('\\'), '必须为站内路径');
export const policyInputSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    name: z.string().trim().min(1).max(100).default('发布质量标准'),
    browsers: z
      .array(z.enum(['chromium', 'firefox', 'webkit']))
      .min(1)
      .max(3)
      .default(['chromium']),
    devices: z
      .array(z.enum(['desktop', 'mobile']))
      .min(1)
      .max(2)
      .default(['desktop']),
    samples: z.number().int().min(1).max(3).default(2),
    maxPages: z.number().int().min(1).max(5).default(1),
    paths: z.array(path).max(5).default([]),
    minPerformance: z.number().min(0).max(100).default(80),
    maxLcp: z.number().min(100).max(30000).default(2500),
    maxCls: z.number().min(0).max(1).default(0.1),
    maxTbt: z.number().min(0).max(30000).default(300),
    maxCritical: z.number().int().min(0).max(1000).default(0),
    maxNewIssues: z.number().int().min(0).max(1000).default(0),
    maxLcpRegressionPct: z.number().min(0).max(1000).default(15),
    requireBaseline: z.boolean().default(false),
    requireTests: z.boolean().default(true),
    caseIds: z.array(z.string().min(1)).max(10).default([]),
    minTestPassRate: z.number().min(0).max(100).default(100),
    allowInteractions: z.boolean().default(false),
    allowWrites: z.boolean().default(false),
    allowRunnerEvidence: z.boolean().default(false),
    maxAgeMinutes: z.number().int().min(1).max(10080).default(1440),
  })
  .strict()
  .superRefine((p, c) => {
    if (!p.browsers.includes('chromium'))
      c.addIssue({ code: 'custom', message: '发布性能审计必须包含 Chromium' });
    if (p.paths.length + 1 > p.maxPages)
      c.addIssue({ code: 'custom', message: '页数必须覆盖入口及指定路径' });
  });
export type ReleasePolicy = z.infer<typeof policyInputSchema> & {
  id: string;
  revision: number;
  updatedAt: string;
};
export const releaseInputSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    version: z.string().trim().min(1).max(100),
    commit: z.string().regex(/^[a-fA-F0-9]{7,64}$/, '请输入 7–64 位十六进制 Commit SHA'),
    branch: z.string().max(200).default(''),
    targetUrl: z.string().url().max(2048).optional(),
    baselineId: z.string().optional(),
    notes: z.string().max(4000).default(''),
    ci: z
      .object({
        provider: z.enum(['github', 'gitlab', 'generic']),
        runId: z.string().max(200),
        runUrl: z
          .string()
          .url()
          .refine((v) => /^https?:/.test(v))
          .optional(),
        repository: z.string().max(300).default(''),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ReleaseInput = z.infer<typeof releaseInputSchema>;
const finite = z.number().finite().min(0).nullable();
export const metricsSchema = z
  .object({
    performance: finite.refine((v) => v === null || v <= 100),
    accessibility: finite,
    seo: finite,
    bestPractices: finite,
    lcp: finite,
    fcp: finite,
    cls: finite,
    tbt: finite,
    ttfb: finite,
  })
  .strict();
export const scanEvidenceSchema = z
  .object({
    id: z.string().min(1).max(100),
    status: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    completedAt: z.string().datetime(),
    pages: z
      .array(
        z
          .object({
            url: z.string().url().max(2048),
            browser: z.enum(['chromium', 'firefox', 'webkit']),
            device: z.enum(['desktop', 'mobile']),
            status: z.enum(['completed', 'failed']),
            sources: z
              .array(z.enum(['runtime', 'network', 'layout', 'accessibility', 'seo', 'lighthouse']))
              .max(6),
            metrics: metricsSchema.optional(),
            error: z.string().max(5000).optional(),
          })
          .strict(),
      )
      .max(30),
    findings: z
      .array(
        z
          .object({
            key: z.string().max(500),
            severity: z.enum(['P0', 'P1', 'P2', 'P3']),
            title: z.string().max(500),
            path: z.string().max(2048),
            browser: z.string().max(30),
            device: z.string().max(30),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export const testEvidenceSchema = z
  .object({
    id: z.string().min(1).max(100),
    status: z.enum(['passed', 'failed', 'needs_baseline', 'cancelled']),
    completedAt: z.string().datetime(),
    results: z
      .array(
        z
          .object({
            caseId: z.string().max(100),
            revision: z.number().int().positive(),
            browser: z.enum(['chromium', 'firefox', 'webkit']),
            device: z.enum(['desktop', 'mobile']),
            status: z.enum(['passed', 'failed', 'blocked', 'needs_baseline', 'cancelled']),
            stepCount: z.number().int().min(0).max(40),
            passedSteps: z.number().int().min(0).max(40),
            error: z.string().max(6000).optional(),
          })
          .strict(),
      )
      .max(60),
  })
  .strict();
export const submissionSchema = z
  .object({
    profileHash: z.string().length(64),
    scans: z.array(scanEvidenceSchema).max(3),
    tests: testEvidenceSchema.optional(),
    platform: z
      .object({
        os: z.string().max(100),
        node: z.string().max(100),
        runnerVersion: z.literal('3.0.0'),
      })
      .strict(),
  })
  .strict();
export type ScanEvidence = z.infer<typeof scanEvidenceSchema>;
export type TestEvidence = z.infer<typeof testEvidenceSchema>;
export type Submission = z.infer<typeof submissionSchema>;
export type ReleaseEvidence = {
  id: string;
  source: 'platform' | 'local-runner';
  profileHash: string;
  scans: ScanEvidence[];
  tests?: TestEvidence;
  receivedAt: string;
  runnerJobId?: string;
  platform?: Submission['platform'];
  artifacts: { name: string; url: string; bytes: number }[];
};
export type GateCheck = {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'blocked' | 'not_applicable';
  actual: string;
  expected: string;
};
export type ReleaseComparison = {
  baselineId: string;
  compatible: boolean;
  reason?: string;
  metrics: {
    path: string;
    browser: string;
    device: string;
    metric: keyof Metrics;
    before: number;
    after: number;
    delta: number;
    percent: number | null;
  }[];
  added: string[];
  removed: string[];
  persistent: number;
  tests: { caseId: string; browser: string; device: string; before: string; after: string }[];
};
export type GateEvaluation = {
  id: string;
  releaseId: string;
  policyRevision: number;
  evidenceId?: string;
  createdAt: string;
  status: 'passed' | 'failed' | 'blocked';
  checks: GateCheck[];
  comparison?: ReleaseComparison;
  metrics: { path: string; browser: string; device: string; metrics: Metrics; samples: number }[];
};
export type Release = ReleaseInput & {
  readiness?: { ready: boolean; reason?: string; checkedAt: string };
  id: string;
  createdAt: string;
  status:
    | 'draft'
    | 'checking'
    | 'waiting_runner'
    | 'ready'
    | 'awaiting_approval'
    | 'blocked'
    | 'deployed'
    | 'cancelled';
  stage: string;
  progress: number;
  attempt: number;
  targetUrl: string;
  environmentUrl: string;
  baselineSnapshot?: Pick<
    Release,
    | 'id'
    | 'projectId'
    | 'environmentId'
    | 'version'
    | 'profileHash'
    | 'policy'
    | 'cases'
    | 'evidence'
    | 'evaluation'
  >;
  projectSnapshot: Project;
  policy: ReleasePolicy;
  cases: TestCase[];
  profileHash: string;
  parentReleaseId?: string;
  evidence?: ReleaseEvidence;
  evaluation?: GateEvaluation;
  approval?: { evaluationId: string; actor: string; note: string; createdAt: string };
  activeScanId?: string;
  activeTestRunId?: string;
  runnerJobId?: string;
  error?: string;
};
export type RunnerJob = {
  id: string;
  releaseId: string;
  attempt: number;
  tokenHash: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'completed' | 'cancelled';
  createdAt: string;
  profileHash: string;
  projectSnapshot: Project;
  policy: ReleasePolicy;
  cases: TestCase[];
  baselines?: VisualBaseline[];
  commit: string;
  version: string;
  artifactBytes: number;
  uploadCount?: number;
  artifacts: ReleaseEvidence['artifacts'];
};
export type Deployment = {
  id: string;
  releaseId: string;
  projectId: string;
  environmentId: string;
  version: string;
  commit: string;
  evaluationId: string;
  registeredAt: string;
  actor: string;
  url: string;
  note: string;
  source: 'manual' | 'ci';
  previousId?: string;
};
export type ReleaseEvent = {
  id: string;
  releaseId: string;
  type: string;
  message: string;
  createdAt: string;
};
