# WebProbe 的 AI 协作工作流

已从通用 ai-frontend-workflow 模板接入，并按现有 WebProbe 技术栈调整：保留 Vue + Hono、现有核心/E2E 测试和 npm；不引入新的运行时或开发依赖。

## 日常命令

```sh
npm run workflow:doctor
npm run verify
npm run verify:high
```

doctor 只检查文件和配置；verify 执行 medium；verify:high 增加独立安全门禁。low 可显式使用 `node .ai-workflow/verify.mjs --risk low`，适用于文案和非关键样式。CI 固定 high。

初次运行先执行 `npm ci` 和 `npm run browsers`。E2E 使用空闲的 4179 端口和临时数据，先构建生产前端再运行。无需启动开发服务器，不读取用户 .env，不调用真实模型服务。

## 一个任务如何推进

1. 阅读 AGENTS.md、产品和相关架构/API 事实。
2. 复杂任务复制 `tasks/TASK_TEMPLATE.md`，写明用户目标、范围、风险和可观察验收条件；简单任务按风险简化记录。
3. Agent 使用 `.agents/skills/implement-feature` 实现；排查和评审分别使用相应 Skills。优先复用已有模块，保留安全防护和数据语义。
4. 执行相应风险的 verify。修复实际失败原因，不通过取消测试、改为空命令或降低风险制造通过。
5. 页面变更检查实际交互与移动端；关键安全和架构变更按项目要求人工审查。
6. 使用 `tasks/COMPLETION_TEMPLATE.md` 记录变更、实际命令、runId、证据、限制与未执行项。

自动化检查不代替用户验收，也不能证明覆盖所有网站、安全风险或性能场景。任务中没有源码证据时不要编造文件定位。

## 接入文件

| 文件                                             | 用途                                    |
| ------------------------------------------------ | --------------------------------------- |
| AGENTS.md                                        | 保留既有约束并链接工作流                |
| docs/product.md、architecture.md、conventions.md | 真实产品、模块与开发事实                |
| docs/quality-gates.md、testing-strategy.md       | 风险、检查与证据要求                    |
| .agents/skills/                                  | 实现、代码审查、问题排查                |
| tasks/                                           | 需求规格与交付记录模板                  |
| .ai-workflow/config.json                         | 本项目的门禁命令与超时                  |
| .ai-workflow/*.mjs                               | 独立 runner，不依赖模板仓库位置         |
| .github/workflows/ai-workflow.yml                | 安装三浏览器、执行 high、保留日志和截图 |

## 证据与远端状态

每次运行保存 `.ai-workflow/reports/<runId>/report.md`、JSON 和各门禁日志；latest 是便捷副本。用户 data、.env、截图和报告不提交。CI 仅上传测试日志和截图，不上传用户数据库或凭证。

该本地项目当前没有 Git 元数据。接入不会自动初始化仓库、创建远端、推送或启用分支保护；将代码纳入自己的代码托管后，需要配置 required checks 和必要评审。远端 CI 的真实结果以托管平台执行为准。
