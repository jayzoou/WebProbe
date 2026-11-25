# V1.0 API

默认基址 `http://127.0.0.1:4174/api`。设置 Token 后，在每个 API/证据请求携带 `Authorization: Bearer <token>`。错误统一为 `{ "error": "描述" }`。

| 方法       | 路径                                | 用途                                        |
| ---------- | ----------------------------------- | ------------------------------------------- |
| GET        | `/health`                           | 版本、AI 配置状态与内网检测状态（不含密钥） |
| GET / POST | `/projects`                         | 列出或创建项目                              |
| PUT        | `/projects/:id`                     | 编辑项目；有活动检测时拒绝修改              |
| GET / POST | `/scans`                            | 列出或新建检测；支持 `?projectId=`          |
| GET        | `/scans/:id`                        | 检测详情与完整快照                          |
| POST       | `/scans/:id/cancel`                 | 取消等待中或运行中的任务                    |
| GET        | `/scans/:id/events`                 | SSE `progress` 事件，data 为完整 Scan 快照  |
| GET        | `/scans/:id/export?format=json`     | 完整 JSON 报告与修复提示词                  |
| GET        | `/scans/:id/export?format=markdown` | 外部 Agent 修复提示词                       |
| GET        | `/scans/:id/export?format=bundle`   | ZIP，包含报告、提示词和已有证据文件         |
| GET        | `/issues`                           | 问题列表，支持 `?projectId=`                |
| PATCH      | `/issues/:id`                       | 更新 `status`，禁止人工设置 `resolved`      |
| POST       | `/issues/:id/diagnose`              | 调用模型或规则建议，返回更新后的 Issue      |

项目请求示例：

```json
{
  "name": "个人博客",
  "description": "博客发布质量检测",
  "environments": [{ "id": "production", "name": "生产环境", "url": "https://example.com/" }],
  "gate": { "minPerformance": 80, "maxLcp": 2500, "maxCls": 0.1, "maxCritical": 0 }
}
```

检测请求示例：

```json
{
  "projectId": "项目返回的 ID",
  "environmentId": "production",
  "release": "v1.0.0",
  "browsers": ["chromium"],
  "devices": ["desktop", "mobile"],
  "maxPages": 3,
  "paths": ["/about"],
  "lighthouse": true
}
```

创建后返回 HTTP 202，客户端通过详情或 SSE 等待最终状态。检测状态为 `queued/running/completed/partial/failed/cancelled`。`partial` 表示至少一个页面、axe 或性能审计失败，不能视为完整质量通过。环境、规则、报告字段的权威 Schema 位于 `packages/shared/src/index.ts`。

## V2 测试 API

共用现有 Host/Origin/Token。字段权威契约在 `packages/shared/src/testing.ts`。

| 方法       | 路径                        | 用途                                                                    |
| ---------- | --------------------------- | ----------------------------------------------------------------------- |
| GET / POST | `/test-cases`               | 列出/创建用例；生成草稿保存可带 `?draftId=` 保留来源                    |
| PUT        | `/test-cases/:id`           | 新增版本并更新当前用例                                                  |
| PATCH      | `/test-cases/:id/archive`   | `{archived:boolean}` 归档/恢复                                          |
| GET        | `/test-cases/:id/revisions` | 历史版本                                                                |
| POST       | `/test-cases/generate`      | `{projectId,environmentId,path,goal}` → provider/draftId/draft/warnings |
| POST       | `/test-cases/import`        | 1–20 个用例 JSON；不执行 JS 源文件                                      |
| GET        | `/test-cases/:id/export`    | JSON；`?format=playwright` 导出 spec.ts                                 |
| GET / POST | `/test-runs`                | 列出/创建批量矩阵执行                                                   |
| GET        | `/test-runs/:id`            | 固定用例快照、逐步结果与证据                                            |
| GET        | `/test-runs/:id/events`     | SSE progress 完整快照                                                   |
| POST       | `/test-runs/:id/cancel`     | 取消执行                                                                |
| GET        | `/test-runs/:id/export`     | JSON；`?format=bundle` 下载复现 ZIP                                     |
| POST       | `/test-runs/:id/baselines`  | `{resultId,name}` 明确批准视觉基线                                      |
| GET        | `/visual-baselines`         | 基线审批历史                                                            |
| GET / POST | `/explorations`             | 列出/创建有限页面探索                                                   |
| POST       | `/explorations/:id/cancel`  | 取消探索                                                                |
| GET / POST | `/recordings`               | 列出/启动本地浏览器录制                                                 |
| POST       | `/recordings/:id/stop`      | `{save:boolean}` 结束并保存/放弃                                        |

运行请求示例：

```json
{
  "projectId": "project-id",
  "environmentId": "preview",
  "caseIds": ["case-id"],
  "browsers": ["chromium"],
  "devices": ["desktop"],
  "allowInteractions": true,
  "allowWrites": false,
  "release": "v2.0.0"
}
```

用例步骤示例：

```json
{
  "projectId": "project-id",
  "name": "搜索预期",
  "steps": [
    { "action": "navigate", "path": "/" },
    { "action": "fill", "target": { "by": "testId", "value": "query" }, "value": "Vue" },
    { "action": "click", "target": { "by": "testId", "value": "search" } },
    { "action": "assertText", "target": { "by": "testId", "value": "results" }, "text": "Vue" },
    { "action": "visual", "name": "search", "maxDiffRatio": 0.01, "masks": [] }
  ]
}
```
