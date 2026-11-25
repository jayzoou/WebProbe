<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  Plus,
  Play,
  FlaskConical,
  Sparkles,
  Video,
  Upload,
  Download,
  Copy,
  Archive,
  Square,
  Eye,
} from 'lucide-vue-next';
import { state, api, notify, date, projectName, download } from '../state';
import TestCaseEditor from '../components/TestCaseEditor.vue';
import type {
  TestCase,
  TestRun,
  Exploration,
  Recording,
  VisualBaseline,
} from '../../../../packages/shared/src/testing';
const router = useRouter(),
  tab = ref('cases'),
  projectId = ref(state.projectId || ''),
  environmentId = ref(''),
  cases = ref<TestCase[]>([]),
  runs = ref<TestRun[]>([]),
  explorations = ref<Exploration[]>([]),
  recordings = ref<Recording[]>([]),
  baselines = ref<VisualBaseline[]>([]),
  selected = ref<string[]>([]),
  editor = ref(false),
  editing = ref<TestCase>(),
  error = ref(''),
  busy = ref(false),
  showArchived = ref(false),
  showRun = ref(false),
  browsers = ref(['chromium']),
  devices = ref(['desktop']),
  allowInteractions = ref(false),
  allowWrites = ref(false),
  release = ref(''),
  path = ref('/'),
  goal = ref('录制业务流程'),
  maxActions = ref(4),
  poll = ref<ReturnType<typeof setInterval>>();
const project = computed(() => state.projects.find((p) => p.id === projectId.value));
watch(
  () => state.projects,
  () => {
    if (!projectId.value) projectId.value = state.projectId || state.projects[0]?.id || '';
  },
  { immediate: true },
);
watch(
  project,
  () => {
    environmentId.value = project.value?.environments[0]?.id || '';
    selected.value = [];
  },
  { immediate: true },
);
const visibleCases = computed(() =>
    cases.value.filter(
      (c) => c.projectId === projectId.value && (showArchived.value || !c.archived),
    ),
  ),
  visibleRuns = computed(() => runs.value.filter((r) => r.projectId === projectId.value));
const labels: Record<string, string> = {
  queued: '等待中',
  running: '执行中',
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
  needs_baseline: '等待视觉基线',
  cancelled: '已取消',
  completed: '完成',
  recording: '录制中',
  saved: '已保存',
};
async function load() {
  try {
    [cases.value, runs.value, explorations.value, recordings.value, baselines.value] =
      await Promise.all([
        api('/test-cases'),
        api('/test-runs'),
        api('/explorations'),
        api('/recordings'),
        api('/visual-baselines'),
      ]);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  poll.value = setInterval(() => {
    if (!document.hidden) void load();
  }, 3000);
});
onUnmounted(() => clearInterval(poll.value));
async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = '';
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function edit(c?: TestCase) {
  editing.value = c;
  editor.value = true;
}
function caseInput(c: TestCase) {
  return {
    projectId: c.projectId,
    name: c.name,
    description: c.description,
    steps: c.steps,
    tags: c.tags,
  };
}
async function duplicate(c: TestCase) {
  await act(() =>
    api('/test-cases', {
      method: 'POST',
      body: JSON.stringify({ ...caseInput(c), name: c.name + ' 副本' }),
    }),
  );
}
async function archive(c: TestCase) {
  await act(() =>
    api(`/test-cases/${c.id}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: !c.archived }),
    }),
  );
}
async function imported(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  await act(async () => {
    if (file.size > 1024 * 1024) throw new Error('文件不能超过 1MB');
    const raw = JSON.parse(await file.text());
    await api('/test-cases/import', {
      method: 'POST',
      body: JSON.stringify(
        (Array.isArray(raw) ? raw : [raw]).map((c) => ({ ...c, projectId: projectId.value })),
      ),
    });
    notify('用例已导入');
  });
  input.value = '';
}
async function run() {
  await act(async () => {
    const item = await api('/test-runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId.value,
        environmentId: environmentId.value,
        caseIds: selected.value,
        browsers: browsers.value,
        devices: devices.value,
        allowInteractions: allowInteractions.value,
        allowWrites: allowWrites.value,
        release: release.value,
      }),
    });
    showRun.value = false;
    router.push('/testing/runs/' + item.id);
  });
}
async function explore() {
  await act(async () => {
    await api('/explorations', {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId.value,
        environmentId: environmentId.value,
        path: path.value,
        maxActions: maxActions.value,
        allowInteractions: allowInteractions.value,
      }),
    });
    notify('页面探索已启动');
  });
}
async function record() {
  await act(async () => {
    await api('/recordings', {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId.value,
        environmentId: environmentId.value,
        path: path.value,
        name: goal.value,
        allowWrites: allowWrites.value,
      }),
    });
    notify('录制浏览器已打开，请在浏览器内操作，完成后返回这里保存');
  });
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">AI TESTING PLATFORM</div>
      <h1>让功能，经过真实验证。</h1>
      <p>从自然语言与浏览器操作，走向可重放的业务测试和视觉回归。</p>
    </div>
    <button class="button primary" :disabled="!projectId" @click="edit()">
      <Plus :size="17" />创建用例
    </button>
  </div>
  <div class="testing-stat-grid">
    <div class="panel">
      <FlaskConical :size="20" /><strong>{{
        visibleCases.filter((c) => !c.archived).length
      }}</strong
      ><span>可执行用例</span>
    </div>
    <div class="panel">
      <Play :size="20" /><strong>{{ visibleRuns.length }}</strong
      ><span>执行记录</span>
    </div>
    <div class="panel">
      <Sparkles :size="20" /><strong>{{
        explorations
          .filter((e) => e.projectId === projectId)
          .reduce((n, e) => n + e.discoveries.filter((d) => d.reproduced).length, 0)
      }}</strong
      ><span>已重放复现的缺陷路径</span>
    </div>
    <div class="panel">
      <Eye :size="20" /><strong>{{
        baselines.filter((b) => b.projectId === projectId).length
      }}</strong
      ><span>视觉基线审批记录</span>
    </div>
  </div>
  <div class="toolbar">
    <select v-model="projectId" aria-label="测试项目">
      <option disabled value="">选择项目</option>
      <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option></select
    ><select v-model="environmentId" aria-label="测试环境">
      <option v-for="e in project?.environments" :value="e.id">{{ e.name }}</option></select
    ><span class="muted testing-env-url">{{
      project?.environments.find((e) => e.id === environmentId)?.url
    }}</span>
  </div>
  <p v-if="error" class="alert error">{{ error }}</p>
  <div class="issue-tabs">
    <button
      v-for="t in [
        { id: 'cases', name: '测试用例' },
        { id: 'runs', name: '执行记录' },
        { id: 'explore', name: 'AI 页面探索' },
        { id: 'recordings', name: '操作录制' },
        { id: 'visual', name: '视觉基线' },
      ]"
      :class="{ selected: tab === t.id }"
      @click="tab = t.id"
    >
      {{ t.name }}
    </button>
  </div>
  <div v-if="!projectId" class="panel full-empty">
    <FlaskConical :size="34" />
    <h2>先为测试连接一个项目</h2>
    <p>用例、执行与视觉基线将关联你的项目环境。</p>
    <button class="button primary" @click="state.showProject = true">创建项目</button>
  </div>
  <template v-else-if="tab === 'cases'"
    ><div class="toolbar">
      <label class="testing-check"
        ><input type="checkbox" v-model="showArchived" />显示已归档</label
      >
      <div class="button-group">
        <label class="button"
          ><Upload :size="16" />导入 JSON<input
            type="file"
            accept=".json"
            class="testing-file-input"
            @change="imported" /></label
        ><button class="button primary" :disabled="!selected.length" @click="showRun = true">
          <Play :size="16" />运行选中（{{ selected.length }}）
        </button>
      </div>
    </div>
    <section class="panel">
      <div v-if="!visibleCases.length" class="full-empty">
        <FlaskConical :size="34" />
        <h2>把业务预期，写成可执行的保证</h2>
        <p>手动创建步骤、从自然语言生成，或录制一次真实操作。</p>
        <button class="button primary" @click="edit()">创建第一个用例</button>
      </div>
      <div v-else class="testing-case-list">
        <article v-for="c in visibleCases" :key="c.id">
          <input
            v-model="selected"
            type="checkbox"
            :value="c.id"
            :disabled="c.archived"
            :aria-label="'选择 ' + c.name"
          />
          <div class="testing-case-body">
            <button class="text-button" @click="edit(c)">
              <strong>{{ c.name }}</strong>
            </button>
            <p>{{ c.description || '未填写业务说明' }}</p>
            <div class="inline-tags">
              <span class="pill">v{{ c.revision }}</span
              ><span class="pill">{{ c.steps.length }} 步</span
              ><span class="pill">{{
                {
                  manual: '手动',
                  ai: 'AI',
                  rules: '规则',
                  recording: '录制',
                  exploration: '探索',
                  import: '导入',
                }[c.origin]
              }}</span
              ><span v-for="tag in c.tags" class="pill">{{ tag }}</span
              ><span v-if="c.archived" class="pill orange">已归档</span>
            </div>
          </div>
          <div class="button-group">
            <button
              class="icon-button"
              title="复制用例"
              aria-label="复制用例"
              @click="duplicate(c)"
            >
              <Copy :size="16" /></button
            ><button
              class="icon-button"
              title="导出 Playwright"
              aria-label="导出 Playwright"
              @click="
                act(() =>
                  download(`/api/test-cases/${c.id}/export?format=playwright`, `${c.id}.spec.ts`),
                )
              "
            >
              <Download :size="16" /></button
            ><button
              class="icon-button"
              title="导出 JSON"
              aria-label="导出用例 JSON"
              @click="act(() => download(`/api/test-cases/${c.id}/export`, `${c.id}.json`))"
            >
              JSON</button
            ><button
              class="icon-button"
              title="归档或恢复"
              aria-label="归档或恢复"
              @click="archive(c)"
            >
              <Archive :size="16" />
            </button>
          </div>
        </article>
      </div></section
  ></template>
  <section v-else-if="tab === 'runs'" class="panel">
    <div v-if="!visibleRuns.length" class="full-empty">
      <Play :size="30" />
      <h2>还没有执行记录</h2>
      <p>选中用例并运行，查看逐步证据和可重复的结果。</p>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>执行 / 版本</th>
            <th>用例和配置</th>
            <th>结果</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in visibleRuns">
            <td>
              <RouterLink :to="'/testing/runs/' + r.id" class="table-project">{{
                r.release || r.id.slice(0, 8)
              }}</RouterLink>
            </td>
            <td>
              {{ r.cases.length }} 个用例<small class="cell-sub"
                >{{ r.browsers.join(' / ') }} · {{ r.devices.join(' / ') }}</small
              >
            </td>
            <td>
              <span class="status" :class="r.status">{{ labels[r.status] }}</span>
            </td>
            <td>{{ date(r.createdAt) }}</td>
            <td>
              <RouterLink :to="'/testing/runs/' + r.id" class="button small-button"
                >查看执行</RouterLink
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <template v-else-if="tab === 'explore'"
    ><section class="panel testing-action-panel">
      <h2><Sparkles :size="23" />探索页面，重放异常。</h2>
      <p>
        读取页面元素，探索站内链接与允许的按钮。发现运行异常后保存路径并再次重放；业务结果仍需要你定义断言。
      </p>
      <div class="form-grid">
        <label>起始路径<input v-model="path" placeholder="/" /></label
        ><label
          >最多探索动作<input v-model.number="maxActions" type="number" min="1" max="10"
        /></label>
      </div>
      <label class="testing-check"
        ><input
          v-model="allowInteractions"
          type="checkbox"
        />允许安全按钮交互（不会执行删除、支付等危险操作）</label
      >
      <p class="info-note">
        {{
          state.health?.aiConfigured
            ? 'AI 将根据真实 DOM 选择探索路径。'
            : '未配置模型：使用明确标识的规则探索。'
        }}每条路径单独重放，不提交写请求。
      </p>
      <button class="button primary" :disabled="busy" @click="explore">
        <Sparkles :size="16" />开始探索
      </button>
    </section>
    <section
      v-for="e in explorations.filter((e) => e.projectId === projectId)"
      class="panel exploration-card"
    >
      <div class="panel-heading">
        <h3>
          {{ e.path }} <span class="pill">{{ e.provider === 'ai' ? 'AI 规划' : '规则探索' }}</span>
        </h3>
        <span class="status" :class="e.status">{{ labels[e.status] }}</span>
      </div>
      <p>{{ e.stage }}</p>
      <p v-if="e.error" class="alert error">{{ e.error }}</p>
      <div v-for="d in e.discoveries" class="discovery-row">
        <span class="pill" :class="d.reproduced ? 'orange' : ''">{{
          d.reproduced ? '已重放复现' : '疑似 · 未稳定复现'
        }}</span><strong>{{ d.name }}</strong
        ><RouterLink :to="'/testing/runs/' + d.runId" class="text-button">查看重放证据</RouterLink>
      </div>
      <p v-if="e.status === 'completed' && !e.discoveries.length" class="muted">
        本次探索未发现可保存的异常路径，不代表所有功能均正确。
      </p>
      <details>
        <summary>探索范围 · {{ e.visited.length }} 条路径</summary>
        <p v-for="v in e.visited" class="mono">{{ v }}</p>
        <p v-for="s in e.skipped" class="muted">{{ s }}</p>
      </details>
      <button
        v-if="['running', 'queued'].includes(e.status)"
        class="button"
        @click="act(() => api(`/explorations/${e.id}/cancel`, { method: 'POST' }))"
      >
        取消探索
      </button>
    </section></template
  >
  <template v-else-if="tab === 'recordings'"
    ><section class="panel testing-action-panel">
      <h2><Video :size="23" />操作一次，成为可重放的用例。</h2>
      <p>
        打开独立的本地 Chromium
        浏览器，记录导航、点击、输入、选项和按键。完成后返回此处保存，再补充业务断言。
      </p>
      <div class="form-grid">
        <label>录制名称<input v-model="goal" maxlength="120" /></label
        ><label>起始路径<input v-model="path" placeholder="/" /></label>
      </div>
      <label class="testing-check"
        ><input
          type="checkbox"
          v-model="allowWrites"
        />允许当前环境的写请求（例如测试表单提交）</label
      >
      <p class="info-note">
        密码、令牌和支付字段不会保存为测试数据。录制需在运行 WebProbe 的电脑上操作浏览器，10
        分钟后自动结束。
      </p>
      <button
        class="button primary"
        :disabled="busy || recordings.some((r) => r.status === 'recording')"
        @click="record"
      >
        <Video :size="16" />打开浏览器并录制
      </button>
    </section>
    <section class="panel">
      <div v-if="!recordings.filter((r) => r.projectId === projectId).length" class="full-empty">
        <Video :size="30" />
        <p>还没有录制会话。</p>
      </div>
      <article
        v-for="r in recordings.filter((r) => r.projectId === projectId)"
        class="recording-row"
      >
        <div>
          <strong>{{ r.name }}</strong>
          <p>{{ r.steps.length }} 个步骤 · {{ r.omitted }} 个省略事件 · {{ labels[r.status] }}</p>
          <p v-if="r.error" class="text-orange">{{ r.error }}</p>
        </div>
        <template v-if="r.status === 'recording'"
          ><button
            class="button primary"
            @click="
              act(() =>
                api(`/recordings/${r.id}/stop`, {
                  method: 'POST',
                  body: JSON.stringify({ save: true }),
                }),
              )
            "
          >
            <Square :size="15" />停止并保存</button
          ><button
            class="button"
            @click="
              act(() =>
                api(`/recordings/${r.id}/stop`, {
                  method: 'POST',
                  body: JSON.stringify({ save: false }),
                }),
              )
            "
          >
            放弃
          </button></template
        ><button v-if="r.caseId" class="button" @click="edit(cases.find((c) => c.id === r.caseId))">
          审查录制步骤
        </button>
      </article>
    </section></template
  >
  <section v-else class="panel">
    <div class="panel-heading">
      <div>
        <h3>视觉基线审批历史</h3>
        <p>首次截图不会自动通过。请在执行详情检查截图后批准基线，再重新运行比较。</p>
      </div>
    </div>
    <div v-if="!baselines.filter((b) => b.projectId === projectId).length" class="full-empty">
      <Eye :size="32" />
      <p>在用例中添加视觉检查点，执行后批准第一张基线。</p>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>检查点 / 用例</th>
            <th>环境</th>
            <th>浏览器 / 设备</th>
            <th>批准时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in baselines.filter((b) => b.projectId === projectId)">
            <td>
              {{ b.name
              }}<small class="cell-sub"
                >{{ cases.find((c) => c.id === b.caseId)?.name }} · v{{ b.revision }}</small
              >
            </td>
            <td>{{ b.environmentId }}</td>
            <td>{{ b.browser }} / {{ b.device }}</td>
            <td>{{ date(b.approvedAt) }}</td>
            <td>
              <RouterLink :to="'/testing/runs/' + b.runId" class="text-button">来源执行</RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <TestCaseEditor
    v-if="editor"
    :project-id="projectId"
    :test-case="editing"
    @close="editor = false"
    @saved="load"
  />
  <div v-if="showRun" class="modal-backdrop" @click.self="showRun = false">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="run-title">
      <h2 id="run-title">运行 {{ selected.length }} 个测试用例</h2>
      <p class="muted">
        {{ project?.name }} · {{ project?.environments.find((e) => e.id === environmentId)?.name }}
      </p>
      <form @submit.prevent="run">
        <label>浏览器</label>
        <div class="choice-row">
          <label v-for="b in ['chromium', 'firefox', 'webkit']" class="choice"
            ><input type="checkbox" v-model="browsers" :value="b" />{{ b }}</label
          >
        </div>
        <label>设备</label>
        <div class="choice-row">
          <label class="choice"
            ><input type="checkbox" v-model="devices" value="desktop" />桌面</label
          ><label class="choice"
            ><input type="checkbox" v-model="devices" value="mobile" />移动</label
          >
        </div>
        <label class="choice"
          ><input type="checkbox" v-model="allowInteractions" />允许用例中的页面交互</label
        ><label class="choice"
          ><input type="checkbox" v-model="allowWrites" />允许当前环境写请求</label
        ><label>发布版本<input v-model="release" placeholder="v2.0.0" /></label>
        <p class="info-note">
          执行将保存当前用例版本和证据。仅在你有权测试的环境中执行，敏感及危险操作仍会被阻止。
        </p>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="showRun = false">取消</button
          ><button class="button primary" :disabled="busy || !browsers.length || !devices.length">
            开始执行
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
