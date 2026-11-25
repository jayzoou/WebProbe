<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Plus, Layers, ShieldCheck, Settings2 } from 'lucide-vue-next';
import { state, api, refresh, date, notify } from '../state';
import type { Project } from '../../../../packages/shared/src/index';
import type { Deployment } from '../../../../packages/shared/src/releases';
const projectId = ref(state.projectId || ''),
  deployments = ref<Deployment[]>([]),
  editing = ref(false),
  form = ref<any>(),
  error = ref(''),
  busy = ref(false);
const project = computed(() => state.projects.find((p) => p.id === projectId.value)),
  kinds: Record<string, string> = {
    development: '开发',
    preview: '预览',
    staging: '预发布',
    production: '生产',
  };
watch(
  () => state.projects,
  () => {
    if (!projectId.value) projectId.value = state.projectId || state.projects[0]?.id || '';
  },
  { immediate: true },
);
onMounted(async () => {
  try {
    deployments.value = await api('/deployments');
  } catch (e) {
    error.value = (e as Error).message;
  }
});
function edit() {
  form.value = JSON.parse(JSON.stringify(project.value));
  editing.value = true;
}
async function save() {
  busy.value = true;
  try {
    await api('/projects/' + projectId.value, { method: 'PUT', body: JSON.stringify(form.value) });
    await refresh();
    editing.value = false;
    notify('环境配置已保存；历史发布快照保留');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function current(id: string) {
  return deployments.value.find((d) => d.projectId === projectId.value && d.environmentId === id);
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ENVIRONMENTS & DEPLOYMENTS</div>
      <h1>从开发到生产，清楚每一站。</h1>
      <p>管理环境类型、保护状态和部署登记；历史版本保留当时的配置。</p>
    </div>
    <button class="button primary" :disabled="!project" @click="edit">
      <Settings2 :size="17" />管理环境
    </button>
  </div>
  <div class="toolbar">
    <select v-model="projectId" aria-label="环境项目">
      <option disabled value="">选择项目</option>
      <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option></select
    ><RouterLink to="/releases" class="text-button">前往发布中心</RouterLink>
  </div>
  <p v-if="error" class="alert error">{{ error }}</p>
  <div v-if="!project" class="panel full-empty">
    <Layers :size="32" />
    <h2>先创建一个项目</h2>
    <button class="button primary" @click="state.showProject = true">创建项目</button>
  </div>
  <div class="project-grid">
    <article v-for="e in project?.environments" class="panel project-card">
      <div class="project-card-top">
        <span class="project-logo"><Layers :size="21" /></span
        ><span class="pill" :class="e.protected ? 'orange' : 'green'">{{
          e.protected ? '保护环境' : '普通环境'
        }}</span>
      </div>
      <h2>
        {{ e.name }} <span class="pill">{{ kinds[e.kind] }}</span><span
          v-if="e.archived"
          class="pill"
          >已归档</span
        >
      </h2>
      <p class="mono break-word">{{ e.url }}</p>
      <div v-if="current(e.id)" class="environment-deployment">
        <span>最近登记部署</span
        ><RouterLink :to="'/releases/' + current(e.id)!.releaseId"
          ><strong>{{ current(e.id)!.version }}</strong></RouterLink
        ><span class="mono">{{ current(e.id)!.commit.slice(0, 12) }}</span
        ><small>{{ date(current(e.id)!.registeredAt) }} · {{ current(e.id)!.actor }}</small>
      </div>
      <p v-else class="info-note">尚无部署登记。检测通过后，仍需实际部署，再登记结果。</p>
      <div class="project-card-footer">
        <span>{{ e.id }}</span><RouterLink to="/releases" class="button small-button"
          >创建环境发布</RouterLink
        >
      </div>
    </article>
  </div>
  <div v-if="editing" class="modal-backdrop" @click.self="editing = false">
    <section
      class="modal testing-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="env-title"
    >
      <h2 id="env-title">管理项目环境</h2>
      <p class="muted">环境 ID 保持稳定；停用环境请归档，历史证据与部署记录保留。</p>
      <form @submit.prevent="save">
        <article v-for="e in form.environments" class="environment-editor">
          <div class="form-grid">
            <label>环境名称<input v-model="e.name" required maxlength="64" /></label
            ><label
              >环境类型<select v-model="e.kind" @change="e.protected = e.kind === 'production'">
                <option v-for="(name, key) in kinds" :value="key">{{ name }}</option>
              </select></label
            >
          </div>
          <label>地址<input v-model="e.url" type="url" required /></label>
          <div class="environment-options">
            <label class="choice"><input v-model="e.protected" type="checkbox" />需要发布审批</label
            ><label class="choice"><input v-model="e.archived" type="checkbox" />归档环境</label>
          </div>
          <small class="mono muted">ID: {{ e.id }}</small>
        </article>
        <button
          type="button"
          class="button"
          :disabled="form.environments.length >= 8"
          @click="
            form.environments.push({
              id: 'env-' + Date.now(),
              name: '预览环境',
              url: '',
              kind: 'preview',
              protected: false,
              archived: false,
            })
          "
        >
          <Plus :size="16" />添加环境
        </button>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="editing = false">取消</button
          ><button class="button primary" :disabled="busy">保存环境</button>
        </div>
      </form>
    </section>
  </div>
</template>
