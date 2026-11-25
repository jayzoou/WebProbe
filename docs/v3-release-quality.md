# V3.0 · Release Quality Platform

入口：`/releases` 发布中心、`/environments` 环境与部署。V3 将现有扫描与功能测试接入开发/上线流程，保留 V1/V2 数据与功能。

## 从开发到上线

1. 在环境与部署页面配置 Development / Preview / Staging / Production，保存稳定环境 ID。旧环境会按 ID 推断类型；`production` 默认保护。停用环境使用归档。
2. 为目标环境配置发布质量策略：扫描浏览器/设备/路径、1–3 次独立采样、性能和问题预算、固定回归用例、基线要求、证据有效期及 Runner 信任。
3. 创建带版本名、Commit SHA、分支和候选 URL 的发布。Commit 是调用方关联信息，平台不拉取源码验证部署产物的 SHA。相同环境内版本名唯一，相同记录可重试；已部署记录不再执行覆盖式检测。
4. 点击平台质量验证，或用 Local Runner/CI 在可访问目标站点的机器上执行。
5. 查看逐项准入、版本对比、原始报告与用例证据。缺失指标、部分扫描、未覆盖用例、待视觉基线和配置不一致都不会算通过。
6. 保护环境需要针对本次评估的人工审批。审批是受信任工作区操作者的声明，不是独立身份认证或多人职责分离。
7. 在自己的流水线执行实际部署，成功后登记部署结果。登记校验 Commit、当前环境、当前策略、证据有效期及审批，记录历史和前一部署 ID；**平台不替你执行部署命令**。
8. 晋级到下一环境时保留 Commit，创建新发布并重新检测；预发布证据不会直接冒充生产证据。修复后用相同 Commit 对应的新版本或原记录重试，保留评估历史。

## 固定快照与比较

发布固定目标 URL、原环境地址、策略版本、浏览器/设备配置和用例步骤版本。后续项目、策略或用例编辑不会悄悄改变运行中版本。策略显式刷新会撤销旧审批；影响执行配置或用例步骤时，原证据指纹不匹配，需要重新运行。

基线采用选择时的证据快照，不随基线记录后续重试而变化。可以显式切换/清除基线，产生新评估并撤销审批。性能比较要求同项目且页面配置、浏览器、视口、采样次数一致，以路径（含查询）匹配候选 URL 和基线 URL。不同用例版本不做测试结果前后对比，当前版本仍须完成全部指定用例。

性能使用独立扫描的中位数，不把一次结果复制为多次采样；这仍是实验室数据，网络/CPU/字体等条件会造成波动。跨执行器或平台的性能差异需人工结合环境判断。问题按规则/路径/设备及可稳定识别的异常事实比较，只有两边成功覆盖的页面才计算新增或消失；问题消失不代表所有业务缺陷均已修复。

## 环境质量策略

V3 环境策略独立于 V1 单次扫描的参考阈值。默认要求 Chromium Lighthouse、2 次独立采样、性能 ≥80、LCP ≤2500ms、CLS ≤0.1、TBT ≤300ms、P0/P1 为 0、完整功能测试 100%、证据 1440 分钟有效。具体阈值由你根据项目设置，默认值不是对所有网站适用的行业承诺。

启用功能测试但未配置用例时会阻断；明确关闭测试只表示没有该范围的结论。相对回归默认允许 LCP 退化 15%，只在有可比基线时生效；也可强制基线。历史 `ready` 是当时的结论，当前 readiness 接口、CI status 和部署登记会重新检查时效和当前策略，避免旧绿灯永久有效。

## Local Runner

需要 Node.js 22.19+、仓库依赖和 Playwright 浏览器。当前是仓库 CLI，不是已发布的 `npx webprobe` 包。

最简单的 CI/本地接入使用完整平台 API Token（从环境变量传递）：

```bash
npm run release -- check --project PROJECT_ID --environment preview \
  --version v3.0.0 --commit abcdef1234567 \
  --target http://127.0.0.1:5173 --mode local \
  --allow-private-network --output webprobe-results
```

先启动被测应用；Runner 不会安装你的应用依赖或执行上传的 Shell。它读取固定任务配置，在独立进程/临时 SQLite 目录里运行与平台相同的 Playwright、Lighthouse 和回归引擎，不复用用户平台数据。已批准视觉基线通过单任务授权下载；基线按操作系统隔离，不同操作系统可能需要先在对应执行环境批准基线。首个视觉基线不能在 CI 自动批准。

也可在发布详情生成短期单任务凭证，只把该凭证交给执行器：

```bash
# 从安全凭证存储设置 WEBPROBE_RUNNER_TOKEN，避免写入命令参数/日志
npm run release -- runner --job JOB_ID \
  --server http://127.0.0.1:4174 --output webprobe-results
```

任务凭证 1 小时有效，仅可读取该任务、下载获授权基线、上传附件和回传一次结果，不能读取项目管理 API、操作其他任务或审批发布。完成、取消、过期或新尝试后失效。取消/失败不判为通过，未完成任务可在界面取消或重新创建；过期记录保留历史。

Runner 结果是受凭证保护的执行器声明，平台不能证明远程浏览器没有被篡改。因此环境策略默认**不信任 Runner 证据**；明确启用后才能参与通过判定。若先回传再启用信任，可显式采用当前策略重新评估，其他执行配置未变时可复用原证据。不会导入外部结果来直接关闭平台 Issue。

报告元数据通过严格 Schema、范围、配置指纹、用例版本、覆盖、时效校验。附件单文件 ≤8MiB，总量 ≤32MiB，最多 60 个，128KiB 分片，SHA-256 校验，不解压上传的 ZIP。超过限额的附件会记录在本地 `omitted-artifacts.json`；不会据此伪造检测结果。报告和证据目录可能含被测页面数据，应按团队数据策略保存。隔离临时目录可由系统或你定期清理。

## CLI / CI 退出码

```bash
npm run release -- init --config webprobe.config.json
npm run release -- check --config webprobe.config.json \
  --version v3.0.0 --commit abcdef1234567 --target https://preview.example.com
npm run release -- check --release RELEASE_ID --mode platform
npm run release -- status --release RELEASE_ID
npm run release -- deploy --release RELEASE_ID --commit abcdef1234567 \
  --deployment-url https://example.com --actor CI
```

`init` 不覆盖已存在配置。平台地址读取 `--server`、配置中的 `server` 或 `WEBPROBE_URL`；完整 API 凭证读取 `WEBPROBE_API_TOKEN`。`--allow-private-network` 仅显式启用本机 Runner 的内网访问；平台执行是否允许内网仍由平台 `.env` 控制。不能在公共实例不加隔离地启用此开关。

| 退出码 | 意义                                 | 流水线处理                         |
| ------ | ------------------------------------ | ---------------------------------- |
| 0      | 当前发布就绪或已登记，实时资格仍有效 | 可进入你自己的部署步骤             |
| 1      | 质量阻断或当前资格失效               | 阻断部署                           |
| 2      | 配置、认证、网络、执行错误或超时     | 阻断并排查                         |
| 3      | 质量通过但需要人工审批               | 等待工作区审批后，以 status 再核对 |
| 4      | 发布验证已被取消                     | 不部署                             |

输出目录含 `release.json`、`quality-report.md`、`junit.xml`；执行错误另有 `error.json`。Local Runner 还保存 Runner 原始摘要及可上传附件。平台模式 `--timeout` 默认 900 秒，超时取消当前检查；Local Runner 整个执行阶段上限 15 分钟。CI 不应使用 `continue-on-error` 或 `allow_failure` 绕过退出码。

GitHub 自动记录调用方仓库/Run 信息，写入 `GITHUB_OUTPUT` 的 release_id/gate_status/release_status 和 Job Summary；GitLab 自动关联流水线元数据。CI 链接为调用方提供的信息，未通过 GitHub/GitLab API 独立验证。

## 接入 GitHub / GitLab

- [GitHub Actions 示例](../integrations/github-actions/release-quality.yml)：配置可信 Runner 仓库/ref、项目/环境变量及平台 URL/Token Secret，在预览地址就绪后运行；审批后的已有版本可通过 existing_release_id 做实时 status 核验。
- [GitLab CI 示例](../integrations/gitlab/release-quality.yml)：在应用项目中引入 job，配置受保护且屏蔽的凭证变量，预览 URL 可访问后运行。真实部署 job 使用 `needs` 依赖 quality，并在成功后登记部署。

示例依据 [setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact) 和 [GitLab JUnit 文档](https://docs.gitlab.com/ci/testing/unit_test_reports/) 编写。仓库没有远端 Git 元数据，本次只提供接入文件；没有声称已在用户组织安装、配置 required checks 或执行远端流水线。托管平台的分支保护、环境审批和部署权限需在实际组织中配置。

## 状态、并发与恢复

版本状态：draft → checking / waiting_runner → blocked / awaiting_approval / ready → deployed。取消为 cancelled；重试产生新的尝试和评估，清空当前证据、旧审批及旧 Runner 凭证，但保留历史评估与事件。平台最多同时编排 2 个发布任务，浏览器引擎仍使用各自串行队列。重启后平台活动发布标记受阻，等待中的 Runner 可在未过期且仍属当前尝试时继续。

部署是幂等登记同一 release/Commit，不执行基础设施操作，不提供真正流量切换或回滚。需要回滚时将经验证的目标 Commit 作为新发布，在目标环境重新验证再由外部流程执行，避免把旧版历史报告当作当前健康证明。

本版保持本地/可信单团队边界，无多租户权限、独立身份审批、构建产物签名、RUM 或生产网络沙箱。服务默认监听本地，远程 Runner 必须通过安全的可达 API 或隧道连接；不要把任意 URL 扫描服务直接公开。
