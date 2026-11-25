<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { artifactUrl } from '../state';
const props = defineProps<{ path?: string; alt: string }>();
const url = ref(''),
  error = ref('');
let generation = 0;
function release(value: string) {
  if (value.startsWith('blob:')) URL.revokeObjectURL(value);
}
watch(
  () => props.path,
  async (path) => {
    const current = ++generation;
    release(url.value);
    url.value = '';
    error.value = '';
    if (!path) return;
    try {
      const value = await artifactUrl(path);
      if (current === generation) url.value = value;
      else release(value);
    } catch {
      error.value = '证据暂时无法读取';
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  release(url.value);
});
</script>
<template>
  <img v-if="url" :src="url" :alt="alt" class="testing-evidence" />
  <p v-else-if="error" class="muted">{{ error }}</p>
</template>
