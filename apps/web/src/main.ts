import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Dashboard from './views/Dashboard.vue';
import Projects from './views/Projects.vue';
import Scans from './views/Scans.vue';
import Issues from './views/Issues.vue';
import ScanDetail from './views/ScanDetail.vue';
import Settings from './views/Settings.vue';
import Testing from './views/Testing.vue';
import TestRunDetail from './views/TestRunDetail.vue';
import Releases from './views/Releases.vue';
import ReleaseDetail from './views/ReleaseDetail.vue';
import Environments from './views/Environments.vue';
import './style.css';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Dashboard, meta: { title: '质量概览', section: '工作空间' } },
    { path: '/projects', component: Projects, meta: { title: '项目管理', section: '工作空间' } },
    { path: '/scans', component: Scans, meta: { title: '检测任务', section: '质量工作台' } },
    {
      path: '/scans/:id',
      component: ScanDetail,
      meta: { title: '检测报告', section: '质量工作台' },
    },
    { path: '/issues', component: Issues, meta: { title: '问题中心', section: '质量工作台' } },
    { path: '/reports', component: Scans, meta: { title: '报告与回归', section: '质量工作台' } },
    { path: '/testing', component: Testing, meta: { title: 'AI 测试中心', section: '测试平台' } },
    {
      path: '/testing/runs/:id',
      component: TestRunDetail,
      meta: { title: '测试执行详情', section: '测试平台' },
    },
    { path: '/releases', component: Releases, meta: { title: '发布中心', section: '发布质量' } },
    {
      path: '/releases/:id',
      component: ReleaseDetail,
      meta: { title: '发布质量详情', section: '发布质量' },
    },
    {
      path: '/environments',
      component: Environments,
      meta: { title: '环境与部署', section: '发布质量' },
    },
    { path: '/settings', component: Settings, meta: { title: '工作空间设置', section: '设置' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
createApp(App).use(router).mount('#app');
