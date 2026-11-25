<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Download,
  RotateCcw,
  XCircle,
  CheckCircle2,
  Clock,
  ScanLine,
  ChevronLeft,
  TriangleAlert,
  ExternalLink,
  FileJson,
  FileText,
  ShieldCheck,
} from 'lucide-vue-next';
import {
  state,
  api,
  refresh,
  projectName,
  date,
  statuses,
  sourceNames,
  download,
  notify,
  artifactUrl,
} from '../state';
import type { Scan } from '../../../../packages/shared/src/index';
const route = useRoute(),
  router = useRouter(),
  scan = ref<Scan>(),
  error = ref(''),
  tab = ref('overview'),
  busy = ref(false),
  images = ref<Record<string, string>>({});
let controller: AbortController;
const running = computed(() => scan.value && ['running', 'queued'].includes(scan.value.status));
const metrics = computed(() => scan.value?.pages.find((p) => p.metrics)?.metrics);
async function connect() {
  controller?.abort();
  controller = new AbortController();
  try {
    scan.value = await api(`/scans/${route.params.id}`);
    if (!running.value) return;
    const token = sessionStorage.getItem('webprobe-token');
    const res = await fetch(`/api/scans/${route.params.id}/events`, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('进度连接失败');
    const reader = res.body!.getReader(),
      decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) scan.value = JSON.parse(data);
      }
    }
    await refresh();
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error.value = (e as Error).message;
  }
}
onMounted(connect);
watch(
  () => route.params.id,
  () => {
    images.value = {};
    void connect();
  },
);
onUnmounted(() => {
  controller?.abort();
  Object.values(images.value).forEach((url) => {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  });
});
watch(
  () => state.scans.find((s) => s.id === route.params.id),
  (s) => {
    if (s) scan.value = s;
  },
);
watch(
  () => scan.value?.pages,
  async (pages) => {
    for (const p of pages || [])
      if (p.screenshot && !images.value[p.screenshot])
        try {
          images.value[p.screenshot] = await artifactUrl(p.screenshot);
        } catch {}
  },
  { deep: true },
);
async function rerun() {
  if (!scan.value) return;
  busy.value = true;
  try {
    const s = await api('/scans', { method: 'POST', body: JSON.stringify(scan.value) });
    await refresh();
    router.push('/scans/' + s.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  await api(`/scans/${scan.value!.id}/cancel`, { method: 'POST' });
  await refresh();
}
async function exportReport(format: string) {
  try {
    await download(
      `/api/scans/${scan.value!.id}/export?format=${format}`,
      `webprobe-${scan.value!.id.slice(0, 8)}.${format === 'markdown' ? 'md' : format === 'bundle' ? 'zip' : 'json'}`,
    );
    notify('报告已导出');
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function openReport(path: string) {
  try {
    if (sessionStorage.getItem('webprobe-token')) {
      await download(path, 'lighthouse-report.html');
      notify('原始 Lighthouse 报告已下载');
    } else {
      window.open(path, '_blank', 'noopener');
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <div v-if="!scan" class="full-empty">
    <p>{{ error || '正在读取检测报告…' }}</p>
    <RouterLink to="/scans">返回检测列表</RouterLink>
  </div>
  <template v-else
    ><RouterLink to="/scans" class="back-link"><ChevronLeft :size="16" />检测任务</RouterLink>
    <div class="page-heading">
      <div>
        <div class="eyebrow">SCAN REPORT · {{ scan.id.slice(0, 8) }}</div>
        <h1>
          {{ projectName(scan.projectId)
          }}<span class="status" :class="scan.status">{{ statuses[scan.status] }}</span>
        </h1>
        <p>
          {{ date(scan.createdAt) }} · {{ scan.release || '未关联发布版本' }} ·
          {{ scan.browsers.join(' / ') }} · {{ scan.devices.join(' / ') }}
        </p>
      </div>
      <div class="button-group">
        <button v-if="running" class="button danger" @click="cancel">
          <XCircle :size="16" />取消检测</button
        ><button v-else class="button primary" @click="rerun" :disabled="busy">
          <RotateCcw :size="16" />重新检测</button
        ><button class="button" @click="exportReport('markdown')">
          <Download :size="16" />修复提示词</button
        ><button class="button" @click="exportReport('json')"><FileJson :size="16" />JSON</button
        ><button class="button" @click="exportReport('bundle')">
          <Download :size="16" />任务包
        </button>
      </div>
    </div>
    <p v-if="error || scan.error" class="alert error">{{ error || scan.error }}</p>
    <section v-if="running" class="panel scan-progress">
      <div>
        <ScanLine :size="24" class="spin-slow" />
        <div>
          <h3>{{ scan.stage }}</h3>
          <p>真实检测正在运行，Lighthouse 审计可能需要 30–120 秒。</p>
        </div>
        <strong>{{ scan.progress }}%</strong>
      </div>
      <progress :value="scan.progress" max="100"></progress>
    </section>
    <div class="issue-tabs">
      <button
        v-for="t in [
          { id: 'overview', name: '检测概览' },
          { id: 'pages', name: '页面与证据' },
          { id: 'findings', name: '问题清单' },
          { id: 'logs', name: '执行日志' },
        ]"
        :class="{ selected: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.name }}
      </button>
    </div>
    <template v-if="tab === 'overview'"
      ><section class="stats-grid metrics-grid">
        <div
          v-for="m in [
            { key: 'performance', name: 'Performance' },
            { key: 'accessibility', name: 'Accessibility' },
            { key: 'bestPractices', name: 'Best Practices' },
            { key: 'seo', name: 'SEO' },
          ]"
          class="stat-card score-card"
        >
          <span
            class="score-ring"
            :class="
              metrics?.[m.key as keyof typeof metrics] != null &&
              Number(metrics?.[m.key as keyof typeof metrics]) >= 90
                ? 'good'
                : 'average'
            "
            >{{ metrics?.[m.key as keyof typeof metrics] ?? '—' }}</span><strong>{{
            m.name
          }}</strong>
        </div>
      </section>
      <p class="metric-context">
        以上为首个取得性能数据的页面；各页面与设备的完整指标见“页面与证据”。Lighthouse
        为实验室数据，不等同于真实用户体验。
      </p>
      <div class="vitals-strip">
        <div
          v-for="m in [
            { key: 'lcp', label: 'LCP', unit: 'ms' },
            { key: 'fcp', label: 'FCP', unit: 'ms' },
            { key: 'tbt', label: 'TBT', unit: 'ms' },
            { key: 'cls', label: 'CLS', unit: '' },
          ]"
        >
          <span>{{ m.label }}</span><strong
            >{{
              metrics?.[m.key as keyof typeof metrics] == null
                ? '—'
                : m.key === 'cls'
                  ? Number(metrics.cls).toFixed(3)
                  : Math.round(Number(metrics?.[m.key as keyof typeof metrics]))
            }}<small>{{ m.unit }}</small></strong
          >
        </div>
      </div>
      <div class="report-columns">
        <section class="panel">
          <div class="panel-heading">
            <h3><ShieldCheck :size="19" />发布质量准入</h3>
            <span v-if="scan.gate" class="pill" :class="scan.gate.passed ? 'green' : 'orange'">{{
              scan.gate.passed ? '满足标准' : '暂不满足标准'
            }}</span>
          </div>
          <div v-if="scan.gate" class="gate-list">
            <div v-for="check in scan.gate.checks">
              <CheckCircle2 v-if="check.passed" :size="18" class="text-green" /><TriangleAlert
                v-else
                :size="18"
                class="text-orange"
              /><span
                >{{ check.name }}<small>标准 {{ check.expected }}</small></span
              ><strong>{{ check.actual }}</strong>
            </div>
          </div>
          <p v-else class="panel-placeholder">检测完成后生成准入结论。</p>
        </section>
        <section class="panel">
          <div class="panel-heading">
            <h3><RotateCcw :size="18" />回归对比</h3>
          </div>
          <div v-if="scan.comparison" class="comparison">
            <p>与同一环境、相同配置的上一次完整检测比较。</p>
            <div class="comparison-counts">
              <div>
                <strong class="text-orange">{{ scan.comparison.added }}</strong>新增问题
              </div>
              <div>
                <strong>{{ scan.comparison.persistent }}</strong>持续存在
              </div>
              <div>
                <strong class="text-green">{{ scan.comparison.removed }}</strong>本次未再发现
              </div>
            </div>
            <div v-for="d in scan.comparison.metricDeltas.slice(0, 8)" class="delta-row">
              <span>{{ d.device }} {{ d.metric }}</span
              ><span
                >{{ Math.round(d.before * 1000) / 1000 }} →
                {{ Math.round(d.after * 1000) / 1000 }}</span
              ><strong
                :class="
                  (d.metric === 'performance' ? d.delta >= 0 : d.delta <= 0)
                    ? 'text-green'
                    : 'text-orange'
                "
                >{{ d.delta > 0 ? '+' : '' }}{{ Math.round(d.delta * 1000) / 1000 }}</strong
              >
            </div>
            <RouterLink :to="'/scans/' + scan.comparison.baselineId" class="text-button"
              >查看基线报告</RouterLink
            >
          </div>
          <p v-else class="panel-placeholder">
            尚无相同配置的完整检测基线。<br />下次重新检测后，这里将呈现问题与指标变化。
          </p>
        </section>
      </div></template
    >
    <section v-if="tab === 'pages'" class="page-results">
      <article v-for="p in scan.pages" class="panel page-result">
        <div class="panel-heading">
          <div>
            <h3>
              {{ p.title || '页面检测' }} <span class="pill">{{ p.browser }} / {{ p.device }}</span>
            </h3>
            <p class="mono break-word">{{ p.url }}</p>
          </div>
          <span class="status" :class="p.status">{{ statuses[p.status] }}</span>
        </div>
        <p v-if="p.error" class="alert error">{{ p.error }}</p>
        <div class="page-evidence-grid">
          <img
            v-if="p.screenshot && images[p.screenshot]"
            :src="images[p.screenshot]"
            alt="检测时页面截图"
          />
          <div>
            <h4>成功执行的检查</h4>
            <div class="inline-tags">
              <span v-for="s in p.sources" class="pill green">{{ sourceNames[s] }}</span>
            </div>
            <dl v-if="p.metrics">
              <template v-for="(v, k) in p.metrics"
                ><dt>{{ k }}</dt>
                <dd>{{ v === null ? '无数据' : Math.round(v * 1000) / 1000 }}</dd></template
              >
            </dl>
            <button
              v-if="p.lighthouseReport"
              class="button"
              @click="openReport(p.lighthouseReport)"
            >
              <ExternalLink :size="15" />原始 Lighthouse 报告
            </button>
          </div>
        </div>
      </article>
      <div v-if="!scan.pages.length" class="panel full-empty">页面检测结果尚未生成。</div>
    </section>
    <section v-if="tab === 'findings'" class="panel">
      <div v-if="!scan.findings.length" class="full-empty">
        <CheckCircle2 :size="30" />
        <h3>此次检测暂无问题记录</h3>
        <p>检测覆盖的规则有限，不代表所有业务流程均正常。</p>
      </div>
      <div v-for="f in scan.findings" class="finding-row">
        <div>
          <span class="severity-badge" :class="f.severity">{{ f.severity }}</span><strong>{{
            f.title
          }}</strong
          ><span class="pill">{{ sourceNames[f.source] }}</span>
        </div>
        <p class="mono break-word">{{ f.url }} · {{ f.browser }} / {{ f.device }}</p>
        <details>
          <summary>查看检测证据</summary>
          <pre class="evidence">{{ f.evidence }}</pre>
        </details>
      </div>
    </section>
    <section v-if="tab === 'logs'" class="panel log-panel">
      <div v-for="log in scan.logs">
        <time>{{ date(log.time) }}</time><span>{{ log.message }}</span>
      </div>
      <p v-if="!scan.logs.length">任务正在排队。</p>
    </section></template
  >
</template>
