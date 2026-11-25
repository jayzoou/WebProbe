<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Plus, ScanLine, Search, ChevronRight, Files, Globe, Download } from 'lucide-vue-next';
import { state, scans, projectName, date, statuses } from '../state';
const route = useRoute();
const filter = ref('all'),
  search = ref('');
const filtered = computed(() =>
  scans.value.filter(
    (s) =>
      (filter.value === 'all' || s.status === filter.value) &&
      [projectName(s.projectId), s.release, s.id]
        .join(' ')
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">
        {{ route.path === '/reports' ? 'REPORTS & REGRESSION' : 'QUALITY SCANS' }}
      </div>
      <h1>{{ route.path === '/reports' ? '报告与回归' : '检测任务' }}</h1>
      <p>
        {{
          route.path === '/reports'
            ? '保留每一次检测的证据，比较修复前后的真实变化。'
            : '用可重复的浏览器检测，替每一次发布把关。'
        }}
      </p>
    </div>
    <button
      class="button primary"
      @click="state.projects.length ? (state.showScan = true) : (state.showProject = true)"
    >
      <Plus :size="18" />新建检测
    </button>
  </div>
  <div class="toolbar">
    <div class="search-input">
      <Search :size="17" /><input
        v-model="search"
        placeholder="搜索项目、版本或检测 ID"
        aria-label="搜索检测"
      />
    </div>
    <div class="filters">
      <select v-model="state.projectId" aria-label="项目">
        <option value="">全部项目</option>
        <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option></select
      ><select v-model="filter" aria-label="检测状态">
        <option value="all">全部状态</option>
        <option
          v-for="s in ['running', 'completed', 'partial', 'failed', 'cancelled', 'queued']"
          :value="s"
        >
          {{ statuses[s] }}
        </option>
      </select>
    </div>
  </div>
  <section class="panel">
    <div v-if="!filtered.length" class="full-empty">
      <span class="empty-icon"><Files :size="32" /></span>
      <h2>{{ scans.length ? '没有匹配的检测' : '每一次检测，都值得记录' }}</h2>
      <p>
        {{
          scans.length ? '试试调整搜索条件。' : '性能指标、截图、问题证据与回归结果会保存在这里。'
        }}
      </p>
      <button
        v-if="!scans.length"
        class="button primary"
        @click="state.projects.length ? (state.showScan = true) : (state.showProject = true)"
      >
        新建检测
      </button>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>项目 / 版本</th>
            <th>检测配置</th>
            <th>状态</th>
            <th>问题</th>
            <th>质量准入</th>
            <th>创建时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in filtered" :key="s.id">
            <td>
              <RouterLink :to="'/scans/' + s.id" class="table-project">{{
                projectName(s.projectId)
              }}</RouterLink><small class="cell-sub mono">{{
                s.release || s.id.slice(0, 8)
              }}</small>
            </td>
            <td>
              {{ s.browsers.join(', ')
              }}<small class="cell-sub">{{ s.devices.join(' / ') }} · {{ s.maxPages }} 页</small>
            </td>
            <td>
              <span class="status" :class="s.status">{{ statuses[s.status] }}</span><small
                v-if="s.status === 'running'"
                class="cell-sub"
                >{{ s.progress }}%</small
              >
            </td>
            <td>{{ s.findings.length }}</td>
            <td>
              <span v-if="s.gate" class="pill" :class="s.gate.passed ? 'green' : 'orange'">{{
                s.gate.passed ? '通过' : '未通过'
              }}</span><span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ date(s.createdAt) }}</td>
            <td>
              <RouterLink :to="'/scans/' + s.id" class="button small-button"
                >报告<ChevronRight :size="14"
              /></RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
