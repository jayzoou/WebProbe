import { writeFile } from 'node:fs/promises';
const [url, ...flags] = process.argv.slice(2);
if (!url) {
  console.log(
    '用法：npm run scan -- <url> [--mobile] [--no-lighthouse] [--pages=3] [--output=report.json]\n需要先启动 WebProbe 服务。内网检测需配置 ALLOW_PRIVATE_NETWORK=true。',
  );
  process.exit(1);
}
const base = process.env.WEBPROBE_URL || 'http://127.0.0.1:4174';
async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.WEBPROBE_API_TOKEN
        ? { Authorization: `Bearer ${process.env.WEBPROBE_API_TOKEN}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
try {
  const target = new URL(url);
  const projects = await api('/api/projects');
  let project = projects.find((p: any) => p.environments.some((e: any) => e.url === target.href));
  project ||= await api('/api/projects', {
    name: target.hostname,
    description: 'CLI 创建',
    environments: [{ id: 'local', name: 'CLI 环境', url: target.href }],
  });
  const env = project.environments.find((e: any) => e.url === target.href);
  let scan = await api('/api/scans', {
    projectId: project.id,
    environmentId: env.id,
    devices: [flags.includes('--mobile') ? 'mobile' : 'desktop'],
    browsers: ['chromium'],
    lighthouse: !flags.includes('--no-lighthouse'),
    maxPages: Number(flags.find((f) => f.startsWith('--pages='))?.split('=')[1] || 1),
  });
  console.log(`检测 ${scan.id}`);
  while (['queued', 'running'].includes(scan.status)) {
    await new Promise((r) => setTimeout(r, 1500));
    scan = await api(`/api/scans/${scan.id}`);
    console.log(`${scan.progress}% ${scan.stage}`);
  }
  const report = await api(`/api/scans/${scan.id}/export`);
  const out = flags.find((f) => f.startsWith('--output='))?.slice(9) || `webprobe-${scan.id}.json`;
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`报告：${out} · ${scan.findings.length} 个问题`);
  process.exitCode = scan.status === 'completed' && scan.gate?.passed ? 0 : 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
