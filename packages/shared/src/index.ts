import { z } from 'zod';
export const environmentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  url: z.string().url().max(2048),
});
export const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  environments: z
    .array(environmentSchema)
    .min(1)
    .max(8)
    .refine((a) => new Set(a.map((e) => e.id)).size === a.length, '环境 ID 不能重复'),
  gate: z
    .object({
      minPerformance: z.number().min(0).max(100),
      maxLcp: z.number().min(100).max(30000),
      maxCls: z.number().min(0).max(1),
      maxCritical: z.number().int().min(0).max(100),
    })
    .default({ minPerformance: 80, maxLcp: 2500, maxCls: 0.1, maxCritical: 0 }),
});
export const scanSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  release: z.string().max(100).default(''),
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
  maxPages: z.number().int().min(1).max(10).default(1),
  lighthouse: z.boolean().default(true),
  paths: z
    .array(
      z
        .string()
        .max(2048)
        .refine(
          (p) => p.startsWith('/') && !p.startsWith('//') && !p.includes('\\'),
          '请输入站内路径',
        ),
    )
    .max(10)
    .default([]),
});
export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type DeviceName = 'desktop' | 'mobile';
export type ProjectInput = z.infer<typeof projectSchema>;
export type Project = ProjectInput & { id: string; createdAt: string };
export type ScanConfig = z.infer<typeof scanSchema>;
export type Source =
  'runtime' | 'network' | 'layout' | 'accessibility' | 'seo' | 'lighthouse' | 'functional';
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export const issueStatuses = [
  'open',
  'in_progress',
  'pending_verification',
  'resolved',
  'ignored',
] as const;
export type IssueStatus = (typeof issueStatuses)[number];
export type Finding = {
  fingerprint: string;
  rule: string;
  source: Source;
  title: string;
  severity: Severity;
  url: string;
  browser: BrowserName;
  device: DeviceName;
  evidence: string;
  recommendation: string;
  screenshot?: string;
  certainty: 'confirmed' | 'suspected';
};
export type Issue = Finding & {
  id: string;
  projectId: string;
  environmentId: string;
  status: IssueStatus;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  lastScanId: string;
  diagnosis?: Diagnosis;
  testCaseId?: string;
  testRevision?: number;
  lastTestRunId?: string;
};
export type Metrics = {
  performance: number | null;
  accessibility: number | null;
  seo: number | null;
  bestPractices: number | null;
  lcp: number | null;
  fcp: number | null;
  cls: number | null;
  tbt: number | null;
  ttfb: number | null;
};
export type PageResult = {
  url: string;
  browser: BrowserName;
  device: DeviceName;
  title: string;
  status: 'completed' | 'failed';
  error?: string;
  screenshot?: string;
  metrics?: Metrics;
  sources: Source[];
  duration: number;
  lighthouseReport?: string;
};
export type Scan = ScanConfig & {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  createdAt: string;
  completedAt?: string;
  progress: number;
  stage: string;
  pages: PageResult[];
  findings: Finding[];
  logs: { time: string; message: string }[];
  error?: string;
  gate?: {
    passed: boolean;
    checks: { name: string; passed: boolean; actual: string; expected: string }[];
  };
  comparison?: {
    baselineId: string;
    added: number;
    persistent: number;
    removed: number;
    metricDeltas: {
      metric: string;
      before: number;
      after: number;
      delta: number;
      url: string;
      device: string;
    }[];
  };
};
export type Diagnosis = {
  provider: 'rules' | 'ai';
  summary: string;
  rootCause: string;
  steps: string[];
  verification: string[];
  confidence: 'medium' | 'low';
  generatedAt: string;
  model?: string;
};
