# WebProbe 工作流入口

已经按现有 Vue + Hono + npm 项目接入，无需再次 init，也不依赖本机模板仓库路径。

```sh
npm run workflow:doctor
npm run verify
npm run verify:high
```

完整说明见 `docs/workflow.md`。事实入口：AGENTS.md、docs/product.md、docs/architecture.md；验收入口：docs/quality-gates.md；任务与交付模板位于 tasks/。

默认 medium 包含格式、严格类型、全部核心测试、构建和真实三浏览器 E2E。扫描引擎、网络防护、权限或数据一致性变更使用 high；CI 固定 high。当前无 ESLint，不把 Prettier 格式检查当作语义 Lint。

首次准备环境使用 `npm ci` 与 `npm run browsers`；测试不加载用户 .env，使用临时数据库和受控页面。既有架构和 API 文档保留，未修改运行时业务代码或用户数据。

证据位于 `.ai-workflow/reports/<runId>/`，截图在 test-results/，均忽略提交。自动化报告不判定人工验收，不自动脱敏。远端 CI、分支保护与审批需在代码托管后配置。
