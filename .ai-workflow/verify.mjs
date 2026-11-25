import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertRisk, loadConfig } from './config.mjs';
import { safePath, safeFile } from './safe-files.mjs';

/** @param {import('./config.mjs').Gate} gate */
async function execute(gate, cwd, signal, quiet, activeRoots) {
  const started = Date.now();
  const command = gate.command;
  if (signal.aborted)
    return {
      status: 'cancelled',
      exitCode: null,
      durationMs: 0,
      output: '验证已取消',
    };
  if (!command)
    return {
      status: 'blocked',
      exitCode: null,
      durationMs: 0,
      output: '门禁未配置命令',
    };
  return new Promise((done) => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnError = '';
    const [executable, ...args] = command;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        AI_WORKFLOW_ACTIVE_ROOTS: JSON.stringify(activeRoots),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    function stop() {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
          });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch (error) {
        if (error.code !== 'ESRCH') output += `\n无法结束进程: ${error.message}`;
      }
    }
    function capture(chunk) {
      const data = chunk.toString();
      // 仅保留末尾 65536 字符，避免失控输出耗尽内存。
      output = (output + data).slice(-65_536);
      if (!quiet) process.stdout.write(data);
    }
    child.stdout.setEncoding('utf8').on('data', capture);
    child.stderr.setEncoding('utf8').on('data', capture);
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, gate.timeoutMs);
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    function finish(exitCode) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      done({
        status: cancelled
          ? 'cancelled'
          : timedOut
            ? 'timeout'
            : exitCode === 0 && !spawnError
              ? 'passed'
              : 'failed',
        exitCode,
        durationMs: Date.now() - started,
        output: spawnError || output,
      });
    }
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function gitContext(cwd) {
  const read = (args) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1_048_576,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const status = read(['status', '--porcelain']);
  return {
    commit: read(['rev-parse', 'HEAD']),
    dirty: status === null ? null : status !== '',
  };
}

const cell = (value) =>
  String(value ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

export function markdownReport(report) {
  return [
    '# AI Workflow 验证报告',
    '',
    `- 结论：**${report.status}**（仅自动化门禁）`,
    `- 项目：${cell(report.project)}；风险：${report.risk}`,
    `- 开始：${report.startedAt}；耗时：${report.durationMs} ms`,
    `- Git：${report.git.commit ?? '无可用提交'}；工作区有修改：${report.git.dirty ?? '未知'}`,
    `- 人工验收：**未由本工具判定**`,
    '',
    '| 门禁 | 状态 | 退出码 | 耗时 ms | 命令 |',
    '| --- | --- | --- | --- | --- |',
    ...report.gates.map(
      (g) =>
        `| ${cell(g.id)} | ${g.status} | ${cell(g.exitCode)} | ${g.durationMs} | ${cell(g.command?.join(' '))} |`,
    ),
    '',
    '每个门禁的实际输出位于同目录的 `<gate>.log`；最多保留末尾 65536 字符。',
    '通过只说明已配置命令成功退出，不证明测试充分、没有漏洞或人工验收完成。',
    '',
  ].join('\n');
}

/** @param {{cwd: string, risk?: string, quiet?: boolean, signal?: AbortSignal}} options */
export async function runVerification({ cwd, risk = 'medium', quiet = false, signal }) {
  assertRisk(risk);
  const projectRoot = await realpath(cwd);
  let ancestors;
  try {
    ancestors = JSON.parse(process.env.AI_WORKFLOW_ACTIVE_ROOTS ?? '[]');
  } catch (error) {
    throw new Error('AI_WORKFLOW_ACTIVE_ROOTS 不是有效的内部运行上下文', {
      cause: error,
    });
  }
  if (!Array.isArray(ancestors) || ancestors.some((root) => typeof root !== 'string')) {
    throw new Error('AI_WORKFLOW_ACTIVE_ROOTS 必须是项目路径数组');
  }
  if (ancestors.includes(projectRoot)) {
    throw new Error('检测到同一项目递归执行 verify：门禁命令不能直接或间接调用本项目的验证入口');
  }
  const activeRoots = [...ancestors, projectRoot];
  const config = await loadConfig(cwd);
  const start = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const runId = `${new Date(start).toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const reportBase = '.ai-workflow/reports';
  const directory = `${reportBase}/${runId}`;
  try {
    // 在执行命令前检查报告路径，路径有问题时不产生业务副作用。
    await safeFile(cwd, `${directory}/report.json`);
    await safeFile(cwd, `${directory}/report.md`);
    await safeFile(cwd, `${reportBase}/latest.json`);
    await safeFile(cwd, `${reportBase}/latest.md`);
    await mkdir(resolve(cwd, directory), { recursive: true });
    const gates = [];
    for (const gate of config.gates) {
      const required = gate.requiredFor.includes(/** @type {import('./config.mjs').Risk} */ (risk));
      let result;
      if (!required)
        result = {
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          output: '当前风险等级不要求此门禁',
        };
      else result = await execute(gate, cwd, controller.signal, quiet, activeRoots);
      const { output, ...summary } = result;
      gates.push({ id: gate.id, command: gate.command, required, ...summary });
      await writeFile(await safePath(cwd, `${directory}/${gate.id}.log`), output, { flag: 'wx' });
      if (!quiet) console.log(`\n[${gate.id}] ${result.status}`);
    }
    const report = {
      version: 1,
      runId,
      project: config.project,
      risk,
      status:
        controller.signal.aborted || gates.some((g) => g.required && g.status !== 'passed')
          ? 'failed'
          : 'passed',
      startedAt: new Date(start).toISOString(),
      durationMs: Date.now() - start,
      git: gitContext(cwd),
      manualAcceptance: 'not-assessed',
      gates,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = markdownReport(report);
    await writeFile(await safePath(cwd, `${directory}/report.json`), json, {
      flag: 'wx',
    });
    await writeFile(await safePath(cwd, `${directory}/report.md`), markdown, {
      flag: 'wx',
    });
    // latest 是便捷副本；CI 应收集完整 runId 目录以避免并行运行的 latest 竞争。
    await writeFile(await safePath(cwd, `${reportBase}/latest.json`), json);
    await writeFile(await safePath(cwd, `${reportBase}/latest.md`), markdown);
    if (!quiet) console.log(`\n自动化门禁 ${report.status} · ${directory}/report.md`);
    return report;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
  }
}

// 此文件也会复制到目标项目，可独立运行，无需安装此工具。
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--risk'))
      throw new Error('用法: node .ai-workflow/verify.mjs [--risk low|medium|high]');
    const report = await runVerification({
      cwd: process.cwd(),
      risk: args[1] ?? 'medium',
    });
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
