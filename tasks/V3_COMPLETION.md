# 交付记录：WebProbe V3.0 Release Quality Platform

- 关联任务：`tasks/V3_RELEASE_QUALITY.md`；版本：3.0.0；状态：实现完成，待项目责任人验收。
- 实现结果：新增发布中心 `/releases`、详情/Quality Gate/版本比较/时间线与环境管理 `/environments`；固定 Commit、环境/策略/用例/基线快照；平台编排、多次采样中位数、回归、保护环境审批、跨环境晋级与幂等部署登记。
- Local Runner：独立进程与隔离临时 SQLite，复用真实引擎；短期单任务凭证、固定配置、授权视觉基线、附件分片/摘要/配额、一次回传和明确来源信任。
- CI：新增 `npm run release`，支持 check/runner/status/deploy/init；JSON、Markdown、JUnit 与报告包；实时 readiness 防止旧绿灯放行；GitHub/GitLab 接入示例。
- 主要文件：`packages/shared/src/releases.ts`、`apps/server/src/releases/`、`apps/server/src/release-cli.ts`、发布/环境 Vue 视图与 ReleasePolicyEditor；沿用 npm、Vue、Hono、SQLite、Playwright/Lighthouse，无新增依赖。

| 验收条件            | 实际执行                                                                           | 结果                                             | 证据                                         |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| AC-1 环境与策略     | core 旧环境保护/策略版本测试，E2E 环境/策略界面与固定快照                          | 通过                                             | core.log、e2e.log                            |
| AC-2 真实发布准入   | 真实 Lighthouse 和固定功能用例；缺失/重复/不完整/旧证据/版本/来源边界核心测试      | 通过                                             | core.log、e2e.log                            |
| AC-3 版本回归       | 核心测试中位数、基线证据不可变、配置不兼容与退化；真实跨候选 URL 比较              | 通过                                             | core.log、e2e.log、v3-release-comparison.png |
| AC-4 Local Runner   | CLI 独立子进程实际扫描/测试、附件回传、平台扫描表不污染；凭证/上传范围安全测试     | 通过                                             | e2e.log、security.log                        |
| AC-5 CI 阻断        | 实际 CLI 质量失败退出 1、就绪退出 0、待审批退出 3，生成 JUnit/JSON/Markdown        | 通过                                             | e2e.log                                      |
| AC-6 审批/晋级/部署 | 重新检测目标环境、审批绑定评估、Commit 不符拒绝、幂等登记；当前策略/时效失效拒绝   | 通过                                             | core.log、e2e.log                            |
| AC-7 取消与历史     | E2E 取消平台发布与导出，事件/评估历史；服务恢复显式受阻逻辑及任务失效范围审查      | 通过（恢复路径为代码审查，未做真实崩溃重启注入） | e2e.log、service/orchestrator 审查           |
| AC-8 既有兼容       | 原 V1 三浏览器/Lighthouse/42 条预设问题修复，V2 三浏览器复现/录制/视觉与模型隔离桩 | 通过                                             | e2e.log                                      |

## 实际自动化验证

- 最终命令：`npm run verify:high`。
- 最终 runId：`2026-11-25T13-20-19.972Z-3c81e420`。
- 报告：`.ai-workflow/reports/2026-11-25T13-20-19.972Z-3c81e420/report.md`，结论 `passed`。
- format、typecheck、core、build、e2e、security 六项全部通过。
- core 共 30 项（含 9 项安全测试）；high 另独立执行 9 项安全测试。E2E 实际执行 V1/V2/V3 三个脚本。
- 前次 high 发现两处 Vue 格式差异，停止了浏览器阶段后修正并完整重跑；失败/取消记录保留在 `2026-11-25T13-19-11.413Z-10a6e41f`，未降低门禁。
- 同步依赖锁文件时 npm 返回 0 个已知漏洞；这不代表完整安全证明或未来依赖状态。

## 浏览器与人工验收

- Agent 已查看真实浏览器截图：`test-results/v3-release-center.png`、`v3-release-comparison.png`、`v3-release-mobile.png`。
- 桌面 1440×1000 与移动 390×844，E2E 检查发布中心、策略编辑、版本比较、环境管理与部署状态，无 UI pageerror、无移动整页横向溢出。
- 截图与所有发布数据来自隔离受控页面，不是用户生产数据。为避免把机器性能波动当作功能失败，V3 E2E 使用宽松的显式性能阈值；严格指标、采样和时效判定由隔离核心测试覆盖。生产默认策略未放宽。
- 项目责任人尚未对真实网站/业务预期、生产阈值、审批规则进行人工验收；自动化通过不等于该验收完成。

## 已知限制与未执行项

- GitHub/GitLab 只提供接入文件和协议输出；未提交远端、未安装组织 Secrets/required checks、未执行远端流水线。仓库当前无 Git 元数据。
- 部署登记不是实际部署动作，Commit 由调用方关联，未拉取源码或校验产物签名；未执行生产发布、流量切换或真实回滚。
- Runner 为明确授权后信任的执行器声明，不具备远程防篡改证明；无法在平台里直接关闭外部结果对应 Issue。
- 保护环境审批基于可信工作区操作者声明，无独立身份认证/多人职责分离；仍面向本地或可信单团队。
- 性能为实验室测量，跨平台/字体/网络存在差异；未作所有公网网站、真机、多地域或生产网络沙箱验证。
- 超大附件会省略并写入本地 omitted-artifacts.json；临时 Runner 数据目录需按团队策略清理。

## 发布与回滚

运行方式保持 `npm run dev`，或 `npm run build && npm start`。旧数据兼容正规化读取，无破坏性迁移；新增 records 种类和 artifacts/runner-staging 目录。回退前停止服务并备份完整 data 目录，旧版不会读取 V3 新对象。实际应用回滚应作为新的经验证发布，由外部流水线执行后登记。
