import { access, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertRisk, loadConfig } from '../.ai-workflow/config.mjs';

// 项目内的只读检查入口，不依赖模板仓库位置或额外 npm 包。
try {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--risk')) {
    throw new Error('用法：npm run workflow:doctor -- [--risk low|medium|high]');
  }
  const risk = args[1] ?? 'medium';
  assertRisk(risk);
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const config = await loadConfig(cwd);
  const pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const issues = [];
  for (const path of [
    'AGENTS.md',
    'docs/product.md',
    'docs/architecture.md',
    'docs/quality-gates.md',
    'tasks/TASK_TEMPLATE.md',
    '.ai-workflow/verify.mjs',
  ]) {
    try {
      if (!(await stat(resolve(cwd, path))).isFile()) issues.push(`不是文件：${path}`);
    } catch {
      issues.push(`缺少：${path}`);
    }
  }
  for (const gate of config.gates.filter((gate) => gate.requiredFor.includes(risk))) {
    if (!gate.command) issues.push(`${gate.id}：未配置命令`);
    else if (
      gate.command[0] === 'npm' &&
      gate.command[1] === 'run' &&
      !pkg.scripts[gate.command[2]]
    )
      issues.push(`${gate.id}：缺少脚本 ${gate.command[2]}`);
  }
  for (const path of ['node_modules', 'package-lock.json']) {
    try {
      await access(resolve(cwd, path));
    } catch {
      issues.push(`缺少 ${path}，请检查依赖与锁文件`);
    }
  }
  console.log(`${config.project} / ${risk}：${issues.length ? 'blocked' : 'ready'}`);
  for (const issue of issues) console.log(`- ${issue}`);
  console.log('此命令未执行测试、构建、浏览器检查或远端分支保护检查。');
  process.exitCode = issues.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
