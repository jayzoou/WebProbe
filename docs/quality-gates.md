# WebProbe · 质量门禁

命令事实源为 `.ai-workflow/config.json`。使用 `npm run workflow:doctor` 检查接入配置，使用 verify 实际执行检查和生成报告。doctor 的 ready 不表示检查通过。

| 风险   | 场景                                       | 必需检查                                            |
| ------ | ------------------------------------------ | --------------------------------------------------- |
| low    | 文案、样式、非关键展示                     | format、前后端 typecheck、build，并进行相关视觉检查 |
| medium | 组件、API、状态与一般逻辑                  | low + 完整核心测试 + 三浏览器 E2E                   |
| high   | 扫描引擎、网络出口、权限、证据和数据一致性 | medium + 独立 security gate，按变更进行人工安全审查 |

默认 `npm run verify` 为 medium，`npm run verify:high` 为 high，CI 固定 high。不得因缺少浏览器、脚本失败或配置不全降低风险绕过。

## 实际检查

- format：`npm run format:check`，只验证 Prettier 格式。当前未安装 ESLint，不提供独立语义 Lint；语义静态检查依靠前后端 strict TypeScript，仍需代码审查。
- typecheck：`npm run typecheck`，运行 vue-tsc 与服务端/测试 tsc。
- core：`npm test`，运行所有 `tests/*.test.ts`，包括安全测试；high 还会单独执行安全文件，便于明确保留安全门禁结果。
- build：`npm run build`，保持原有类型检查与 Vite 生产构建，不用开发服务器代替。
- security：`npm run test:security`，单独运行 SSRF、内网 HTTP/CONNECT、云元数据、API Host/Origin/Token 和出口代理写操作边界测试。
- e2e：`npm run test:e2e`，使用真实 Chromium/Firefox/WebKit、Lighthouse 和独立临时数据，运行 V1 扫描与 V2 测试平台两套 E2E，验证检测、功能复现、录制、视觉差异、回归、导出和界面。先 build，再执行 E2E；门禁超时 15 分钟。

E2E 本地需要浏览器与空闲 4179、4189 端口，截图在 test-results。CI 安装浏览器及系统依赖，并固定三引擎；仅在受控测试页启用内网开关。安全测试默认禁止私网，只测试明确需要的隔离例外。

## 结果与完成标准

必需门禁缺失、失败、无法启动、超时或取消，统一非零退出；当前风险不要求的门禁才可 skipped。失败后仍收集其他门禁的结果。报告位于 `.ai-workflow/reports/<runId>/`，提供命令、退出码、耗时和日志。

交付必须能将任务验收条件对应到实际测试或人工证据。生成代码、手工设置 pending_verification、自动化通过和人工验收是不同事实。报告没有自动脱敏或防篡改能力；分享前检查输出。

安全测试通过不证明完整 SSRF 防护、生产隔离或依赖没有漏洞。依赖审计单独按发布策略运行 `npm audit`，不以既往审计结果代表当前状态。公网部署仍需独立网络与任务隔离。

CI 文件只有提交到远端并执行才产生远端结果；分支保护、required checks、评审和审批需要在托管平台配置。当前本地目录不包含 Git 元数据，不自动创建远端、推送或部署。
