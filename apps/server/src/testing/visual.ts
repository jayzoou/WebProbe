import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { all, dataDir, put, uid, now } from '../store.js';
import type {
  TestCase,
  TestRun,
  TestStep,
  VisualBaseline,
  VisualResult,
} from '../../../../packages/shared/src/testing.js';
export function baselineKey(
  run: Pick<TestRun, 'projectId' | 'environmentId'>,
  test: TestCase,
  browser: string,
  device: string,
  name: string,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        run.projectId,
        run.environmentId,
        test.id,
        test.steps,
        browser,
        device,
        name,
        process.platform,
      ]),
    )
    .digest('hex');
}
export function artifactFile(url: string) {
  if (!/^\/artifacts\/[a-f0-9-]+\/[a-zA-Z0-9_.-]+$/.test(url)) throw new Error('无效证据路径');
  return resolve(dataDir, url.slice(1));
}
export function compareImages(before: Buffer, after: Buffer) {
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height)
    return { diffRatio: 1, dimensionsChanged: true, diff: after };
  const output = new PNG({ width: a.width, height: a.height });
  const count = pixelmatch(a.data, b.data, output.data, a.width, a.height, {
    threshold: 0.1,
    includeAA: false,
  });
  return {
    diffRatio: count / (a.width * a.height),
    dimensionsChanged: false,
    diff: PNG.sync.write(output),
  };
}
export async function visualCheckpoint(
  page: Page,
  run: TestRun,
  test: TestCase,
  browser: string,
  device: string,
  step: Extract<TestStep, { action: 'visual' }>,
  prefix: string,
): Promise<VisualResult> {
  await page.evaluate(() => document.fonts.ready);
  const current = `/artifacts/${run.id}/${prefix}-${step.name}.png`;
  const masks = step.masks.map((s) => page.locator(s));
  for (const m of masks) await m.first().waitFor({ state: 'attached', timeout: 3000 });
  await page.screenshot({
    path: artifactFile(current),
    animations: 'disabled',
    caret: 'hide',
    mask: masks,
    fullPage: false,
  });
  const key = baselineKey(run, test, browser, device, step.name);
  const baseline = all<VisualBaseline>('visualBaseline').find((b) => b.key === key);
  const result: VisualResult = {
    name: step.name,
    key,
    current,
    status: 'needs_baseline',
    maxDiffRatio: step.maxDiffRatio,
  };
  if (!baseline) return result;
  const compared = compareImages(
    await readFile(artifactFile(baseline.image)),
    await readFile(artifactFile(current)),
  );
  const diff = `/artifacts/${run.id}/${prefix}-${step.name}.diff.png`;
  await writeFile(artifactFile(diff), compared.diff);
  return {
    ...result,
    baseline: baseline.image,
    diff,
    diffRatio: compared.diffRatio,
    dimensionsChanged: compared.dimensionsChanged,
    status: compared.diffRatio <= step.maxDiffRatio ? 'passed' : 'failed',
  };
}
export function approveBaseline(run: TestRun, resultId: string, name: string) {
  if (['running', 'queued', 'cancelled'].includes(run.status))
    throw new Error('仅可批准已完成且未取消的执行结果');
  const result = run.results.find((r) => r.id === resultId);
  const visual = result?.steps.find((s) => s.visual?.name === name)?.visual;
  if (
    !result ||
    !visual ||
    ['blocked', 'cancelled'].includes(result.status) ||
    result.steps.some((s) => s.status !== 'passed' && !s.visual)
  )
    throw new Error('没有可批准的完整视觉检查点');
  const previous = all<VisualBaseline>('visualBaseline').find((b) => b.key === visual.key);
  return put<VisualBaseline>('visualBaseline', {
    id: uid(),
    key: visual.key,
    projectId: run.projectId,
    environmentId: run.environmentId,
    caseId: result.testCase.id,
    revision: result.testCase.revision,
    browser: result.browser,
    device: result.device,
    name,
    image: visual.current,
    runId: run.id,
    approvedAt: now(),
    previousId: previous?.id,
  });
}
