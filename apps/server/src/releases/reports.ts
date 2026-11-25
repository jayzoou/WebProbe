import type { Release, GateCheck } from '../../../../packages/shared/src/releases.js';
export function releaseMarkdown(r: Release) {
  return `# WebProbe 发布质量报告\n\n项目：${r.projectSnapshot.name}\n版本：${r.version}\nCommit：${r.commit}\n环境：${r.environmentId}\n目标：${r.targetUrl}\n状态：${r.status}\n策略：${r.policy.name} v${r.policy.revision}\n证据来源：${r.evidence?.source || '无'}\n\n| 检查 | 结果 | 实际 | 标准 |\n| --- | --- | --- | --- |\n${(r.evaluation?.checks || []).map((c) => `| ${cell(c.name)} | ${c.status} | ${cell(c.actual)} | ${cell(c.expected)} |`).join('\n')}\n\n${r.evaluation?.comparison ? `## 版本回归\n\n基线：${r.baselineId}\n可比：${r.evaluation.comparison.compatible}\n新增问题：${r.evaluation.comparison.added.length}；本次未再发现：${r.evaluation.comparison.removed.length}\n` : ''}\n本报告是发布质量依据，不代表已执行部署。Runner 结果为持有本任务凭证的调用方声明，不是远程防篡改证明。实验室性能存在波动，需结合实际业务验收。\n`;
}
const cell = (v: string) => v.replaceAll('|', '\\|').replaceAll('\n', ' ');
export const xml = (v: string) =>
  v.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function releaseJUnit(r: Release) {
  const checks: GateCheck[] = r.evaluation?.checks.length
    ? [...r.evaluation.checks]
    : [
        {
          id: 'not-evaluated',
          name: '发布准入未完成',
          status: 'blocked',
          actual: r.status,
          expected: '完整评估',
        },
      ];
  if (!['ready', 'deployed'].includes(r.status))
    checks.push({
      id: 'release-not-ready',
      name: '发布就绪状态',
      status: 'blocked',
      actual: r.status,
      expected: 'ready 或 deployed',
    });
  if (r.readiness?.ready === false && ['ready', 'deployed'].includes(r.status))
    checks.push({
      id: 'current-readiness',
      name: '当前准入资格',
      status: 'blocked',
      actual: r.readiness.reason || '已失效',
      expected: '证据、环境与策略仍有效',
    });
  const failures = checks.filter((c) => c.status === 'failed' || c.status === 'blocked').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="WebProbe release quality" tests="${checks.length}" failures="${failures}" skipped="${checks.filter((c) => c.status === 'not_applicable').length}">${checks.map((c) => `<testcase classname="WebProbe.${xml(r.environmentId)}" name="${xml(c.name)}">${c.status === 'failed' || c.status === 'blocked' ? `<failure type="${c.status}" message="${xml(c.actual)}">${xml(c.expected)}</failure>` : c.status === 'not_applicable' ? '<skipped/>' : ''}</testcase>`).join('')}</testsuite></testsuites>\n`;
}
