<script setup lang="ts">
import { ref } from 'vue';
import { KeyRound, Server, ShieldCheck, Brain, Save } from 'lucide-vue-next';
import { state, refresh, notify } from '../state';
const token = ref(sessionStorage.getItem('webprobe-token') || '');
function save() {
  sessionStorage.setItem('webprobe-token', token.value);
  void refresh();
  notify('连接配置已保存到当前浏览器会话');
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">WORKSPACE SETTINGS</div>
      <h1>工作空间设置</h1>
      <p>检查检测引擎连接，配置你的私有工作环境。</p>
    </div>
  </div>
  <div class="settings-grid">
    <section class="panel settings-panel">
      <h3><Server :size="20" />检测引擎</h3>
      <dl>
        <dt>服务状态</dt>
        <dd>
          <span class="pill" :class="state.connected ? 'green' : 'orange'">{{
            state.connected ? '已连接' : '未连接'
          }}</span>
        </dd>
        <dt>版本</dt>
        <dd>{{ state.health?.version || '—' }}</dd>
        <dt>内网检测</dt>
        <dd>{{ state.health?.privateNetworkAllowed ? '已启用' : '未启用' }}</dd>
        <dt>数据存储</dt>
        <dd>本地 SQLite + 文件证据</dd>
      </dl>
      <p class="info-note">本地项目检测需在服务端 .env 设置 ALLOW_PRIVATE_NETWORK=true 后重启。</p>
    </section>
    <section class="panel settings-panel">
      <h3><Brain :size="20" />AI 诊断</h3>
      <dl>
        <dt>模型连接</dt>
        <dd>{{ state.health?.aiConfigured ? '已配置' : '尚未配置' }}</dd>
        <dt>模型</dt>
        <dd>{{ state.health?.aiConfigured ? state.health.aiModel : '规则建议模式' }}</dd>
      </dl>
      <p>在 .env 配置 AI_BASE_URL、AI_MODEL、AI_API_KEY 并重启服务，问题详情中即可使用 AI 诊断。</p>
      <p class="info-note">
        AI 诊断会把选中问题的 URL 和检测证据发送至你配置的模型服务。未配置时提供明确标识的规则建议。
      </p>
    </section>
    <section class="panel settings-panel">
      <h3><KeyRound :size="20" />API 访问凭证</h3>
      <p>仅当服务端配置了 WEBPROBE_API_TOKEN 时填写。</p>
      <form @submit.prevent="save">
        <label
          >访问 Token<input
            v-model="token"
            type="password"
            autocomplete="off"
            placeholder="输入服务端 API Token" /></label
        ><button class="button primary"><Save :size="16" />保存连接</button>
      </form>
      <small class="muted">凭证仅保存在当前浏览器会话中。</small>
    </section>
    <section class="panel settings-panel">
      <h3><ShieldCheck :size="20" />V2.0 能力边界</h3>
      <p>支持页面加载期间的运行异常、网络故障、基础布局、axe 无障碍与 Lighthouse 性能审计。</p>
      <p>
        移动端为浏览器视口模拟。质量扫描不主动操作业务；测试用例在明确启用交互后执行受限步骤。密码与支付等敏感操作仍被阻止。
      </p>
      <p>
        此版本面向本地与可信单团队部署，新增显式断言、页面探索、操作录制与视觉回归。持续监控、RUM、源码自动修复与完整权限体系属于后续版本。
      </p>
    </section>
  </div>
</template>
