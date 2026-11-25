import { z } from 'zod';
const path = z
  .string()
  .max(2048)
  .refine(
    (p) => p.startsWith('/') && !p.startsWith('//') && !p.includes('\\'),
    '必须为站内绝对路径',
  );
export const targetSchema = z
  .object({
    by: z.enum(['css', 'testId', 'label', 'role', 'text']),
    value: z.string().trim().min(1).max(500),
    name: z.string().max(200).optional(),
  })
  .strict();
const target = { target: targetSchema };
export const testStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), path }).strict(),
  z.object({ action: z.literal('click'), ...target }).strict(),
  z.object({ action: z.literal('fill'), ...target, value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('select'), ...target, value: z.string().max(500) }).strict(),
  z.object({ action: z.literal('check'), ...target, checked: z.boolean() }).strict(),
  z
    .object({
      action: z.literal('press'),
      ...target,
      key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']),
    })
    .strict(),
  z.object({ action: z.literal('assertVisible'), ...target }).strict(),
  z.object({ action: z.literal('assertHidden'), ...target }).strict(),
  z
    .object({ action: z.literal('assertText'), ...target, text: z.string().min(1).max(2000) })
    .strict(),
  z.object({ action: z.literal('assertUrl'), path }).strict(),
  z.object({ action: z.literal('assertNoErrors') }).strict(),
  z
    .object({
      action: z.literal('visual'),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
      maxDiffRatio: z.number().min(0).max(0.2).default(0.01),
      masks: z.array(z.string().min(1).max(300)).max(10).default([]),
    })
    .strict(),
]);
export const testCaseSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000).default(''),
    steps: z.array(testStepSchema).min(1).max(40),
    tags: z.array(z.string().max(40)).max(10).default([]),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.steps[0].action !== 'navigate')
      c.addIssue({ code: 'custom', message: '首步必须打开站内页面' });
    if (!v.steps.some((s) => s.action.startsWith('assert') || s.action === 'visual'))
      c.addIssue({ code: 'custom', message: '至少需要一个显式断言或视觉检查点' });
    const names = v.steps.filter((s) => s.action === 'visual').map((s) => s.name);
    if (new Set(names).size !== names.length)
      c.addIssue({ code: 'custom', message: '视觉检查点名称不能重复' });
  });
export const testRunSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    caseIds: z.array(z.string().min(1)).min(1).max(10),
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
    allowInteractions: z.boolean().default(false),
    allowWrites: z.boolean().default(false),
    release: z.string().max(100).default(''),
  })
  .strict();
export const generateSchema = z
  .object({
    projectId: z.string(),
    environmentId: z.string(),
    path: path.default('/'),
    goal: z.string().trim().min(4).max(4000),
  })
  .strict();
export const exploreSchema = z
  .object({
    projectId: z.string(),
    environmentId: z.string(),
    path: path.default('/'),
    maxActions: z.number().int().min(1).max(10).default(4),
    allowInteractions: z.boolean().default(false),
  })
  .strict();
export const recordSchema = z
  .object({
    projectId: z.string(),
    environmentId: z.string(),
    path: path.default('/'),
    name: z.string().trim().min(1).max(120),
    allowWrites: z.boolean().default(false),
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;
export type TestStep = z.infer<typeof testStepSchema>;
export type TestCaseInput = z.infer<typeof testCaseSchema>;
export type TestCase = TestCaseInput & {
  id: string;
  revision: number;
  origin: 'manual' | 'ai' | 'rules' | 'recording' | 'exploration' | 'import';
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type TestRunConfig = z.infer<typeof testRunSchema>;
export type VisualResult = {
  name: string;
  key: string;
  current: string;
  baseline?: string;
  diff?: string;
  diffRatio?: number;
  status: 'passed' | 'failed' | 'needs_baseline';
  maxDiffRatio: number;
  dimensionsChanged?: boolean;
};
export type StepResult = {
  index: number;
  action: TestStep['action'];
  status: 'passed' | 'failed' | 'blocked';
  duration: number;
  error?: string;
  screenshot?: string;
  visual?: VisualResult;
};
export type CaseResult = {
  id: string;
  testCase: TestCase;
  browser: 'chromium' | 'firefox' | 'webkit';
  device: 'desktop' | 'mobile';
  status: 'passed' | 'failed' | 'blocked' | 'needs_baseline' | 'cancelled';
  steps: StepResult[];
  errors: string[];
  failureSignature?: string;
  error?: string;
  trace?: string;
  screenshot?: string;
  duration: number;
  issueId?: string;
};
export type TestRun = TestRunConfig & {
  id: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'needs_baseline';
  cases: TestCase[];
  results: CaseResult[];
  createdAt: string;
  completedAt?: string;
  progress: number;
  stage: string;
  error?: string;
};
export type VisualBaseline = {
  id: string;
  key: string;
  projectId: string;
  environmentId: string;
  caseId: string;
  revision: number;
  browser: string;
  device: string;
  name: string;
  image: string;
  runId: string;
  approvedAt: string;
  previousId?: string;
};
export type Exploration = {
  id: string;
  projectId: string;
  environmentId: string;
  path: string;
  maxActions: number;
  allowInteractions: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  provider: 'ai' | 'rules';
  createdAt: string;
  completedAt?: string;
  stage: string;
  error?: string;
  discoveries: {
    caseId: string;
    name: string;
    reproduced: boolean;
    runId: string;
    signature?: string;
  }[];
  visited: string[];
  skipped: string[];
};
export type Recording = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  status: 'recording' | 'saved' | 'cancelled' | 'failed';
  createdAt: string;
  steps: TestStep[];
  omitted: number;
  caseId?: string;
  error?: string;
};
