<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  Activity,
  FlaskConical,
  GitBranch,
  Layers,
  LayoutDashboard,
  FolderKanban,
  ScanLine,
  Bug,
  Files,
  Settings,
  Plus,
  ChevronDown,
  PanelLeftClose,
  ShieldCheck,
  Command,
  Menu,
  ExternalLink,
  X,
} from 'lucide-vue-next';
import { state, refresh, issues } from './state';
import ProjectModal from './components/ProjectModal.vue';
import ScanModal from './components/ScanModal.vue';
const route = useRoute();
const mobileNav = ref(false);
let poll: ReturnType<typeof setInterval>;
const nav = [
  { path: '/', label: '质量概览', icon: LayoutDashboard },
  { path: '/projects', label: '项目管理', icon: FolderKanban },
  { path: '/scans', label: '检测任务', icon: ScanLine },
  { path: '/testing', label: 'AI 测试中心', icon: FlaskConical },
  { path: '/releases', label: '发布中心', icon: GitBranch },
  { path: '/environments', label: '环境与部署', icon: Layers },
  { path: '/issues', label: '问题中心', icon: Bug },
  { path: '/reports', label: '报告与回归', icon: Files },
];
onMounted(() => {
  void refresh();
  poll = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 4000);
});
onUnmounted(() => clearInterval(poll));
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ visible: mobileNav }">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark"><Activity :size="23" /></span>WebProbe<span class="version"
          >3.0</span
        ></RouterLink
      >
      <div class="workspace">
        <div class="workspace-icon">W</div>
        <div><strong>我的工作空间</strong><small>Web Quality Workspace</small></div>
        <ChevronDown :size="15" />
      </div>
      <div class="nav-label">工作空间</div>
      <nav>
        <RouterLink
          v-for="item in nav"
          :key="item.path"
          :to="item.path"
          :class="{
            active:
              route.path === item.path ||
              (item.path === '/scans' && route.path.startsWith('/scans/')) ||
              (item.path === '/testing' && route.path.startsWith('/testing/')) ||
              (item.path === '/releases' && route.path.startsWith('/releases/')),
          }"
          @click="mobileNav = false"
          ><component :is="item.icon" :size="19" /><span>{{ item.label }}</span
          ><span
            v-if="item.path === '/issues' && issues.filter((i) => i.status === 'open').length"
            class="nav-count"
            >{{ issues.filter((i) => i.status === 'open').length }}</span
          ></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="local-card">
          <ShieldCheck :size="19" /><strong>质量，让交付更有把握</strong>
          <p>从发现问题到验证修复<br />每一步都有据可循。</p>
          <span>LOCAL WORKSPACE</span>
        </div>
        <RouterLink to="/settings" class="settings-link"
          ><Settings :size="19" />工作空间设置</RouterLink
        >
        <div class="profile">
          <div class="avatar">W</div>
          <div><strong>本地工作空间</strong><small>WebProbe Community</small></div>
          <span class="online-dot" :class="{ offline: !state.connected }"></span>
        </div>
      </div>
    </aside>
    <div v-if="mobileNav" class="nav-backdrop" @click="mobileNav = false"></div>
    <div class="main-shell">
      <header class="topbar">
        <button
          class="icon-button mobile-menu"
          aria-label="展开导航"
          @click="mobileNav = !mobileNav"
        >
          <Menu :size="20" /></button
        ><span class="breadcrumb"
          >{{ route.meta.section }}<span>/</span><strong>{{ route.meta.title }}</strong></span
        >
        <div class="topbar-right">
          <span class="connection"
            ><i :class="{ offline: !state.connected }"></i
            >{{ state.connected ? '检测引擎已连接' : '连接中' }}</span
          ><a
            href="https://github.com/GoogleChrome/lighthouse"
            target="_blank"
            rel="noreferrer"
            class="docs-link"
            >Lighthouse 文档<ExternalLink :size="13" /></a
          ><span class="avatar small">W</span>
        </div>
      </header>
      <main>
        <div v-if="state.error" class="alert error">
          {{ state.error }}<button @click="refresh">重试</button
          ><RouterLink to="/settings">连接设置</RouterLink>
        </div>
        <RouterView />
      </main>
      <footer>
        <span><Activity :size="13" />WebProbe · 为每一次发布提供质量依据</span
        ><span>V3.0 · Release Quality Platform</span>
      </footer>
    </div>
    <ProjectModal v-if="state.showProject" @close="state.showProject = false" />
    <ScanModal v-if="state.showScan" @close="state.showScan = false" />
    <Transition name="toast"
      ><div v-if="state.notice" class="toast">
        <ShieldCheck :size="18" />{{ state.notice }}
      </div></Transition
    >
  </div>
</template>
