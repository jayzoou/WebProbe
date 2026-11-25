<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { X, ScanLine, Monitor, Smartphone, Info } from 'lucide-vue-next';
import { state, api, refresh } from '../state';
const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const projectId = ref(state.projectId || state.projects[0]?.id || '');
const environmentId = ref('');
const project = computed(() => state.projects.find((p) => p.id === projectId.value));
watch(
  project,
  () => {
    environmentId.value = project.value?.environments[0]?.id || '';
  },
  { immediate: true },
);
const release = ref(''),
  browsers = ref(['chromium']),
  devices = ref(['desktop']),
  maxPages = ref(1),
  lighthouse = ref(true),
  paths = ref(''),
  busy = ref(false),
  error = ref('');
async function start() {
  busy.value = true;
  error.value = '';
  try {
    const scan = await api('/scans', {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId.value,
        environmentId: environmentId.value,
        release: release.value,
        browsers: browsers.value,
        devices: devices.value,
        maxPages: maxPages.value,
        lighthouse: lighthouse.value,
        paths: paths.value
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean),
      }),
    });
    await refresh();
    emit('close');
    router.push(`/scans/${scan.id}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <div class="modal-heading">
        <span class="square-icon"><ScanLine :size="24" /></span
        ><button class="icon-button" aria-label="关闭" @click="emit('close')">
          <X :size="21" />
        </button>
      </div>
      <h2 id="scan-title">发起质量检测</h2>
      <p class="muted">用真实浏览器，了解网站此刻的质量。</p>
      <form @submit.prevent="start">
        <div class="form-grid">
          <label
            >检测项目<select v-model="projectId" required>
              <option disabled value="">选择项目</option>
              <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option>
            </select></label
          ><label
            >目标环境<select v-model="environmentId" required>
              <option v-for="e in project?.environments" :value="e.id">{{ e.name }}</option>
            </select></label
          >
        </div>
        <div v-if="project" class="url-preview">
          {{ project.environments.find((e) => e.id === environmentId)?.url }}
        </div>
        <label
          >发布版本 / Commit <span class="muted">可选</span
          ><input v-model="release" placeholder="例如：v1.0.0 或 a3f80c2" maxlength="100" /></label
        ><label>浏览器</label>
        <div class="choice-row">
          <label v-for="b in ['chromium', 'firefox', 'webkit']" class="choice"
            ><input type="checkbox" v-model="browsers" :value="b" />{{
              b === 'chromium' ? 'Chromium' : b === 'firefox' ? 'Firefox' : 'WebKit'
            }}</label
          >
        </div>
        <label>检测设备</label>
        <div class="choice-row">
          <label class="choice"
            ><input type="checkbox" v-model="devices" value="desktop" /><Monitor
              :size="17"
            />桌面端</label
          ><label class="choice"
            ><input type="checkbox" v-model="devices" value="mobile" /><Smartphone
              :size="17"
            />移动端</label
          >
        </div>
        <div class="form-grid">
          <label
            >最多检测页面<select v-model="maxPages">
              <option :value="1">1 个页面 · 单页检测</option>
              <option :value="3">3 个页面 · 站内发现</option>
              <option :value="5">5 个页面 · 站内发现</option>
              <option :value="10">10 个页面 · 站内发现</option>
            </select></label
          ><label class="choice lighthouse-choice"
            ><input type="checkbox" v-model="lighthouse" />Lighthouse 性能审计</label
          >
        </div>
        <details>
          <summary>指定站内路径</summary>
          <label
            >每行一个路径<textarea
              v-model="paths"
              placeholder="/about&#10;/articles"
              rows="3"
            ></textarea>
          </label>
        </details>
        <div class="info-note">
          <Info :size="17" /><span
            >检测只访问页面，不提交表单。移动端为视口模拟；Lighthouse 仅支持
            Chromium。请仅检测你有权访问的网站。</span
          >
        </div>
        <p v-if="error" class="alert error">{{ error }}</p>
        <div class="modal-actions">
          <button type="button" class="button" @click="emit('close')">取消</button
          ><button
            class="button primary"
            :disabled="busy || !browsers.length || !devices.length || !projectId"
          >
            <ScanLine :size="17" />{{ busy ? '创建中…' : '开始检测' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
