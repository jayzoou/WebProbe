<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue';
import { X, ShieldCheck } from 'lucide-vue-next';
import { api, notify } from '../state';
import type { ReleasePolicy } from '../../../../packages/shared/src/releases';
import type { TestCase } from '../../../../packages/shared/src/testing';
const props = defineProps<{ policy: ReleasePolicy }>(),
  emit = defineEmits<{ close: []; saved: [] }>();
const form = reactive(JSON.parse(JSON.stringify(props.policy)) as ReleasePolicy),
  cases = ref<TestCase[]>([]),
  error = ref(''),
  busy = ref(false),
  paths = ref(props.policy.paths.join('\n'));
onMounted(async () => {
  try {
    cases.value = (await api<TestCase[]>('/test-cases?projectId=' + form.projectId)).filter(
      (c) => !c.archived,
    );
  } catch (e) {
    error.value = (e as Error).message;
  }
});
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const { id, revision, updatedAt, ...policy } = form;
    policy.paths = paths.value
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    await api('/release-policies', {
      method: 'PUT',
      body: JSON.stringify({ policy, expectedRevision: props.policy.revision }),
    });
    notify('环境质量策略已保存；已有发布需要显式采用新策略');
    emit('saved');
    emit('close');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section
      class="modal testing-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="policy-title"
    >
      <div class="modal-heading">
        <h2 id="policy-title"><ShieldCheck :size="23" />发布质量策略 · v{{ policy.revision }}</h2>
        <button class="icon-button" aria-label="关闭" @click="emit('close')">
          <X :size="20" />
        </button>
      </div>
      <form @submit.prevent="save">
        <label>策略名称<input v-model="form.name" required maxlength="100" /></label>
        <div class="form-grid">
          <label
            >独立性能采样次数<select v-model="form.samples">
              <option :value="1">1 次</option>
              <option :value="2">2 次 · 中位数</option>
              <option :value="3">3 次 · 中位数</option>
            </select></label
          ><label
            >最多页面<input type="number" v-model.number="form.maxPages" min="1" max="5" required
          /></label>
        </div>
        <label
          >指定路径（每行一个，入口页面自动包含）<textarea
            v-model="paths"
            rows="2"
            placeholder="/about"
          ></textarea></label
        ><label>浏览器</label>
        <div class="choice-row">
          <label v-for="b in ['chromium', 'firefox', 'webkit']" class="choice"
            ><input type="checkbox" v-model="form.browsers" :value="b" />{{ b }}</label
          >
        </div>
        <label>设备</label>
        <div class="choice-row">
          <label v-for="d in ['desktop', 'mobile']" class="choice"
            ><input type="checkbox" v-model="form.devices" :value="d" />{{
              d === 'desktop' ? '桌面' : '移动'
            }}</label
          >
        </div>
        <div class="form-grid">
          <label
            >最低性能评分<input
              v-model.number="form.minPerformance"
              type="number"
              min="0"
              max="100"
              required /></label
          ><label
            >LCP 上限（ms）<input
              v-model.number="form.maxLcp"
              type="number"
              min="100"
              max="30000"
              required /></label
          ><label
            >CLS 上限<input
              v-model.number="form.maxCls"
              type="number"
              min="0"
              max="1"
              step="0.01"
              required /></label
          ><label
            >TBT 上限（ms）<input
              v-model.number="form.maxTbt"
              type="number"
              min="0"
              max="30000"
              required /></label
          ><label
            >P0/P1 独立问题上限<input
              v-model.number="form.maxCritical"
              type="number"
              min="0"
              max="1000"
              required /></label
          ><label
            >新增问题上限<input
              v-model.number="form.maxNewIssues"
              type="number"
              min="0"
              max="1000"
              required /></label
          ><label
            >LCP 最大相对退化（%）<input
              v-model.number="form.maxLcpRegressionPct"
              type="number"
              min="0"
              max="1000"
              required /></label
          ><label
            >证据有效期（分钟）<input
              v-model.number="form.maxAgeMinutes"
              type="number"
              min="1"
              max="10080"
              required
          /></label>
        </div>
        <label class="choice"
          ><input v-model="form.requireBaseline" type="checkbox" />必须选择已通过的版本基线</label
        ><label class="choice"
          ><input v-model="form.requireTests" type="checkbox" />必须完成功能回归测试</label
        ><template v-if="form.requireTests"
          ><label
            >最低测试通过率（%）<input
              v-model.number="form.minTestPassRate"
              type="number"
              min="0"
              max="100"
              required
          /></label>
          <div class="policy-case-list">
            <label v-for="c in cases" class="choice"
              ><input v-model="form.caseIds" type="checkbox" :value="c.id" />{{ c.name }} · v{{
                c.revision
              }}</label
            >
            <p v-if="!cases.length" class="info-note">
              还没有可用用例。启用测试但未选择用例时，发布会被阻断；可先去 AI 测试中心创建。
            </p>
          </div>
          <label class="choice"
            ><input v-model="form.allowInteractions" type="checkbox" />允许用例中的页面交互</label
          ><label class="choice"
            ><input v-model="form.allowWrites" type="checkbox" />允许当前环境写请求</label
          ></template
        ><label class="choice"
          ><input v-model="form.allowRunnerEvidence" type="checkbox" />信任持有本任务凭证的 Local
          Runner 结果</label
        >
        <p class="info-note">
          Runner 结果是你的本地/CI
          执行器声明，平台不能证明远程进程未被篡改。仅在信任执行环境时启用。策略更新不会改写历史结论，部署登记会要求采用当前策略。
        </p>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="emit('close')">取消</button
          ><button
            class="button primary"
            :disabled="busy || !form.browsers.length || !form.devices.length"
          >
            保存策略
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
