import { reactive, computed } from 'vue';
import type { Project, Scan, Issue } from '../../../packages/shared/src/index';
export const state = reactive({
  projects: [] as Project[],
  scans: [] as Scan[],
  issues: [] as Issue[],
  projectId: '',
  loading: true,
  error: '',
  notice: '',
  connected: false,
  health: null as null | {
    version: string;
    aiConfigured: boolean;
    aiModel: string;
    privateNetworkAllowed: boolean;
  },
  showScan: false,
  showProject: false,
});
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem('webprobe-token');
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
export async function refresh() {
  try {
    const [projects, scans, issues, health] = await Promise.all([
      api<Project[]>('/projects'),
      api<Scan[]>('/scans'),
      api<Issue[]>('/issues'),
      api('/health'),
    ]);
    Object.assign(state, { projects, scans, issues, health, connected: true, error: '' });
  } catch (e) {
    state.connected = false;
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
  }
}
export const projects = computed(() =>
  state.projects.filter((p) => !state.projectId || p.id === state.projectId),
);
export const scans = computed(() =>
  state.scans.filter((s) => !state.projectId || s.projectId === state.projectId),
);
export const issues = computed(() =>
  state.issues.filter((i) => !state.projectId || i.projectId === state.projectId),
);
export const projectName = (id: string) =>
  state.projects.find((p) => p.id === id)?.name || '未知项目';
export const date = (v: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(v));
export const statuses: Record<string, string> = {
  queued: '排队中',
  running: '检测中',
  completed: '已完成',
  partial: '部分完成',
  failed: '检测失败',
  cancelled: '已取消',
  open: '待处理',
  in_progress: '处理中',
  pending_verification: '待验证',
  resolved: '已修复',
  ignored: '已忽略',
};
export const sourceNames: Record<string, string> = {
  runtime: '运行异常',
  network: '网络请求',
  layout: '页面布局',
  accessibility: '无障碍',
  seo: 'SEO',
  lighthouse: '性能',
  functional: '功能测试',
};
export function notify(text: string) {
  state.notice = text;
  setTimeout(() => {
    state.notice = '';
  }, 5000);
}
export async function download(path: string, filename: string) {
  const token = sessionStorage.getItem('webprobe-token');
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('下载失败');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function artifactUrl(path: string) {
  const token = sessionStorage.getItem('webprobe-token');
  if (!token) return path;
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('无法读取证据');
  return URL.createObjectURL(await res.blob());
}
