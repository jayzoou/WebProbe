<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { Plus, Trash2, X, Sparkles, Save } from 'lucide-vue-next';
import { api, notify, state } from '../state';
import type { TestCase, TestCaseInput, TestStep } from '../../../../packages/shared/src/testing';
const props = defineProps<{ projectId: string; testCase?: TestCase }>(),
  emit = defineEmits<{ close: []; saved: [] }>();
const form = reactive({
  name: props.testCase?.name || '',
  description: props.testCase?.description || '',
  steps: JSON.parse(
    JSON.stringify(
      props.testCase?.steps || [{ action: 'navigate', path: '/' }, { action: 'assertNoErrors' }],
    ),
  ) as any[],
  tags: props.testCase?.tags.join(',') || '',
});
const actions: Record<string, string> = {
  navigate: '打开页面',
  click: '点击',
  fill: '输入文本',
  select: '选择选项',
  check: '勾选 / 取消',
  press: '按键',
  assertVisible: '断言元素可见',
  assertHidden: '断言元素隐藏',
  assertText: '断言包含文本',
  assertUrl: '断言页面地址',
  assertNoErrors: '断言无运行异常',
  visual: '视觉检查点',
};
const draftId = ref('');
const busy = ref(false),
  error = ref(''),
  goal = ref(''),
  env = ref(state.projects.find((p) => p.id === props.projectId)?.environments[0]?.id || ''),
  path = ref('/'),
  provider = ref(''),
  warnings = ref<string[]>([]),
  revisions = ref<TestCase[]>([]);
onMounted(async () => {
  if (props.testCase) revisions.value = await api(`/test-cases/${props.testCase.id}/revisions`);
});
function change(i: number, action: string) {
  form.steps[i] =
    action === 'navigate' || action === 'assertUrl'
      ? { action, path: '/' }
      : action === 'visual'
        ? { action, name: 'checkpoint-' + (i + 1), maxDiffRatio: 0.01, masks: [] }
        : action === 'assertNoErrors'
          ? { action }
          : {
              action,
              target: { by: 'testId', value: '' },
              ...(action === 'fill' || action === 'select'
                ? { value: '' }
                : action === 'assertText'
                  ? { text: '' }
                  : action === 'check'
                    ? { checked: true }
                    : action === 'press'
                      ? { key: 'Enter' }
                      : {}),
            };
}
async function generate() {
  busy.value = true;
  error.value = '';
  try {
    const result = await api('/test-cases/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: props.projectId,
        environmentId: env.value,
        path: path.value,
        goal: goal.value,
      }),
    });
    Object.assign(form, {
      name: result.draft.name,
      description: result.draft.description,
      steps: result.draft.steps,
      tags: result.draft.tags.join(','),
    });
    provider.value = result.provider;
    draftId.value = result.draftId;
    warnings.value = result.warnings;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const input: TestCaseInput = {
      projectId: props.projectId,
      name: form.name,
      description: form.description,
      steps: form.steps as TestStep[],
      tags: form.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    await api(
      props.testCase
        ? `/test-cases/${props.testCase.id}`
        : '/test-cases' + (draftId.value ? '?draftId=' + draftId.value : ''),
      {
        method: props.testCase ? 'PUT' : 'POST',
        body: JSON.stringify(input),
      },
    );
    notify('测试用例已保存');
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
      aria-labelledby="case-title"
    >
      <div class="modal-heading">
        <h2 id="case-title">
          {{ testCase ? '编辑用例 · v' + testCase.revision : '创建测试用例' }}
        </h2>
        <button class="icon-button" @click="emit('close')" aria-label="关闭">
          <X :size="20" />
        </button>
      </div>
      <details class="generation-panel">
        <summary><Sparkles :size="16" />从自然语言生成测试</summary>
        <div class="form-grid">
          <label
            >参考环境<select v-model="env">
              <option
                v-for="e in state.projects.find((p) => p.id === projectId)?.environments"
                :value="e.id"
              >
                {{ e.name }}
              </option>
            </select></label
          ><label>页面路径<input v-model="path" placeholder="/" /></label>
        </div>
        <label
          >操作目标与预期<textarea
            v-model="goal"
            rows="4"
            placeholder="在“搜索”中输入“Vue”；点击“查找”；显示“结果列表”；无运行异常"
          ></textarea>
        </label>
        <p class="muted">
          会读取此页面的真实元素。AI 草稿需复核预期；规则模式使用带引号的实际元素名称。
        </p>
        <button class="button" :disabled="busy || goal.length < 4" @click="generate">
          <Sparkles :size="16" />{{
            busy ? '生成中…' : state.health?.aiConfigured ? 'AI 生成草稿' : '规则生成草稿'
          }}
        </button>
        <p v-if="provider" class="pill">{{ provider === 'ai' ? 'AI 生成' : '规则解析 · 非 AI' }}</p>
        <p v-for="w in warnings" class="info-note">{{ w }}</p>
      </details>
      <form @submit.prevent="save">
        <label
          >用例名称<input
            v-model="form.name"
            maxlength="120"
            required
            placeholder="例如：搜索结果应正常展示" /></label
        ><label
          >测试说明与业务预期<textarea
            v-model="form.description"
            rows="2"
            maxlength="4000"
            placeholder="说明测试要保证的业务行为"
          ></textarea>
        </label>
        <div class="label-line">
          <strong>测试步骤 · {{ form.steps.length }}/40</strong
          ><button
            type="button"
            class="text-button"
            :disabled="form.steps.length >= 40"
            @click="form.steps.push({ action: 'assertNoErrors' })"
          >
            <Plus :size="15" />添加步骤
          </button>
        </div>
        <div v-for="(s, index) in form.steps" :key="index" class="test-step-editor">
          <div class="step-number">{{ index + 1 }}</div>
          <div class="step-fields">
            <select
              :value="s.action"
              @change="change(index, ($event.target as HTMLSelectElement).value)"
              aria-label="步骤动作"
            >
              <option v-for="(label, key) in actions" :value="key">{{ label }}</option></select
            ><input
              v-if="s.action === 'navigate' || s.action === 'assertUrl'"
              v-model="s.path"
              required
              placeholder="站内路径，例如 /search"
              aria-label="页面路径"
            /><template v-if="s.target"
              ><div class="target-fields">
                <select v-model="s.target.by" aria-label="定位方式">
                  <option value="testId">Test ID</option>
                  <option value="label">标签名称</option>
                  <option value="role">ARIA Role</option>
                  <option value="text">完整文本</option>
                  <option value="css">CSS 选择器</option></select
                ><input
                  v-model="s.target.value"
                  required
                  placeholder="目标元素"
                  aria-label="目标元素"
                />
              </div>
              <input
                v-if="s.target.by === 'role'"
                v-model="s.target.name"
                placeholder="角色名称（可选）"
                aria-label="角色名称" /></template
            ><input
              v-if="s.action === 'fill' || s.action === 'select'"
              v-model="s.value"
              placeholder="输入值 / 选项值"
              aria-label="操作值"
            /><input
              v-if="s.action === 'assertText'"
              v-model="s.text"
              required
              placeholder="预期包含的文本"
              aria-label="预期文本"
            /><select v-if="s.action === 'press'" v-model="s.key" aria-label="按键">
              <option v-for="k in ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']">
                {{ k }}
              </option></select
            ><label v-if="s.action === 'check'" class="choice"
              ><input type="checkbox" v-model="s.checked" />期望勾选</label
            ><template v-if="s.action === 'visual'"
              ><input
                v-model="s.name"
                required
                pattern="[a-zA-Z0-9_-]{1,60}"
                placeholder="检查点名称，英文"
                aria-label="视觉检查点名称" /><label
                >最大差异率<input
                  v-model.number="s.maxDiffRatio"
                  type="number"
                  min="0"
                  max="0.2"
                  step="0.001"
                  required /></label
              ><input
                :value="s.masks.join(',')"
                @input="
                  s.masks = ($event.target as HTMLInputElement).value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
                "
                placeholder="遮罩 CSS，逗号分隔"
                aria-label="动态元素遮罩"
            /></template>
          </div>
          <div class="step-tools">
            <button
              type="button"
              class="icon-button"
              :disabled="index === 0"
              aria-label="上移步骤"
              @click="
                [form.steps[index - 1], form.steps[index]] = [
                  form.steps[index],
                  form.steps[index - 1],
                ]
              "
            >
              ↑</button
            ><button
              type="button"
              class="icon-button"
              :disabled="form.steps.length <= 1"
              aria-label="删除步骤"
              @click="form.steps.splice(index, 1)"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </div>
        <label
          >标签 <span class="muted">逗号分隔</span
          ><input v-model="form.tags" placeholder="冒烟, 搜索"
        /></label>
        <details v-if="revisions.length">
          <summary>历史版本（执行结果保留原版本快照）</summary>
          <button
            v-for="r in revisions"
            type="button"
            class="button small-button"
            @click="
              form.steps = JSON.parse(JSON.stringify(r.steps));
              form.name = r.name;
              form.description = r.description;
            "
          >
            载入 v{{ r.revision }}
          </button>
        </details>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="emit('close')">取消</button
          ><button class="button primary" :disabled="busy"><Save :size="16" />保存用例</button>
        </div>
      </form>
    </section>
  </div>
</template>
