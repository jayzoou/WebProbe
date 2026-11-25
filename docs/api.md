# WebProbe · 产品事实

WebProbe 3.0 是面向个人开发者和可信单团队的本地 Web 质量检测与修复回归工作台。用户提供网页 URL，平台执行真实浏览器检查，保留证据并辅助定位、修复和验证问题。

## 用户链路

创建项目与环境 → 创建检测 → 查看问题和证据 → 请求规则或模型诊断 → 导出修复任务 → 修改实际源码 → 同配置回归检测。

V1 已实现 Vue 3 管理界面、Hono API、Playwright 三浏览器检测、Lighthouse、axe、SQLite 存储、问题聚合和状态流转、报告导出以及 CLI。权威字段和校验在 `packages/shared/src/index.ts`，接口说明见 `docs/api.md`。

## 事实边界

- 规则发现、模型推断和业务事实分别展示；没有源码不推测文件行号。
- 质量扫描不主动操作业务；V2 测试按显式授权执行受限步骤，业务正确性由用户断言定义。
- 无模型凭证时明确生成规则建议，不假装调用模型。
- 缺少检测、性能数据或覆盖范围时不能默认质量通过，也不能自动确认旧问题修复。
- 当前面向本地/可信团队，无多租户、RUM、调度、源码自动修改或公网任意 URL 扫描沙箱。

## 验收重点

保留正常、加载、空、失败和取消状态；用户能够理解问题证据、覆盖范围和诊断来源。扫描、导出及回归的实际行为以核心测试、安全测试和受控页面 E2E 验证。性能数据为实验室测量，不能直接代表真实用户体验或所有网站的表现。

## V2 测试链路

自然语言/录制/探索 → 审查声明式用例与断言 → 版本化保存 → 设备矩阵执行 → 截图/Trace/失败步骤 → 重放确认 → 修复回归。视觉检查点首次需要人工批准基线。详细事实与限制见 [V2 测试平台](v2-testing.md)。

用例执行不接受任意 JS；规则草稿不能冒充模型结果。探索采用有限的链接/单动作分支，不声称无业务预期也能发现所有功能缺陷。受策略阻拦不能变成已确认业务缺陷。

## V3 发布链路

项目与分层环境 → 环境质量策略 → 固定 Commit/目标/用例的发布 → 平台或受控 Runner 执行 → 逐项 Quality Gate → 与固定基线比较 → 保护环境审批 → 外部实际部署 → 登记部署结果。跨环境晋级重新验证，不复用预发布证据冒充生产检查。

历史绿灯与当前可部署资格分别表示；status 和登记接口检查当前策略与证据时效。Runner 是明确授权后信任的调用方声明，不是防篡改证明。平台不执行用户部署命令、不建立远端 required checks。详细事实见 [V3 发布质量](v3-release-quality.md)。

## V3 发布控制层

`packages/shared/src/releases.ts` 定义策略、版本、证据、评估、Runner 和部署契约。`releases/evaluator.ts` 独立计算中位数、覆盖、预算、时效和比较；service 固定版本快照并管理审批/基线/部署；orchestrator 复用扫描与测试队列；Runner 使用独立 Node 进程及临时 SQLite 执行同一引擎；routes/reports/CLI 提供 CI 与审计输出。

V1 Scan/V2 TestRun 新增可选项目快照，使任务不受后续 URL/环境编辑影响。现有对象兼容读取，环境类型/保护在读取时正规化，不作破坏性迁移。新增 records 种类 releasePolicy/release/gateEvaluation/releaseEvent/runnerJob/runnerUpload/deployment；证据沿用 artifacts，分片暂存 runner-staging。

单任务凭证只存 SHA-256，常量时间比较，绑定发布尝试、范围与过期时间；普通 API Token 不代替任务凭证。上传按配额、类型、路径、分片长度与摘要检查；单任务提交消费凭证，禁止重放。外部证据不写入平台扫描/Issue，策略默认不信任 Runner。平台数据库初始化后禁止在相同进程运行 Local Runner，防止模块缓存造成数据目录混用。

发布策略/用例/基线与评估是历史事实；当前 readiness 每次重新检查环境、策略、时效与审批。部署登记只记录调用方已执行的部署，不能证明实际产物对应 Commit。见 [V3 设计与使用](v3-release-quality.md)。

## V3 发布 API

共用 Host/Origin/Token，字段契约见 `packages/shared/src/releases.ts`。

| 方法       | 路径                                | 用途                                                                 |
| ---------- | ----------------------------------- | -------------------------------------------------------------------- |
| GET / PUT  | `/release-policies`                 | GET 携带 projectId/environmentId；PUT 为 `{policy,expectedRevision}` |
| GET / POST | `/releases`                         | 发布列表/创建固定 Commit 的版本                                      |
| GET        | `/releases/:id`                     | 快照、证据、当前评估与实时 readiness                                 |
| GET        | `/releases/:id/readiness`           | 当前准入资格，不改写历史结论                                         |
| GET        | `/releases/:id/events`              | SSE 进度                                                             |
| GET        | `/releases/:id/history`             | 发布事件与历史评估                                                   |
| POST       | `/releases/:id/check`               | 平台真实扫描/回归编排，返回 202                                      |
| POST       | `/releases/:id/cancel`              | 取消当前尝试及子任务/Runner                                          |
| POST       | `/releases/:id/evaluate`            | `{refreshPolicy:boolean}` 显式重新评估                               |
| POST       | `/releases/:id/baseline`            | `{baselineId:string或null}` 切换固定基线                             |
| POST       | `/releases/:id/approve`             | `{actor,note}` 审批当前评估                                          |
| POST       | `/releases/:id/promote`             | `{environmentId,targetUrl?}` 晋级，目标重新验证                      |
| POST       | `/releases/:id/deployments`         | `{commit,actor,url,note,source}` 登记外部部署                        |
| GET        | `/deployments`                      | 部署历史，可按 projectId 筛选                                        |
| GET        | `/releases/:id/compare?baselineId=` | 独立版本比较；不改写已选基线                                         |
| GET        | `/releases/:id/export?format=`      | json/markdown/junit/bundle                                           |
| POST       | `/releases/:id/runner-jobs`         | 生成单任务凭证，仅本次返回明文                                       |

以下仅接受对应 Runner Bearer 凭证，不接受管理 Token；仍检查 Host/Origin、过期时间、当前尝试与消费状态：

| 方法 | 路径                                            | 用途                                                |
| ---- | ----------------------------------------------- | --------------------------------------------------- |
| GET  | `/runner-jobs/:id`                              | 领取任务和固定配置                                  |
| GET  | `/runner-jobs/:id/baselines/:baselineId`        | 仅下载任务授权的已批准图片                          |
| POST | `/runner-jobs/:id/artifacts`                    | `{name,bytes,sha256,parts}` 创建有限额附件          |
| PUT  | `/runner-jobs/:id/artifacts/:uploadId/parts`    | `{index,data}` 128KiB base64 分片                   |
| POST | `/runner-jobs/:id/artifacts/:uploadId/complete` | 完整性和摘要校验后存入证据目录                      |
| POST | `/runner-jobs/:id/submit`                       | 一次回传严格类型的 scans/tests/platform/profileHash |
| POST | `/runner-jobs/:id/fail`                         | `{reason}` 结束失败任务，不产生通过结论             |

创建版本示例：

```json
{
  "projectId": "project-id",
  "environmentId": "preview",
  "version": "v3.0.0",
  "commit": "abcdef1234567",
  "branch": "main",
  "targetUrl": "https://preview.example.com/",
  "baselineId": "passed-release-id"
}
```
