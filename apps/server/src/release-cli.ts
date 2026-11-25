import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Release } from '../../../packages/shared/src/releases.js';
import { releaseMarkdown, releaseJUnit, xml } from './releases/reports.js';
import { runLocalJob } from './releases/local-runner.js';
const usage = `WebProbe Release Quality CLI\n\n命令：check（创建并验证） / runner（执行已授权本地任务） / status / deploy（仅登记已完成部署） / init\n\n示例：npm run release -- check --project ID --environment staging --version v3 --commit abc1234 --mode local --target http://127.0.0.1:5173 --allow-private-network\n凭证仅从 WEBPROBE_API_TOKEN 或 WEBPROBE_RUNNER_TOKEN 读取，不放入命令参数。\n配置默认读取 --config 指定的 JSON；平台地址默认 WEBPROBE_URL 或 http://127.0.0.1:4174。\n退出码：0 就绪/已登记，1 质量阻断，2 技术错误/超时，3 待人工审批，4 已取消。`;
export function exitCode(r: Release) {
  if (['ready', 'deployed'].includes(r.status) && r.readiness?.ready === false) return 1;
  return r.status === 'ready' || r.status === 'deployed'
    ? 0
    : r.status === 'awaiting_approval'
      ? 3
      : r.status === 'cancelled'
        ? 4
        : 1;
}
export async function releaseCLI(argv: string[]): Promise<number> {
  let output = resolve('webprobe-results');
  try {
    const command = argv[0] || 'check';
    const flags: Record<string, string | boolean> = {};
    const allowed = new Set([
      'config',
      'server',
      'project',
      'environment',
      'version',
      'commit',
      'branch',
      'target',
      'baseline',
      'release',
      'mode',
      'output',
      'timeout',
      'job',
      'allow-private-network',
      'actor',
      'note',
      'deployment-url',
      'help',
    ]);
    for (let i = 1; i < argv.length; i++) {
      const token = argv[i];
      if (!token.startsWith('--')) throw new Error('无法识别参数 ' + token);
      const [name, ...rest] = token.slice(2).split('=');
      if (!allowed.has(name)) throw new Error('未知参数 --' + name);
      flags[name] = rest.length
        ? rest.join('=')
        : argv[i + 1] && !argv[i + 1].startsWith('--')
          ? argv[++i]
          : true;
    }
    if (flags.help || command === 'help') {
      console.log(usage);
      return 0;
    }
    if (command === 'init') {
      const file = resolve(
        typeof flags.config === 'string' ? flags.config : 'webprobe.config.json',
      );
      await writeFile(
        file,
        JSON.stringify(
          {
            server: 'http://127.0.0.1:4174',
            projectId: 'YOUR_PROJECT_ID',
            environmentId: 'preview',
            mode: 'local',
            output: 'webprobe-results',
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      console.log('已创建 ' + file);
      return 0;
    }
    const config =
      typeof flags.config === 'string'
        ? JSON.parse(await readFile(resolve(flags.config), 'utf8'))
        : {};
    const value = (flag: string, key = flag) =>
      typeof flags[flag] === 'string' ? String(flags[flag]) : config[key];
    output = resolve(value('output') || 'webprobe-results');
    const server = String(
      value('server') || process.env.WEBPROBE_URL || 'http://127.0.0.1:4174',
    ).replace(/\/$/, '');
    const serverUrl = new URL(server);
    if (
      !['http:', 'https:'].includes(serverUrl.protocol) ||
      serverUrl.username ||
      serverUrl.password
    )
      throw new Error('平台地址必须是不含凭证的 HTTP(S) 地址');
    const client =
      (token?: string) =>
      async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
        const response = await fetch(`${server}/api${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(60000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      };
    const api = client(process.env.WEBPROBE_API_TOKEN);
    let release: Release;
    const timeout = Number(value('timeout') || 900);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600)
      throw new Error('timeout 必须为 1–3600 秒');
    if (flags['allow-private-network'] === true || config.allowPrivateNetwork === true)
      process.env.ALLOW_PRIVATE_NETWORK = 'true';
    if (command === 'runner') {
      const jobId = value('job'),
        token = process.env.WEBPROBE_RUNNER_TOKEN;
      if (!jobId || !token) throw new Error('runner 需要 --job 和 WEBPROBE_RUNNER_TOKEN');
      const runner = client(token);
      release = await runLocalJob(
        runner,
        jobId,
        output,
        async (id) => {
          const res = await fetch(`${server}/api/runner-jobs/${jobId}/baselines/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error('无法下载授权视觉基线');
          return Buffer.from(await res.arrayBuffer());
        },
        console.log,
      );
    } else if (command === 'status') {
      const id = value('release');
      if (!id) throw new Error('status 需要 --release');
      release = await api('/releases/' + id);
    } else if (command === 'deploy') {
      const id = value('release'),
        commit = value('commit') || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA,
        url = value('deployment-url');
      if (!id || !commit || !url)
        throw new Error('deploy 需要 --release、--commit 和 --deployment-url');
      await api(`/releases/${id}/deployments`, {
        commit,
        actor: value('actor') || 'CI',
        note: value('note') || '',
        url,
        source: 'ci',
      });
      release = await api('/releases/' + id);
    } else if (command === 'check') {
      const id = value('release');
      if (id) release = await api('/releases/' + id);
      else {
        const projectId = value('project', 'projectId'),
          environmentId = value('environment', 'environmentId'),
          commit = value('commit') || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA,
          version = value('version') || process.env.WEBPROBE_VERSION || commit?.slice(0, 12);
        if (!projectId || !environmentId || !commit || !version)
          throw new Error('check 需要项目、环境、版本和 Commit');
        const existing = (
          (await api('/releases?projectId=' + encodeURIComponent(projectId))) as Release[]
        ).find((r) => r.environmentId === environmentId && r.version === version);
        if (existing) {
          if (existing.commit.toLowerCase() !== commit.toLowerCase())
            throw new Error('已存在版本的 Commit 不一致');
          release = existing;
        } else {
          let ci: Record<string, string> | undefined;
          if (process.env.GITHUB_ACTIONS && process.env.GITHUB_RUN_ID)
            ci = {
              provider: 'github',
              runId: process.env.GITHUB_RUN_ID,
              repository: process.env.GITHUB_REPOSITORY || '',
              runUrl: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            };
          else if (process.env.GITLAB_CI && process.env.CI_PIPELINE_ID)
            ci = {
              provider: 'gitlab',
              runId: process.env.CI_PIPELINE_ID,
              repository: process.env.CI_PROJECT_PATH || '',
              ...(process.env.CI_PIPELINE_URL ? { runUrl: process.env.CI_PIPELINE_URL } : {}),
            };
          release = await api('/releases', {
            projectId,
            environmentId,
            version,
            commit,
            branch:
              value('branch') ||
              process.env.GITHUB_HEAD_REF ||
              process.env.GITHUB_REF_NAME ||
              process.env.CI_COMMIT_REF_NAME ||
              '',
            targetUrl: value('target', 'targetUrl'),
            baselineId: value('baseline', 'baselineId'),
            ci,
          });
        }
      }
      const mode = value('mode') || 'platform';
      if (!['local', 'platform'].includes(mode)) throw new Error('mode 必须为 local 或 platform');
      console.log(`发布 ${release.id} · ${release.version} · ${release.commit}`);
      if (mode === 'local') {
        const issued = await api(`/releases/${release.id}/runner-jobs`, {});
        const token = issued.token,
          runner = client(token);
        release = await runLocalJob(
          runner,
          issued.job.id,
          output,
          async (id) => {
            const res = await fetch(`${server}/api/runner-jobs/${issued.job.id}/baselines/${id}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error('无法读取授权基线');
            return Buffer.from(await res.arrayBuffer());
          },
          console.log,
        );
      } else {
        release = await api(`/releases/${release.id}/check`, {});
        const until = Date.now() + timeout * 1000;
        while (['checking', 'waiting_runner'].includes(release.status)) {
          if (Date.now() > until) {
            try {
              await api(`/releases/${release.id}/cancel`, {});
            } catch {}
            throw new Error('发布验证超时');
          }
          await new Promise((r) => setTimeout(r, 1000));
          release = await api('/releases/' + release.id);
        }
      }
    } else throw new Error('未知命令 ' + command + '\n' + usage);
    if (['ready', 'deployed'].includes(release.status))
      release.readiness = await api('/releases/' + release.id + '/readiness');
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(resolve(output, 'release.json'), JSON.stringify(release, null, 2)),
      writeFile(resolve(output, 'quality-report.md'), releaseMarkdown(release)),
      writeFile(resolve(output, 'junit.xml'), releaseJUnit(release)),
    ]);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `release_id=${release.id}\ngate_status=${release.evaluation?.status || 'missing'}\nrelease_status=${release.status}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, releaseMarkdown(release));
    console.log(
      `准入 ${release.evaluation?.status || '未评估'} · 发布 ${release.status} · 报告 ${output}`,
    );
    return exitCode(release);
  } catch (error) {
    const message = (error as Error).message;
    console.error(message);
    await mkdir(output, { recursive: true }).catch(() => {});
    await writeFile(
      resolve(output, 'junit.xml'),
      `<?xml version="1.0"?><testsuites><testsuite name="WebProbe" tests="1" errors="1"><testcase name="发布验证执行"><error message="${xml(message)}"/></testcase></testsuite></testsuites>`,
    ).catch(() => {});
    await writeFile(
      resolve(output, 'error.json'),
      JSON.stringify({ status: 'error', message }, null, 2),
    ).catch(() => {});
    return 2;
  }
}
if (process.argv[1]?.endsWith('release-cli.ts'))
  process.exitCode = await releaseCLI(process.argv.slice(2));
