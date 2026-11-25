<script setup lang="ts">
import { ref } from 'vue';
import { Plus, Globe, ScanLine, Settings2, FolderKanban } from 'lucide-vue-next';
import { state, scans, date } from '../state';
import ProjectModal from '../components/ProjectModal.vue';
import type { Project } from '../../../../packages/shared/src/index';
const editing = ref<Project>();
function start(id: string) {
  state.projectId = id;
  state.showScan = true;
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">PROJECTS & ENVIRONMENTS</div>
      <h1>项目管理</h1>
      <p>为网站建立长期的质量档案，连接开发、预发布与生产环境。</p>
    </div>
    <button class="button primary" @click="state.showProject = true">
      <Plus :size="18" />添加项目
    </button>
  </div>
  <div v-if="!state.projects.length" class="panel full-empty">
    <span class="empty-icon"><FolderKanban :size="32" /></span>
    <h2>你的第一个项目，从这里开始</h2>
    <p>添加一个网站地址，保存检测环境与质量标准。</p>
    <button class="button primary" @click="state.showProject = true">
      <Plus :size="17" />创建项目
    </button>
  </div>
  <div class="project-grid">
    <article class="panel project-card" v-for="p in state.projects" :key="p.id">
      <div class="project-card-top">
        <span class="project-logo">{{ p.name.slice(0, 1).toUpperCase() }}</span><button
          class="icon-button"
          aria-label="编辑项目"
          @click="editing = p"
        >
          <Settings2 :size="19" />
        </button>
      </div>
      <h2>{{ p.name }}</h2>
      <p>{{ p.description || '为每一次发布建立质量依据' }}</p>
      <div class="project-environments">
        <div v-for="e in p.environments">
          <span class="pill">{{ e.name }}</span><span class="truncate mono">{{ e.url }}</span>
        </div>
      </div>
      <div class="project-budget">
        <span>性能 ≥ {{ p.gate.minPerformance }}</span
        ><span>LCP ≤ {{ p.gate.maxLcp / 1000 }}s</span><span>CLS ≤ {{ p.gate.maxCls }}</span>
      </div>
      <div class="project-card-footer">
        <span>{{ state.scans.filter((s) => s.projectId === p.id).length }} 次检测</span
        ><button class="button" @click="start(p.id)"><ScanLine :size="16" />开始检测</button>
      </div>
    </article>
  </div>
  <ProjectModal v-if="editing" :project="editing" @close="editing = undefined" />
</template>
