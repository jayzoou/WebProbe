<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  RotateCcw,
  Download,
  ChevronLeft,
  CheckCircle2,
  TriangleAlert,
  Eye,
  Square,
} from 'lucide-vue-next';
import { api, projectName, date, notify, download } from '../state';
import EvidenceImage from '../components/EvidenceImage.vue';
import type { TestRun, CaseResult, VisualResult } from '../../../../packages/shared/src/testing';
const route = useRoute(),
  router = useRouter(),
  run = ref<TestRun>(),
  error = ref(''),
  busy = ref(false);
let poll: ReturnType<typeof setInterval>;
const active = computed(() => run.value && ['queued', 'running'].includes(run.value.status));
const labels: Record<string, string> = {
  queued: '等待中',
  running: '执行中',
  passed: '通过',
  failed: '失败',
  blocked: '执行受阻',
  needs_baseline: '等待视觉基线',
  cancelled: '已取消',
};
async function load() {
  try {
    run.value = await api('/test-runs/' + route.params.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  poll = setInterval(() => {
    if (active.value && !document.hidden) void load();
  }, 1500);
});
watch(() => route.params.id, load);
onUnmounted(() => clearInterval(poll));
async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function rerun() {
  if (!run.value) return;
  await act(async () => {
    const r = run.value!;
    const item = await api('/test-runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: r.projectId,
        environmentId: r.environmentId,
        caseIds: r.caseIds,
        browsers: r.browsers,
        devices: r.devices,
        allowInteractions: r.allowInteractions,
        allowWrites: r.allowWrites,
        release: r.release,
      }),
    });
    router.push('/testing/runs/' + item.id);
  });
}
async function approve(result: CaseResult, visual: VisualResult) {
  await act(async () => {
    await api(`/test-runs/${run.value!.id}/baselines`, {
      method: 'POST',
      body: JSON.stringify({ resultId: result.id, name: visual.name }),
    });
    notify('视觉基线已批准；请重新执行用例验证，历史结果保持原样');
  });
}
</script>
<template>
  <RouterLink to="/testing" class="back-link"><ChevronLeft :size="16" />AI 测试中心</RouterLink>
  <p v-if="error" class="alert error">{{ error }}</p>
  <div v-if="!run" class="full-empty">正在读取执行结果…</div>
  <template v-else
    ><div class="page-heading">
      <div>
        <div class="eyebrow">REPRODUCIBLE TEST RUN · {{ run.id.slice(0, 8) }}</div>
        <h1>
          {{ projectName(run.projectId)
          }}<span class="status" :class="run.status">{{ labels[run.status] }}</span>
        </h1>
        <p>
          {{ date(run.createdAt) }} · {{ run.environmentId }} · {{ run.release || '未关联版本' }}
        </p>
      </div>
      <div class="button-group">
        <button
          v-if="active"
          class="button"
          @click="
            act(async () => {
              await api(`/test-runs/${run!.id}/cancel`, { method: 'POST' });
              await load();
            })
          "
        >
          <Square :size="16" />取消执行</button
        ><button v-else class="button primary" :disabled="busy" @click="rerun">
          <RotateCcw :size="16" />运行当前用例版本</button
        ><button
          class="button"
          @click="
            act(() => download(`/api/test-runs/${run!.id}/export?format=bundle`, `${run!.id}.zip`))
          "
        >
          <Download :size="16" />导出复现包
        </button>
      </div>
    </div>
    <section v-if="active" class="panel scan-progress">
      <h3>{{ run.stage }}</h3>
      <progress :value="run.progress" max="100"></progress>
    </section>
    <p v-if="run.error" class="alert error">{{ run.error }}</p>
    <div class="testing-stat-grid">
      <div class="panel">
        <strong>{{ run.cases.length }}</strong><span>固定用例快照</span>
      </div>
      <div class="panel">
        <strong>{{ run.results.filter((r) => r.status === 'passed').length }}</strong><span
          >通过组合</span
        >
      </div>
      <div class="panel">
        <strong>{{ run.results.filter((r) => r.status === 'failed').length }}</strong><span
          >失败组合</span
        >
      </div>
      <div class="panel">
        <strong>{{ run.results.filter((r) => r.status === 'needs_baseline').length }}</strong><span
          >待审批基线</span
        >
      </div>
    </div>
    <p class="info-note">
      结果基于执行时保存的用例版本。重新运行会采用用例管理中的当前版本；修改步骤将生成新的视觉基线范围。视觉差异需要人工确认是否为缺陷。
    </p>
    <section v-for="r in run.results" :key="r.id" class="panel test-result-card">
      <div class="panel-heading">
        <div>
          <h3>
            {{ r.testCase.name }}<span class="pill">v{{ r.testCase.revision }}</span>
          </h3>
          <p>{{ r.browser }} / {{ r.device }} · {{ Math.round(r.duration / 100) / 10 }}s</p>
        </div>
        <span class="status" :class="r.status">{{ labels[r.status] }}</span>
      </div>
      <p v-if="r.error" class="alert error">{{ r.error }}</p>
      <div class="test-result-steps">
        <details v-for="s in r.steps" :open="s.status !== 'passed' || !!s.visual">
          <summary>
            <CheckCircle2
              v-if="s.status === 'passed' && !s.visual"
              :size="16"
              class="text-green"
            /><TriangleAlert v-else-if="s.status !== 'passed'" :size="16" class="text-orange" /><Eye
              v-else
              :size="16"
            />步骤 {{ s.index + 1 }} · {{ s.action
            }}<span class="pill">{{ s.visual ? labels[s.visual.status] : labels[s.status] }}</span>
          </summary>
          <pre class="evidence">{{ JSON.stringify(r.testCase.steps[s.index], null, 2) }}</pre>
          <p v-if="s.error" class="alert error">{{ s.error }}</p>
          <div v-if="s.visual" class="visual-result">
            <div class="toolbar">
              <strong>{{ s.visual.name }}</strong><span
                >差异率
                {{
                  s.visual.diffRatio === undefined
                    ? '尚无基线'
                    : (s.visual.diffRatio * 100).toFixed(3) + '%'
                }}
                · 阈值 {{ s.visual.maxDiffRatio * 100 }}%</span
              >
            </div>
            <p v-if="s.visual.dimensionsChanged" class="alert error">截图尺寸发生变化。</p>
            <div class="visual-image-grid">
              <figure v-if="s.visual.baseline">
                <figcaption>已批准基线</figcaption>
                <EvidenceImage :path="s.visual.baseline" alt="已批准的视觉基线" />
              </figure>
              <figure>
                <figcaption>本次截图</figcaption>
                <EvidenceImage :path="s.visual.current" alt="当前视觉检查点截图" />
              </figure>
              <figure v-if="s.visual.diff">
                <figcaption>像素差异</figcaption>
                <EvidenceImage :path="s.visual.diff" alt="视觉差异对比图" />
              </figure>
            </div>
            <button
              class="button"
              :disabled="busy || !!active || ['blocked', 'cancelled'].includes(r.status)"
              @click="approve(r, s.visual)"
            >
              将本次截图批准为基线
            </button>
            <p class="muted">批准不会改写本次执行结果；需重新运行后确认通过。</p>
          </div>
        </details>
      </div>
      <details v-if="r.errors.length" class="test-result-errors">
        <summary>捕获的运行异常（{{ r.errors.length }}）</summary>
        <pre class="evidence">{{ r.errors.join('\n') }}</pre>
      </details>
      <details v-if="r.screenshot" class="test-result-errors">
        <summary>执行结束时的截图</summary>
        <EvidenceImage :path="r.screenshot" alt="执行结束时的页面截图" />
      </details>
      <div class="test-result-actions">
        <RouterLink v-if="r.issueId" to="/issues" class="button small-button"
          >前往问题中心</RouterLink
        ><button
          v-if="r.trace"
          class="button small-button"
          @click="act(() => download(r.trace!, `${r.id}.trace.zip`))"
        >
          下载 Playwright Trace
        </button>
      </div>
    </section>
    <section v-if="!run.results.length && !active" class="panel full-empty">
      <p>没有已完成的用例组合，请查看执行错误或重新运行。</p>
    </section></template
  >
</template>
