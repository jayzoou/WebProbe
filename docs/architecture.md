# WebProbe V1.0 架构

AI 协作与质量门禁见 [工作流说明](workflow.md) 和 [质量门禁](quality-gates.md)。本文件保留现有业务架构事实，工作流接入不改变运行时模块边界。

## 边界

V1.0 实现最新产品讨论中的 Web Quality Scanner，交付真实检测和修复闭环。通过 URL 可获得浏览器运行事实，但没有源码、业务断言、真实用户数据时不推断业务正确性，也不宣称自动发现所有 Bug。

## 组件

```text
Vue 3 / Router / reactive state
           │ HTTP + SSE
Hono API ──┼── SQLite records（Project / Scan / Issue）
           ├── 修复报告 / Markdown / ZIP
           ├── 兼容模型 API → 校验后的 Diagnosis
           └── 串行 Scan Queue
                 ├── Playwright → Runtime / Network / DOM / axe
                 ├── Lighthouse → Chromium / 实验室指标 / 原始报告
                 └── DNS 校验出口代理 → 被测网站
```

文件结构：`apps/web` 为管理界面，`apps/server` 为 API 与检测执行，`packages/shared` 为 Schema 和类型，`fixtures` 为可复现缺陷页面，`tests` 为核心规则及完整业务验证。

## 存储选择

V1.0 使用 Node 原生 SQLite，减少本地启动所需的外部服务；使用 WAL 保证持久化、事务保证问题聚合一致性。关系对象由共享类型定义，序列化到 `(kind,id,body)` 表。此设计适合单进程、有限历史量的本地实例。面向大规模协作部署时，应将存储层迁移为 PostgreSQL 规范化表，并将任务队列迁移为 BullMQ/Redis、证据文件迁移至对象存储。

## Finding 与 Issue

Finding 是一次扫描中的事实；Issue 是跨扫描聚合的长期问题。指纹使用规则、完整页面 URL（不含 hash）、浏览器、设备及稳定证据标识生成；项目和环境独立分组。查询参数保留，避免误将不同业务页面合并。一次扫描内相同指纹仅增加一次出现计数。

问题人工流转为 `open → in_progress → pending_verification`，或 `ignored`。扫描时对应页面/浏览器/设备成功完成、对应来源确实执行、旧指纹未再出现，才将问题置为 `resolved`；复发重新打开。失败的浏览器安装、取消的任务或 axe/Lighthouse 失败都不会据此自动解决旧问题。

Issue 的出现次数是被发现的检测次数，不是用户数量、错误总次数或 RUM 事件量。历史 Scan 保存完整 Findings 快照，不因人工操作改变。UI 不允许手工直接标记已修复。

## 基线与准入

基线选择相同项目、环境、浏览器列表、设备列表、路径、页数与 Lighthouse 开关下最新的完整检测。只对两次都有成功覆盖的来源计算新增或消失；新增发现但旧检测未覆盖的页面不被错误算作回归。

指标按 URL、浏览器、设备逐项比较。准入必须通过完整性、性能依据、每条 Lighthouse 性能/LCP/CLS 阈值和 P0/P1 数量限制。只执行 Firefox 或关闭性能审计仍可用于排错，但没有性能准入依据。

## 执行与安全

串行队列限制 CPU/内存竞争，每个浏览器上下文独立。导航 30 秒、Lighthouse 120 秒、全任务 15 分钟。取消会关闭活动浏览器；Lighthouse 有独立进程清理。进度通过 SSE 推送，普通列表每 4 秒刷新（浏览器页面可见时）。服务重启后将运行中或排队任务标记为失败，避免永久悬挂。

macOS 的 Firefox 子进程使用 `data/runtime/firefox-home` 作为独立的应用数据根目录，避免访问用户日常 Firefox 的系统保护目录。检测配置仍由 Playwright 为每次启动创建，不复用用户会话。此处理依据 [Playwright 上游问题](https://github.com/microsoft/playwright/issues/42768) 并经过本机验证。

所有浏览器 HTTP/HTTPS 流量经过本地出口代理，在建立连接时解析 DNS、拒绝非公网 IP 并使用已验证 IP 建立连接，覆盖重定向和子资源。云元数据地址默认禁止；内网目标需管理员显式启用。代理关闭时销毁所有隧道。此措施是应用层防护，不替代公网部署所需的独立网络沙箱。

API 绑定本地地址，验证 Host/Origin，非本地绑定需 Token。前端仅在当前 sessionStorage 保存 Token。截图和原始报告经过同一 API Token 检查，原始 HTML 通过 CSP sandbox 隔离。模型输出和证据使用 Vue 文本渲染，避免任意 HTML。报告提醒外部 Agent 将网页内容当作不可信证据。

## AI

用户主动触发诊断，发送选中问题的证据给自定义兼容模型。Zod 校验摘要、原因假设、步骤、验证和有限置信度字段；不执行模型返回的指令。没有密钥时返回 `provider: rules` 并明确标注；请求失败时不会静默伪装为 AI 成功。没有源码就不声称定位文件行号。

## 后续演进

持续巡检调度与告警、版本化业务断言、登录态管理、RUM SDK、Source Map、MCP 服务、多用户访问控制、独立 Worker、数据保留策略和多次性能统计均为后续方向。

## V2 测试执行架构

新增 `apps/server/src/testing`：browser 复用 URL/DNS 代理并限制当前环境导航/请求；generation 基于 DOM 清单生成严格步骤并保存来源；recorder 用固定的应用脚本捕获主框架操作；runner 按用例快照映射到 Playwright；visual 用 pixelmatch/pngjs 比较 PNG；routes 管理用例、执行、探索、录制和审批。Vue 的 Testing、TestCaseEditor、TestRunDetail 展示同一共享契约。

不在服务端执行导入的脚本；`.spec.ts` 仅为导出成果。测试与 V1 扫描采用独立串行队列。功能 Issue 具有用例 ID/版本/执行 ID，V1 扫描不覆盖该来源；同版本测试全通过才关闭对应功能问题。视觉基线和历史执行只追加，审批不会改写旧执行。

固定浏览器脚本保存在 dom-scripts.ts，不插入网页/模型文本作为代码；这是为了避免 Node 转译辅助函数意外进入浏览器 realm。Trace 和图像证据沿用 artifacts 身份验证。当前环境写请求通过显式配置扩大，V1 默认只读保持不变；执行受阻与确定性失败分开。详见 [V2 使用说明](v2-testing.md)。
