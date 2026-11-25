# WebProbe 2.0 · AI Testing Platform

**AI 驱动的 Web 全生命周期质量治理平台 · Web Quality Scanner**

围绕「发现问题 → 保留证据 → 协作修复 → 回归验证」构建的本地优先 Web 质量工作台。Vue 3 + TypeScript 前端、Hono API、Playwright 浏览器检测、Lighthouse 性能审计、axe 无障碍检测、SQLite 持久化。

## V2.0 新增

进入 **AI 测试中心**，创建、执行和复现业务测试：

- 根据真实 DOM 和自然语言生成可编辑用例，区分 AI 与无模型规则解析。
- 页面探索发现按钮/链接触发的异常，自动保存复现路径并再次重放确认。
- 独立本地浏览器操作录制，保存可重放步骤并审查业务断言。
- 用例版本、标签、复制、归档、JSON 导入导出及 Playwright 脚本导出；三浏览器/设备矩阵执行。
- 人工批准视觉基线，真实 PNG 像素差异、动态遮罩、尺寸变化及基线审批历史。
- 步骤证据、失败截图、Trace、功能问题聚合及修复回归、ZIP 复现包。

完整使用说明与边界见 [V2 测试平台](docs/v2-testing.md)。启动后打开 `/testing`。

## 快速运行

需要 **Node.js 22.19+**。在仓库根目录执行：

```bash
npm ci
npm run browsers
cp .env.example .env
npm run dev
```

访问 http://127.0.0.1:5173 。API 位于 http://127.0.0.1:4174 。

生产模式（同一进程提供前端与 API）：

```bash
npm run build
npm start
```

访问 http://127.0.0.1:4174 。所有命令都应从仓库根目录执行。`.env` 只在启动时读取，修改后需要重启。

## V1.0 已实现

| 能力           | 说明                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| 项目与环境     | 创建、编辑项目，保存多个环境 URL 和质量标准                                        |
| 真实浏览器扫描 | Chromium / Firefox / WebKit，桌面与移动视口，1–10 页、站内链接发现、指定路径       |
| 异常采集       | 未捕获 JS 异常、控制台错误、HTTP 4xx/5xx、请求失败、页面加载失败                   |
| 页面质量       | 横向溢出、缺少 viewport、损坏图片、标题与基础 SEO、axe WCAG 检查                   |
| 性能审计       | 真实 Lighthouse 报告，性能/无障碍/最佳实践/SEO 评分，以及 LCP、FCP、CLS、TBT、TTFB |
| 任务管理       | 串行浏览器队列、SSE 进度、超时、取消、服务重启后中断状态恢复                       |
| 问题中心       | 按项目/环境/页面/浏览器/设备/规则聚合，分类筛选、直接证据与疑似问题区分            |
| 诊断建议       | 可选兼容 Chat Completions 协议的模型；未配置时明确提供规则建议                     |
| 修复协作       | Markdown 提示词、JSON 报告、含截图与原始 Lighthouse 报告的 ZIP 任务包              |
| 回归验证       | 相同配置历史基线比较，问题新增/持续/消失与性能差值；对应检查成功后自动更新修复状态 |
| 质量准入       | 项目级性能评分、LCP、CLS、P0/P1 数量标准；缺失检测依据不会判为通过                 |
| CLI            | 复用平台 API 发起本地或远端 URL 检测，保存 JSON 报告，以退出码支持 CI              |

本版面向单用户本地和可信单团队部署。无账号/租户系统、定时监控、RUM SDK、MCP Server 或源码自动修改。V2 的功能测试与视觉回归见上文。这些属于后续版本，不以静态入口冒充已实现功能。

## 第一次使用

1. 创建项目，添加生产或预发布环境 URL。
2. 新建检测，选择浏览器、设备、页数及可选发布版本。
3. 在检测报告中检查质量准入、截图、指标、问题清单及执行日志。
4. 在问题中心核实证据，标记为处理中或待验证。
5. 导出修复提示词或 ZIP 任务包，交给 Coding Agent 配合实际源码修复。
6. 点击「重新检测」，查看相同配置的回归对比与问题状态。

平台不能仅通过 URL 确定源码文件行号，不会编造源码定位。

## 检测本地项目

默认阻止内网目标，包括页面跳转和第三方资源指向的内网地址。如需检测本机开发环境，在 `.env` 中设置：

```dotenv
ALLOW_PRIVATE_NETWORK=true
```

重启后可添加 `http://127.0.0.1:5173` 等地址。此开关扩大浏览器可访问的网络范围，只应在可信本地环境启用。

仓库提供一个有意包含已知缺陷的验证站点：

```bash
npm run demo
```

添加 `http://127.0.0.1:4180/`，可验证 JS 异常、404 图片、横向溢出及按钮缺少无障碍名称等检查。示例数据不会自动灌入你的工作空间。

## AI 配置

```dotenv
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_API_KEY=your-key
```

可使用提供兼容接口的模型服务，`AI_BASE_URL` 为包含 `/v1` 的 API 根路径。密钥只在服务器读取。用户点击诊断后，该问题的 URL、错误证据及设备信息会发送给配置的服务；不会发送整个代码库。请求有 60 秒超时，输出经过 Zod 校验。模型不可用或输出不合法时明确报错，不会伪造成功结果。

## CLI 与 CI

先启动平台，再运行：

```bash
npm run scan -- https://example.com --mobile --pages=3 --output=report.json
npm run scan -- http://127.0.0.1:4180 --no-lighthouse
```

`WEBPROBE_URL` 可指定平台地址，默认 `http://127.0.0.1:4174`；访问受保护的实例时设置 `WEBPROBE_API_TOKEN`。CLI 会复用相同 URL 的已存在项目。退出码为 0 表示完整检测且质量准入通过，其他结果返回 1；禁用 Lighthouse 时缺少性能质量依据，准入不会通过。

## 部署与数据

默认仅监听 `127.0.0.1`。若需要绑定 `0.0.0.0`，必须配置 `WEBPROBE_API_TOKEN`，然后在界面设置页输入相同 Token。正式共享部署建议通过 SSH 隧道使用；外部域名、HTTPS 反向代理、企业身份认证需要后续部署适配，当前 Origin 允许列表面向本地访问。

数据默认保存为 `data/webprobe.sqlite`，截图及 Lighthouse HTML/JSON 保存在 `data/artifacts/<scan-id>/`。`DATA_DIR` 可指定绝对路径。备份时停止服务后复制整个数据目录（包括 SQLite WAL/SHM 文件），恢复时保留原有目录结构。当前不自动清理历史记录，应按实际磁盘容量定期归档。

浏览器进程需要足够内存，完整扫描串行执行；单任务最多 10 页、3 个浏览器、2 个设备，任务上限 15 分钟，队列上限 10 个。Lighthouse 单次最多 120 秒。

## 验证

项目已接入 AI 协作工作流，保留既有项目约束，并加入任务模板、Skills、统一门禁、证据报告与 CI。完整使用方式见 [工作流说明](docs/workflow.md)。

```bash
npm run workflow:doctor   # 配置检查，不运行测试
npm run verify            # 默认 medium，含真实三浏览器 E2E
npm run verify:high       # 高风险检查，含独立安全门禁；CI 固定此级别
```

报告位于 `.ai-workflow/reports/<runId>/`，自动化通过与人工验收分别记录。当前静态检查为 Prettier 格式与 strict TypeScript，未配置独立 ESLint。

按需单独运行已有检查：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit
```

端到端测试需要已安装三种浏览器，启动独立的 4179 端口服务和动态端口测试页面。测试数据保存在临时目录，不污染用户工作空间。验证三引擎、页面发现、真实 Lighthouse、缺陷发现、修复回归、证据导出及移动端界面；截图输出到 `test-results/`。

## 检测结果如何理解

- Lighthouse 是单次实验室测量；固定配置也会波动，重要发布建议重复多次验证。
- 移动端是视口模拟，WebKit 不代表所有真实 Safari 设备。Firefox 的移动检测不启用不受支持的 `isMobile` 选项。
- 布局溢出、控制台错误与性能机会可能是疑似问题，需要业务复核。
- V1 质量扫描不会主动点击或提交表单。V2 测试在明确启用交互与请求权限后执行受限步骤，密码/支付等敏感动作不支持。页面加载自身的脚本仍会执行，可能产生站点正常请求。
- Playwright 阶段阻止 GET/HEAD/OPTIONS 之外的请求、Service Worker 和 WebSocket；V2 用例可显式允许当前环境的写请求。
- Lighthouse 独立运行，具有自身浏览器行为，不复用 Playwright 请求拦截和登录态。
- 浏览器流量经过 DNS 校验并固定解析 IP 的出口代理。公网生产化仍需独立容器、网络出口策略和任务隔离；不要将本地进程直接作为公共任意 URL 扫描服务。
- 检查失败的来源不会被用于自动标记旧问题已修复；被忽略的问题保留忽略状态。

更多设计说明见 [架构说明](docs/architecture.md) 与 [API](docs/api.md)。
