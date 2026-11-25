<script setup lang="ts">
import { computed } from 'vue';
import {
  Activity,
  Plus,
  ScanLine,
  FolderKanban,
  Bug,
  ShieldCheck,
  Clock,
  ChevronRight,
  Globe,
  Check,
  Search,
  FileCheck2,
  Sparkles,
  Monitor,
  TriangleAlert,
} from 'lucide-vue-next';
import { state, projects, scans, issues, projectName, date, statuses } from '../state';
const active = computed(() => scans.value.filter((s) => ['queued', 'running'].includes(s.status)));
const open = computed(() =>
  issues.value.filter((i) => !['resolved', 'ignored'].includes(i.status)),
);
const completed = computed(() => scans.value.filter((s) => s.status === 'completed'));
const passRate = computed(() =>
  completed.value.length
    ? Math.round(
        (completed.value.filter((s) => s.gate?.passed).length / completed.value.length) * 100,
      )
    : null,
);
const trend = computed(() =>
  scans.value
    .filter((s) => s.pages.some((p) => p.metrics?.performance != null))
    .slice(0, 12)
    .reverse()
    .map((s) => ({
      id: s.id,
      date: date(s.createdAt),
      score: Math.round(
        s.pages
          .filter((p) => p.metrics?.performance != null)
          .reduce((v, p) => v + p.metrics!.performance!, 0) /
          s.pages.filter((p) => p.metrics?.performance != null).length,
      ),
    })),
);
const chartPoints = computed(() =>
  trend.value
    .map((p, i) => `${24 + (i / Math.max(trend.value.length - 1, 1)) * 650},${170 - p.score * 1.4}`)
    .join(' '),
);
function scan() {
  if (!state.projects.length) state.showProject = true;
  else state.showScan = true;
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">YOUR WEB, UNDER OBSERVATION</div>
      <h1>每一次发布，都心中有数<span class="heading-dot">.</span></h1>
      <p>从上线前检测到修复后验证，在一个工作空间掌握 Web 质量。</p>
    </div>
    <button class="button primary" @click="scan"><Plus :size="18" />新建检测</button>
  </div>
  <div class="toolbar">
    <div class="view-label"><span class="live-dot"></span>工作空间概览</div>
    <select v-model="state.projectId" aria-label="筛选项目">
      <option value="">全部项目</option>
      <option v-for="p in state.projects" :value="p.id">{{ p.name }}</option>
    </select>
  </div>
  <section class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">接入项目<FolderKanban :size="18" /></div>
      <div class="stat-number">{{ projects.length }}<span>个</span></div>
      <div class="stat-foot">
        {{ projects.reduce((n, p) => n + p.environments.length, 0) }} 个已配置环境
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">质量检测<ScanLine :size="18" /></div>
      <div class="stat-number">{{ scans.length }}<span>次</span></div>
      <div class="stat-foot">
        <span v-if="active.length" class="text-green">{{ active.length }} 个任务正在执行</span
        ><span v-else>{{ completed.length }} 次完整检测</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">待处理问题<Bug :size="18" /></div>
      <div class="stat-number">{{ open.length }}<span>项</span></div>
      <div class="stat-foot">
        <span :class="{ 'text-orange': open.some((i) => ['P0', 'P1'].includes(i.severity)) }"
          >{{ open.filter((i) => ['P0', 'P1'].includes(i.severity)).length }} 个严重问题</span
        ><span class="stat-divider">/</span
        >{{ issues.filter((i) => i.status === 'pending_verification').length }} 个待验证
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">质量准入通过率<ShieldCheck :size="18" /></div>
      <div class="stat-number">{{ passRate ?? '—' }}<span v-if="passRate !== null">%</span></div>
      <div class="stat-foot">
        {{ completed.length ? '基于完整检测结果' : '完成检测后生成质量依据' }}
      </div>
    </div>
  </section>
  <section v-if="!state.projects.length" class="welcome-banner">
    <div class="welcome-copy">
      <span class="pill light"><Sparkles :size="14" />从第一次检测开始</span>
      <h2>让网站的问题，<br />在用户发现之前被发现。</h2>
      <p>
        添加网站地址，即可检查性能、运行异常、<br
          class="desktop-only"
        />页面适配与无障碍问题，获得可执行的修复建议。
      </p>
      <button class="button primary" @click="state.showProject = true">
        <Plus :size="17" />接入第一个项目</button
      ><span class="banner-note">本地运行 · 数据保存在你的工作空间</span>
    </div>
    <div class="radar-art" aria-hidden="true">
      <div class="radar-ring ring-1"></div>
      <div class="radar-ring ring-2"></div>
      <div class="radar-ring ring-3"></div>
      <div class="radar-axis x-axis"></div>
      <div class="radar-axis y-axis"></div>
      <div class="radar-sweep"></div>
      <div class="radar-center"><Activity :size="32" /></div>
      <div class="radar-tag tag-one"><ShieldCheck :size="17" />性能与稳定性</div>
      <div class="radar-tag tag-two"><Monitor :size="17" />页面与体验</div>
      <div class="radar-tag tag-three"><Check :size="16" />发现 · 诊断 · 验证</div>
    </div>
  </section>
  <div class="dashboard-columns">
    <section class="panel trend-panel">
      <div class="panel-heading">
        <div>
          <h3>质量趋势</h3>
          <p>最近检测的 Lighthouse 平均性能评分</p>
        </div>
        <span class="legend"><i></i>性能评分</span>
      </div>
      <div v-if="trend.length" class="trend-chart">
        <svg viewBox="0 0 700 200" role="img" aria-label="历史性能评分趋势">
          <defs>
            <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#218772" stop-opacity=".16" />
              <stop offset="100%" stop-color="#218772" stop-opacity="0" />
            </linearGradient>
          </defs>
          <g v-for="y in [30, 100, 170]" stroke="#e9eeec">
            <line x1="24" :y1="y" x2="674" :y2="y" />
          </g>
          <polygon
            v-if="trend.length > 1"
            :points="`24,170 ${chartPoints} 674,170`"
            fill="url(#fill)"
          />
          <polyline :points="chartPoints" fill="none" stroke="#218772" stroke-width="3" />
          <circle
            v-for="(p, i) in trend"
            :cx="24 + (i / Math.max(trend.length - 1, 1)) * 650"
            :cy="170 - p.score * 1.4"
            r="5"
            fill="#218772"
          >
            <title>{{ p.date }}：{{ p.score }}</title>
          </circle>
        </svg>
        <div class="chart-labels">
          <span>{{ trend[0]?.date }}</span><span>{{ trend[trend.length - 1]?.date }}</span>
        </div>
      </div>
      <div v-else class="chart-empty">
        <div class="faint-chart">
          <span
            v-for="n in 18"
            :style="{ height: 20 + Math.sin(n * 0.7) * 12 + n * 2 + 'px' }"
          ></span>
        </div>
        <strong>你的质量曲线，即将开始</strong><span>完成首次性能检测后，在这里追踪每一次进步</span>
      </div>
    </section>
    <section class="panel issue-summary">
      <div class="panel-heading">
        <div>
          <h3>问题分布</h3>
          <p>按严重等级查看待处理问题</p>
        </div>
        <Bug :size="18" class="muted" />
      </div>
      <div class="severity-list">
        <div v-for="(s, index) in ['P0', 'P1', 'P2', 'P3']" class="severity-row">
          <span class="severity-dot" :class="'s' + index"></span
          ><span>{{ ['阻断', '严重', '一般', '建议'][index] }}</span
          ><small>{{ s }}</small>
          <div class="severity-track">
            <i
              :class="'s' + index"
              :style="{
                width:
                  (open.length
                    ? (open.filter((i) => i.severity === s).length / open.length) * 100
                    : 0) + '%',
              }"
            ></i>
          </div>
          <strong>{{ open.filter((i) => i.severity === s).length }}</strong>
        </div>
      </div>
      <RouterLink to="/issues" class="panel-bottom-link"
        >前往问题中心<ChevronRight :size="16"
      /></RouterLink>
    </section>
  </div>
  <section class="panel recent-panel">
    <div class="panel-heading">
      <div>
        <h3>
          最近检测<span class="count">{{ scans.length }}</span>
        </h3>
        <p>从真实检测中获得下一步行动</p>
      </div>
      <RouterLink to="/scans" class="text-button">查看全部<ChevronRight :size="15" /></RouterLink>
    </div>
    <div v-if="!scans.length" class="empty-inline">
      <span class="empty-icon"><ScanLine :size="26" /></span>
      <div>
        <strong>还没有检测记录</strong>
        <p>新建检测任务，获取你的第一份网站质量报告。</p>
      </div>
      <button class="button" @click="scan">开始第一次检测</button>
    </div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>检测项目</th>
            <th>版本 / 配置</th>
            <th>状态</th>
            <th>发现问题</th>
            <th>检测时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in scans.slice(0, 5)" :key="s.id">
            <td>
              <RouterLink :to="'/scans/' + s.id" class="table-project"
                ><span class="project-favicon"><Globe :size="17" /></span
                >{{ projectName(s.projectId) }}</RouterLink
              >
            </td>
            <td>
              <span class="mono">{{ s.release || '未关联版本' }}</span><small class="cell-sub">{{
                s.devices.join(' / ')
              }}</small>
            </td>
            <td>
              <span class="status" :class="s.status">{{ statuses[s.status] }}</span>
            </td>
            <td>{{ s.findings.length }} <span class="muted">项</span></td>
            <td class="muted">{{ date(s.createdAt) }}</td>
            <td>
              <RouterLink :to="'/scans/' + s.id" class="icon-button" aria-label="查看报告"
                ><ChevronRight :size="18"
              /></RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <div class="workflow-strip">
    <div>
      <Search :size="19" /><span><strong>发现</strong>真实浏览器检测</span>
    </div>
    <span class="flow-line"></span>
    <div>
      <Sparkles :size="19" /><span><strong>诊断</strong>从证据到建议</span>
    </div>
    <span class="flow-line"></span>
    <div>
      <FileCheck2 :size="19" /><span><strong>修复</strong>导出 Agent 任务</span>
    </div>
    <span class="flow-line"></span>
    <div>
      <ShieldCheck :size="19" /><span><strong>验证</strong>让改善可以衡量</span>
    </div>
  </div>
</template>
