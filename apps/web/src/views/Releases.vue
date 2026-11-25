<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Plus, ShieldCheck, GitBranch, Settings2, Terminal, Layers } from 'lucide-vue-next';
import { api, state, date, notify } from '../state';
import type { Release, ReleasePolicy } from '../../../../packages/shared/src/releases';
import ReleasePolicyEditor from '../components/ReleasePolicyEditor.vue';
const router = useRouter(),
  projectId = ref(state.projectId || ''),
  environmentId = ref(''),
  releases = ref<Release[]>([]),
  policy = ref<ReleasePolicy>(),
  error = ref(''),
  busy = ref(false),
  showPolicy = ref(false),
  showCreate = ref(false),
  version = ref(''),
  commit = ref(''),
  branch = ref(''),
  target = ref(''),
  baselineId = ref(''),
  notes = ref(''),
  filter = ref('all');
let poll: ReturnType<typeof setInterval>;
const project = computed(() => state.projects.find((p) => p.id === projectId.value)),
  env = computed(() => project.value?.environments.find((e) => e.id === environmentId.value));
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
    if (!project.value?.environments.some((e) => e.id === environmentId.value))
      environmentId.value = project.value?.environments.find((e) => !e.archived)?.id || '';
  },
  { immediate: true },
);
watch([projectId, environmentId], () => {
  target.value = env.value?.url || '';
  void load();
});
const labels: Record<string, string> = {
  draft: '待验证',
  checking: '质量验证中',
  waiting_runner: '等待 Runner',
  ready: '发布就绪',
  awaiting_approval: '待人工审批',
  blocked: '发布阻断',
  deployed: '已登记部署',
  cancelled: '已取消',
};
const visible = computed(() =>
  releases.value.filter(
    (r) =>
      r.projectId === projectId.value &&
      (!environmentId.value || r.environmentId === environmentId.value) &&
      (filter.value === 'all' || r.status === filter.value),
  ),
);
async function load() {
  if (!projectId.value || !environmentId.value) return;
  try {
    [releases.value, policy.value] = await Promise.all([
      api('/releases?projectId=' + projectId.value),
      api(`/release-policies?projectId=${projectId.value}&environmentId=${environmentId.value}`),
    ]);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  poll = setInterval(() => {
    if (!document.hidden) void load();
  }, 3000);
});
onUnmounted(() => clearInterval(poll));
async function create() {
  busy.value = true;
  error.value = '';
  try {
    const r = await api('/releases', {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId.value,
        environmentId: environmentId.value,
        version: version.value,
        commit: commit.value,
        branch: branch.value,
        targetUrl: target.value || undefined,
        baselineId: baselineId.value || undefined,
        notes: notes.value,
      }),
    });
    showCreate.value = false;
    router.push('/releases/' + r.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">RELEASE QUALITY PLATFORM</div>
      <h1>让每次上线，都有质量依据。</h1>
      <p>固定版本、比较变化、验证准入，把质量检查带进发布流程。</p>
    </div>
    <button
      class="button primary"
      :disabled="!env || env.archived"
      @click="
        error = '';
        showCreate = true;
      "
    >
      <Plus :size="17" />创建发布版本
    </button>
  </div>
  <div class="testing-stat-grid">
    <div class="panel">
      <Layers :size="20" /><strong>{{ visible.length }}</strong
      ><span>当前环境发布记录</span>
    </div>
    <div class="panel">
      <ShieldCheck :size="20" /><strong>{{
        visible.filter((r) => r.status === 'ready').length
      }}</strong
      ><span>发布就绪</span>
    </div>
    <div class="panel">
      <GitBranch :size="20" /><strong>{{
        visible.filter((r) => r.status === 'blocked').length
      }}</strong
      ><span>质量阻断</span>
    </div>
    <div class="panel">
      <Terminal :size="20" /><strong>{{
        visible.filter((r) => r.evidence?.source === 'local-runner').length
      }}</strong
      ><span>本地 / CI Runner 记录</span>
    </div>
  </div>
  <div class="toolbar">
    <div class="filters">
      <select v-model="projectId" aria-label="发布项目">
        <option disabled value="">选择项目</option>
        <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option></select
      ><select v-model="environmentId" aria-label="发布环境">
        <option v-for="e in project?.environments" :value="e.id">
          {{ e.name }}{{ e.archived ? ' · 已归档' : '' }}
        </option></select
      ><select v-model="filter" aria-label="发布状态">
        <option value="all">全部状态</option>
        <option v-for="(name, s) in labels" :value="s">{{ name }}</option>
      </select>
    </div>
    <button class="button" :disabled="!policy" @click="showPolicy = true">
      <Settings2 :size="16" />质量策略 v{{ policy?.revision || 0 }}
    </button>
  </div>
  <p v-if="error" class="alert error">{{ error }}</p>
  <section v-if="env && policy" class="release-policy-strip">
    <div>
      <span class="pill" :class="env.protected ? 'orange' : 'green'">{{
        env.protected ? '保护环境 · 需要审批' : '普通环境'
      }}</span><strong>{{ env.name }}</strong
      ><span class="mono">{{ env.url }}</span>
    </div>
    <p>
      {{ policy.samples }} 次独立采样 · 性能 ≥ {{ policy.minPerformance }} · LCP ≤
      {{ policy.maxLcp / 1000 }}s ·
      {{ policy.requireTests ? policy.caseIds.length + ' 个必需回归用例' : '未要求功能测试' }} ·
      证据 {{ policy.maxAgeMinutes }} 分钟有效
    </p>
  </section>
  <section class="panel">
    <div v-if="!projectId" class="full-empty">
      <Layers :size="34" />
      <h2>先连接一个 Web 项目</h2>
      <p>发布版本将关联项目、环境和固定 Commit。</p>
      <button class="button primary" @click="state.showProject = true">创建项目</button>
    </div>
    <div v-else-if="!visible.length" class="full-empty">
      <ShieldCheck :size="34" />
      <h2>为第一个版本建立发布依据</h2>
      <p>配置环境质量策略，再创建带 Commit 的发布记录。</p>
      <div class="button-group">
        <button class="button" @click="showPolicy = true">配置质量策略</button
        ><button class="button primary" :disabled="env?.archived" @click="showCreate = true">
          创建发布版本
        </button>
      </div>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>版本 / Commit</th>
            <th>状态</th>
            <th>质量准入</th>
            <th>来源 / 采样</th>
            <th>创建时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in visible">
            <td>
              <RouterLink :to="'/releases/' + r.id" class="table-project">{{
                r.version
              }}</RouterLink><small class="cell-sub mono"
                >{{ r.commit.slice(0, 12) }} · {{ r.branch || '未关联分支' }}</small
              >
            </td>
            <td>
              <span class="status" :class="r.status">{{ labels[r.status] }}</span>
            </td>
            <td>
              <span class="pill" :class="r.evaluation?.status === 'passed' ? 'green' : 'orange'">{{
                r.evaluation ? (r.evaluation.status === 'passed' ? '通过' : '未通过') : '尚未评估'
              }}</span>
            </td>
            <td>
              {{
                r.evidence?.source === 'platform'
                  ? '平台检测'
                  : r.evidence?.source === 'local-runner'
                    ? 'Local Runner'
                    : '—'
              }}<small class="cell-sub"
                >{{ r.evidence?.scans.length || 0 }} / {{ r.policy.samples }} 次采样</small
              >
            </td>
            <td>{{ date(r.createdAt) }}</td>
            <td>
              <RouterLink :to="'/releases/' + r.id" class="button small-button"
                >发布详情</RouterLink
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <section class="panel release-integration-hint">
    <Terminal :size="23" />
    <div>
      <h3>接入你的开发与发布流程</h3>
      <p>
        在 CI 中运行 npm run release，使用退出码阻断发布，并保存 JSON、Markdown、JUnit 报告。Local
        Runner 在本地访问未公开的预览环境。
      </p>
      <RouterLink to="/environments" class="text-button">管理多环境与部署记录</RouterLink>
    </div>
  </section>
  <ReleasePolicyEditor
    v-if="showPolicy && policy"
    :policy="policy"
    @close="showPolicy = false"
    @saved="load"
  />
  <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="release-title">
      <h2 id="release-title">创建发布版本</h2>
      <p class="muted">{{ project?.name }} · {{ env?.name }} · 策略 v{{ policy?.revision }}</p>
      <form @submit.prevent="create">
        <div class="form-grid">
          <label
            >版本名称<input
              v-model="version"
              required
              maxlength="100"
              placeholder="v3.0.0" /></label
          ><label
            >Commit SHA<input
              v-model="commit"
              required
              pattern="[a-fA-F0-9]{7,64}"
              placeholder="7–64 位十六进制 SHA"
          /></label>
        </div>
        <label>分支<input v-model="branch" maxlength="200" placeholder="main" /></label
        ><label
          >本版本检测地址<input
            v-model="target"
            type="url"
            required
            placeholder="https://preview.example.com" /></label
        ><label
          >版本基线<select v-model="baselineId">
            <option value="">不选择 · 仅评估绝对标准</option>
            <option
              v-for="b in releases.filter(
                (r) => r.projectId === projectId && r.evaluation?.status === 'passed',
              )"
              :value="b.id"
            >
              {{ b.version }} · {{ b.environmentId }}
            </option>
          </select></label
        ><label>发布说明<textarea v-model="notes" rows="3" maxlength="4000"></textarea></label>
        <p class="info-note">
          创建后固定环境、策略与用例版本。跨环境晋级需要重新检测，不会把预发布结果直接当作生产结果。
        </p>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="showCreate = false">取消</button
          ><button class="button primary" :disabled="busy">创建版本</button>
        </div>
      </form>
    </section>
  </div>
</template>
