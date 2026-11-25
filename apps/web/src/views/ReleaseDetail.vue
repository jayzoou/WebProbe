<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronLeft,
  Play,
  Terminal,
  Download,
  CheckCircle2,
  TriangleAlert,
  GitBranch,
  ShieldCheck,
  Square,
  Copy,
} from 'lucide-vue-next';
import { state, api, date, notify, download } from '../state';
import type {
  Release,
  ReleaseEvent,
  GateEvaluation,
} from '../../../../packages/shared/src/releases';
const location = window.location;
const route = useRoute(),
  router = useRouter(),
  r = ref<Release>(),
  events = ref<ReleaseEvent[]>([]),
  evaluations = ref<GateEvaluation[]>([]),
  error = ref(''),
  busy = ref(false),
  tab = ref('gate'),
  dialog = ref(''),
  actor = ref(''),
  note = ref(''),
  deployUrl = ref(''),
  deployCommit = ref(''),
  targetEnv = ref(''),
  runnerToken = ref(''),
  runnerJobId = ref(''),
  baselineId = ref(''),
  releases = ref<Release[]>([]);
let poll: ReturnType<typeof setInterval>;
const active = computed(() => r.value && ['checking', 'waiting_runner'].includes(r.value.status)),
  env = computed(() =>
    r.value?.projectSnapshot.environments.find((e) => e.id === r.value?.environmentId),
  );
const labels: Record<string, string> = {
  draft: '待验证',
  checking: '验证中',
  waiting_runner: '等待 Runner',
  ready: '发布就绪',
  awaiting_approval: '等待审批',
  blocked: '发布阻断',
  deployed: '已登记部署',
  cancelled: '已取消',
  passed: '通过',
  failed: '不通过',
  not_applicable: '未纳入范围',
};
async function load() {
  try {
    const [release, history] = await Promise.all([
      api<Release>('/releases/' + route.params.id),
      api<{ events: ReleaseEvent[]; evaluations: GateEvaluation[] }>(
        '/releases/' + route.params.id + '/history',
      ),
    ]);
    r.value = release;
    events.value = history.events;
    evaluations.value = history.evaluations;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  poll = setInterval(() => {
    if (active.value && !document.hidden) void load();
  }, 2000);
});
watch(
  () => route.params.id,
  () => {
    runnerToken.value = '';
    void load();
  },
);
onUnmounted(() => clearInterval(poll));
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
async function post(action: string, body: unknown = {}) {
  return api(`/releases/${r.value!.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
}
async function runner() {
  await act(async () => {
    const issued = await post('runner-jobs');
    runnerToken.value = issued.token;
    runnerJobId.value = issued.job.id;
    dialog.value = 'runner';
  });
}
async function approve() {
  await act(async () => {
    await post('approve', { actor: actor.value, note: note.value });
    dialog.value = '';
  });
}
async function deploy() {
  await act(async () => {
    await post('deployments', {
      actor: actor.value,
      note: note.value,
      url: deployUrl.value,
      commit: deployCommit.value,
      source: 'manual',
    });
    dialog.value = '';
  });
}
async function promote() {
  await act(async () => {
    const next = await post('promote', { environmentId: targetEnv.value });
    dialog.value = '';
    router.push('/releases/' + next.id);
  });
}
async function chooseBaseline() {
  releases.value = await api('/releases?projectId=' + r.value!.projectId);
  baselineId.value = r.value!.baselineId || '';
  dialog.value = 'baseline';
}
async function copyToken() {
  try {
    await navigator.clipboard.writeText(runnerToken.value);
    notify('单任务凭证已复制，请仅用于受信任的 Runner 环境');
  } catch {
    error.value = '无法复制，请从凭证输入框手动复制';
  }
}
</script>
<template>
  <RouterLink to="/releases" class="back-link"><ChevronLeft :size="16" />发布中心</RouterLink>
  <p v-if="error" class="alert error">{{ error }}</p>
  <div v-if="!r" class="full-empty">正在读取发布记录…</div>
  <template v-else
    ><div class="page-heading">
      <div>
        <div class="eyebrow">RELEASE QUALITY · {{ r.projectSnapshot.name }}</div>
        <h1>
          {{ r.version }}<span class="status" :class="r.status">{{ labels[r.status] }}</span>
        </h1>
        <p class="mono">{{ r.commit }} · {{ r.branch || '未关联分支' }}</p>
        <p>{{ env?.name }} · 策略 v{{ r.policy.revision }} · 第 {{ r.attempt }} 次验证</p>
      </div>
      <div class="button-group">
        <button
          v-if="!active && r.status !== 'deployed'"
          class="button primary"
          :disabled="busy"
          @click="act(() => post('check'))"
        >
          <Play :size="16" />平台质量验证</button
        ><button
          v-if="!active && r.status !== 'deployed'"
          class="button"
          :disabled="busy"
          @click="runner"
        >
          <Terminal :size="16" />Local Runner</button
        ><button v-if="active" class="button" @click="act(() => post('cancel'))">
          <Square :size="16" />取消验证</button
        ><button
          class="button"
          @click="
            act(() => download(`/api/releases/${r!.id}/export?format=bundle`, `${r!.id}.zip`))
          "
        >
          <Download :size="16" />发布报告包
        </button>
      </div>
    </div>
    <section class="release-target">
      <div>
        <strong>本版本检测地址</strong><span class="mono break-word">{{ r.targetUrl }}</span>
      </div>
      <div>
        <strong>部署目标环境</strong><span class="mono break-word">{{ r.environmentUrl }}</span>
      </div>
      <div>
        <strong>证据来源</strong
        ><span>{{
          r.evidence?.source === 'platform'
            ? '平台执行'
            : r.evidence?.source === 'local-runner'
              ? '受信任 Runner 声明'
              : '尚无证据'
        }}</span>
      </div>
    </section>
    <section v-if="active" class="panel scan-progress">
      <h3>{{ r.stage }}</h3>
      <progress :value="r.progress" max="100"></progress>
      <p class="muted">
        {{
          r.status === 'waiting_runner'
            ? '请在任务有效期内运行授权的 Local Runner。'
            : '将执行固定配置的多次扫描与回归用例。'
        }}
      </p>
    </section>
    <p
      v-if="r.readiness?.ready === false && ['ready', 'deployed'].includes(r.status)"
      class="alert error"
    >
      当前准入资格已失效：{{ r.readiness.reason }}。请重新验证或采用当前策略。
    </p>
    <p v-if="r.error" class="alert error">{{ r.error }}</p>
    <section
      class="release-decision"
      :class="r.evaluation?.status === 'passed' ? 'accepted' : 'rejected'"
    >
      <ShieldCheck v-if="r.evaluation?.status === 'passed'" :size="29" /><TriangleAlert
        v-else
        :size="29"
      />
      <div>
        <h2>
          {{
            r.status === 'deployed'
              ? '部署结果已由调用方登记'
              : r.status === 'ready'
                ? '发布已就绪'
                : r.status === 'awaiting_approval'
                  ? '质量通过，等待人工审批'
                  : r.evaluation
                    ? '质量标准尚未满足'
                    : '等待完整质量依据'
          }}
        </h2>
        <p>
          {{
            r.status === 'deployed'
              ? '平台保存版本和准入依据，实际部署由你的流水线执行。'
              : r.evaluation
                ? '检查下方逐项结果，修复后重新验证。审批仅对本次评估生效。'
                : '未取得完整检测证据时，不会判定为通过。'
          }}
        </p>
      </div>
      <div class="button-group">
        <button
          v-if="r.status === 'awaiting_approval'"
          class="button primary"
          @click="
            dialog = 'approve';
            actor = '';
            note = '';
          "
        >
          审批发布</button
        ><button
          v-if="r.status === 'ready' && r.readiness?.ready !== false"
          class="button primary"
          @click="
            dialog = 'deploy';
            deployUrl = r.environmentUrl;
            deployCommit = '';
            actor = '';
            note = '';
          "
        >
          登记已完成的部署</button
        ><button
          v-if="['ready', 'deployed'].includes(r.status)"
          class="button"
          @click="
            dialog = 'promote';
            targetEnv = '';
          "
        >
          晋级到下一环境
        </button>
      </div>
    </section>
    <div class="issue-tabs">
      <button
        v-for="t in [
          { id: 'gate', name: 'Quality Gate' },
          { id: 'comparison', name: '版本对比' },
          { id: 'evidence', name: '检测与回归' },
          { id: 'history', name: '发布时间线' },
          { id: 'ci', name: 'CI/CD 接入' },
        ]"
        :class="{ selected: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.name }}
      </button>
    </div>
    <template v-if="tab === 'gate'"
      ><div class="toolbar">
        <strong>{{ r.policy.name }} · v{{ r.policy.revision }}</strong>
        <div class="button-group">
          <button
            class="button small-button"
            :disabled="!!active || r.status === 'deployed'"
            @click="act(() => post('evaluate', { refreshPolicy: true }))"
          >
            采用当前策略重新评估</button
          ><button
            class="button small-button"
            :disabled="!!active || r.status === 'deployed'"
            @click="act(() => post('evaluate'))"
          >
            按快照重新评估
          </button>
        </div>
      </div>
      <section class="panel">
        <div v-if="!r.evaluation" class="full-empty">
          <ShieldCheck :size="33" />
          <h2>等待质量验证</h2>
          <p>每条准入规则都将给出实际值、标准和判定结果。</p>
        </div>
        <div v-else class="release-checks">
          <article v-for="c in r.evaluation.checks">
            <CheckCircle2
              v-if="c.status === 'passed'"
              :size="19"
              class="text-green"
            /><TriangleAlert
              v-else-if="c.status !== 'not_applicable'"
              :size="19"
              class="text-orange"
            /><span v-else class="muted">—</span>
            <div>
              <strong>{{ c.name }}</strong>
              <p>标准：{{ c.expected }}</p>
            </div>
            <div class="release-check-actual">
              <span>{{ c.actual }}</span><span
                class="pill"
                :class="
                  c.status === 'passed' ? 'green' : c.status === 'not_applicable' ? '' : 'orange'
                "
                >{{ labels[c.status] || c.status }}</span
              >
            </div>
          </article>
        </div>
      </section></template
    >
    <section v-if="tab === 'comparison'" class="panel">
      <div class="panel-heading">
        <div>
          <h3>与固定基线比较</h3>
          <p>性能按匹配页面、浏览器与设备的独立采样中位数比较。</p>
        </div>
        <button
          class="button small-button"
          :disabled="!!active || r.status === 'deployed'"
          @click="chooseBaseline"
        >
          选择版本基线
        </button>
      </div>
      <div v-if="!r.evaluation?.comparison" class="full-empty">
        <GitBranch :size="32" />
        <p>
          {{
            r.baselineId
              ? '基线将在取得证据后参与比较。'
              : '尚未选择版本基线；当前仅评估绝对质量标准。'
          }}
        </p>
      </div>
      <template v-else
        ><p v-if="!r.evaluation.comparison.compatible" class="alert error">
          {{ r.evaluation.comparison.reason }}
        </p>
        <div class="comparison-counts">
          <div>
            <strong class="text-orange">{{ r.evaluation.comparison.added.length }}</strong>新增问题
          </div>
          <div>
            <strong>{{ r.evaluation.comparison.persistent }}</strong>持续存在
          </div>
          <div>
            <strong class="text-green">{{
              r.evaluation.comparison.removed.length
            }}</strong>本次未再发现
          </div>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>页面 / 设备</th>
                <th>指标</th>
                <th>基线</th>
                <th>当前</th>
                <th>变化</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in r.evaluation.comparison.metrics">
                <td>{{ m.path }} · {{ m.device }}</td>
                <td>{{ m.metric }}</td>
                <td>{{ Math.round(m.before * 1000) / 1000 }}</td>
                <td>{{ Math.round(m.after * 1000) / 1000 }}</td>
                <td
                  :class="
                    (m.metric === 'performance' ? m.delta >= 0 : m.delta <= 0)
                      ? 'text-green'
                      : 'text-orange'
                  "
                >
                  {{ m.delta > 0 ? '+' : '' }}{{ Math.round(m.delta * 1000) / 1000 }}
                  <small>{{ m.percent === null ? '' : `(${m.percent.toFixed(1)}%)` }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <RouterLink
          v-if="r.baselineId"
          :to="'/releases/' + r.baselineId"
          class="button release-panel-link"
          >查看基线版本</RouterLink
        ></template
      >
    </section>
    <template v-if="tab === 'evidence'"
      ><section class="panel">
        <div class="panel-heading">
          <h3>真实性能采样 · {{ r.evidence?.scans.length || 0 }} / {{ r.policy.samples }}</h3>
        </div>
        <div v-if="!r.evidence" class="panel-placeholder">尚无检测证据。</div>
        <div v-for="(s, i) in r.evidence?.scans" class="release-sample">
          <strong
            >采样 {{ i + 1 }} <span class="pill">{{ s.status }}</span></strong
          ><span>{{ s.pages.length }} 个页面设备组合 · {{ s.findings.length }} 条发现</span
          ><RouterLink
            v-if="r.evidence?.source === 'platform'"
            :to="'/scans/' + s.id"
            class="text-button"
            >完整扫描报告</RouterLink
          >
        </div>
      </section>
      <section class="panel test-result-card">
        <div class="panel-heading">
          <h3>固定用例回归</h3>
          <RouterLink
            v-if="r.evidence?.source === 'platform' && r.evidence.tests"
            :to="'/testing/runs/' + r.evidence.tests.id"
            class="text-button"
            >完整回归证据</RouterLink
          >
        </div>
        <div v-if="!r.evidence?.tests" class="panel-placeholder">
          {{
            r.policy.requireTests
              ? '尚无完整回归结果；缺失时不会通过。'
              : '策略未要求功能测试，不形成业务正确性结论。'
          }}
        </div>
        <div v-else class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>用例</th>
                <th>版本</th>
                <th>浏览器 / 设备</th>
                <th>完成步骤</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in r.evidence.tests.results">
                <td>{{ r.cases.find((c) => c.id === t.caseId)?.name || t.caseId }}</td>
                <td>v{{ t.revision }}</td>
                <td>{{ t.browser }} / {{ t.device }}</td>
                <td>{{ t.passedSteps }} / {{ t.stepCount }}</td>
                <td>
                  <span class="status" :class="t.status">{{
                    labels[t.status] || t.status
                  }}</span><small v-if="t.error" class="cell-sub">{{ t.error }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h3>附件与原始报告</h3></div>
        <div v-for="a in r.evidence?.artifacts" class="release-sample">
          <span class="mono break-word">{{ a.name }}</span><small
            >{{ Math.round(a.bytes / 1024) }} KB</small
          ><button class="text-button" @click="act(() => download(a.url, a.name))">下载证据</button>
        </div>
        <p v-if="!r.evidence?.artifacts.length" class="panel-placeholder">尚无附件。</p>
      </section></template
    >
    <section v-if="tab === 'history'" class="panel">
      <div class="panel-heading"><h3>发布事件与准入历史</h3></div>
      <div class="release-timeline">
        <article v-for="e in events">
          <i></i>
          <div>
            <strong>{{ e.message }}</strong>
            <p>{{ date(e.createdAt) }} · {{ e.type }}</p>
          </div>
        </article>
      </div>
      <details class="release-history-evaluations">
        <summary>历史评估（{{ evaluations.length }}）</summary>
        <div v-for="e in evaluations" class="delta-row">
          <span>{{ date(e.createdAt) }} · 策略 v{{ e.policyRevision }}</span
          ><span>{{ e.status }}</span
          ><span class="mono">{{ e.id.slice(0, 8) }}</span>
        </div>
      </details>
    </section>
    <section v-if="tab === 'ci'" class="panel testing-action-panel">
      <h2><Terminal :size="23" />接入你的流水线</h2>
      <p>
        凭证从环境变量读取。CI 命令真实执行检测并保存 JSON、Markdown、JUnit
        报告，返回非零时应阻断后续部署步骤。
      </p>
      <pre class="evidence">
npm run release -- check --release {{ r.id }} --mode platform --output webprobe-results

# 在可访问目标站点的本地 / CI 执行器运行
npm run release -- check --release {{ r.id }} --mode local --output webprobe-results</pre>
      <p>0：发布就绪；1：质量阻断；2：执行错误/超时；3：待审批；4：已取消。</p>
      <div v-if="r.ci" class="info-note">
        <span
          >{{ r.ci.provider }} · {{ r.ci.repository }} · {{ r.ci.runId
          }}<a
            v-if="r.ci.runUrl"
            :href="r.ci.runUrl"
            target="_blank"
            rel="noreferrer"
            class="text-button"
            >打开调用方提供的流水线链接</a
          ></span
        >
      </div>
      <p class="info-note">
        Runner
        声明与流水线元数据由持凭证的调用方提交。平台记录质量依据，不执行代码构建或部署；请在实际部署成功后再登记结果。
      </p>
    </section>
    <div v-if="dialog" class="modal-backdrop" @click.self="dialog = ''">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="release-action-title">
        <h2 id="release-action-title">
          {{
            {
              approve: '审批本次发布',
              deploy: '登记已完成的部署',
              promote: '晋级到下一环境',
              runner: '授权 Local Runner',
              baseline: '选择版本基线',
            }[dialog]
          }}
        </h2>
        <template v-if="dialog === 'runner'"
          ><p class="info-note">
            凭证仅本次显示，1 小时有效，只能读取和回传此任务。完成或取消后失效，不具备项目管理权限。
          </p>
          <label
            >单任务凭证<input
              :value="runnerToken"
              readonly
              type="password"
              aria-label="Runner 凭证" /></label
          ><button class="button" @click="copyToken"><Copy :size="16" />复制凭证</button>
          <pre class="evidence">
# 将凭证安全写入 WEBPROBE_RUNNER_TOKEN 环境变量
npm run release -- runner --job {{ runnerJobId }} --server {{
              location.origin
            }} --output webprobe-results</pre>
          <p class="muted">
            检测本机或内网地址时显式添加 --allow-private-network。无需把整个代码库发送到平台。
          </p>
          <div class="modal-actions">
            <button class="button primary" @click="dialog = ''">已保存凭证</button>
          </div></template
        >
        <form
          v-else
          @submit.prevent="
            dialog === 'approve'
              ? approve()
              : dialog === 'deploy'
                ? deploy()
                : dialog === 'promote'
                  ? promote()
                  : act(async () => {
                      await post('baseline', { baselineId: baselineId || null });
                      dialog = '';
                    })
          "
        >
          <template v-if="dialog === 'approve' || dialog === 'deploy'"
            ><label
              >操作人<input
                v-model="actor"
                required
                maxlength="100"
                placeholder="姓名 / CI 标识" /></label
            ><label
              >说明<textarea
                v-model="note"
                :required="dialog === 'approve'"
                maxlength="1000"
                rows="3"
              ></textarea></label></template
          ><template v-if="dialog === 'deploy'"
            ><label>实际部署地址<input v-model="deployUrl" type="url" required /></label
            ><label
              >确认实际部署的 Commit<input
                v-model="deployCommit"
                required
                placeholder="填写与本次验证一致的 Commit SHA"
            /></label>
            <p class="info-note">
              此操作只登记外部已完成的部署。平台不会上传或部署你的应用。
            </p></template
          ><label v-if="dialog === 'promote'"
            >目标环境<select v-model="targetEnv" required>
              <option disabled value="">选择下一环境</option>
              <option
                v-for="e in state.projects
                  .find((p) => p.id === r!.projectId)
                  ?.environments.filter((e) => e.id !== r!.environmentId && !e.archived)"
                :value="e.id"
              >
                {{ e.name }}
              </option>
            </select></label
          >
          <p v-if="dialog === 'promote'" class="info-note">
            保留 Commit，在目标环境创建独立发布，重新执行其质量策略。
          </p>
          <label v-if="dialog === 'baseline'"
            >版本基线<select v-model="baselineId">
              <option value="">清除基线 · 仅评估绝对标准</option>
              <option
                v-for="b in releases.filter(
                  (b) => b.id !== r!.id && b.evaluation?.status === 'passed',
                )"
                :value="b.id"
              >
                {{ b.version }} · {{ b.environmentId }}
              </option>
            </select></label
          >
          <p v-if="error" class="alert error">{{ error }}</p>
          <div class="modal-actions">
            <button type="button" class="button" @click="dialog = ''">取消</button
            ><button class="button primary" :disabled="busy">
              确认{{
                dialog === 'deploy'
                  ? '登记'
                  : dialog === 'approve'
                    ? '审批'
                    : dialog === 'promote'
                      ? '晋级'
                      : '选择'
              }}
            </button>
          </div>
        </form>
      </section>
    </div></template
  >
</template>
