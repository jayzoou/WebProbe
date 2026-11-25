<script setup lang="ts">
import { reactive, ref } from 'vue';
import { X, Plus, Trash2, FolderPlus } from 'lucide-vue-next';
import { state, api, refresh, notify } from '../state';
import type { Project } from '../../../../packages/shared/src/index';
const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ close: [] }>();
const form = reactive(
  props.project
    ? JSON.parse(JSON.stringify(props.project))
    : {
        name: '',
        description: '',
        environments: [{ id: 'production', name: '生产环境', url: '' }],
        gate: { minPerformance: 80, maxLcp: 2500, maxCls: 0.1, maxCritical: 0 },
      },
);
const busy = ref(false),
  error = ref('');
async function save() {
  busy.value = true;
  error.value = '';
  try {
    await api(props.project ? `/projects/${props.project.id}` : '/projects', {
      method: props.project ? 'PUT' : 'POST',
      body: JSON.stringify(form),
    });
    await refresh();
    notify(props.project ? '项目已更新' : '项目已创建，可以开始第一次检测');
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
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
      <div class="modal-heading">
        <span class="square-icon"><FolderPlus :size="23" /></span
        ><button class="icon-button" aria-label="关闭" @click="emit('close')">
          <X :size="21" />
        </button>
      </div>
      <h2 id="project-title">{{ project ? '编辑项目' : '创建新项目' }}</h2>
      <p class="muted">连接你的网站，为每次检测积累质量依据。</p>
      <form @submit.prevent="save">
        <label
          >项目名称<input
            v-model="form.name"
            required
            maxlength="80"
            placeholder="例如：个人博客"
            autofocus /></label
        ><label
          >项目描述 <span class="muted">可选</span
          ><input v-model="form.description" maxlength="500" placeholder="简单介绍项目用途"
        /></label>
        <div class="label-line">
          <strong>检测环境</strong
          ><button
            type="button"
            class="text-button"
            @click="
              form.environments.push({ id: 'env-' + Date.now(), name: '预发布环境', url: '' })
            "
            :disabled="form.environments.length >= 8"
          >
            <Plus :size="15" />添加环境
          </button>
        </div>
        <div v-for="(env, index) in form.environments" :key="env.id" class="env-row">
          <input v-model="env.name" required aria-label="环境名称" placeholder="环境名称" /><input
            v-model="env.url"
            type="url"
            required
            placeholder="https://example.com"
            aria-label="检测网址"
          /><button
            v-if="form.environments.length > 1"
            type="button"
            class="icon-button"
            aria-label="移除环境"
            @click="form.environments.splice(index, 1)"
          >
            <Trash2 :size="16" />
          </button>
        </div>
        <details class="gate-settings">
          <summary>发布质量标准</summary>
          <div class="form-grid">
            <label
              >最低性能评分<input
                v-model.number="form.gate.minPerformance"
                type="number"
                min="0"
                max="100"
                required /></label
            ><label
              >LCP 上限（ms）<input
                v-model.number="form.gate.maxLcp"
                type="number"
                min="100"
                max="30000"
                required /></label
            ><label
              >CLS 上限<input
                v-model.number="form.gate.maxCls"
                type="number"
                min="0"
                max="1"
                step="0.01"
                required /></label
            ><label
              >P0 / P1 问题上限<input
                v-model.number="form.gate.maxCritical"
                type="number"
                min="0"
                max="100"
                required
            /></label>
          </div>
        </details>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="emit('close')">取消</button
          ><button class="button primary" :disabled="busy">
            {{ busy ? '保存中…' : '保存项目' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
