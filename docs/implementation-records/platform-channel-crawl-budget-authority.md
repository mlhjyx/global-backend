# 平台抓取预算 purpose（platform.channel_crawl）—— 决策与落地规格

> 生命周期：`DRAFT`
> 依据：产品负责人 2026-11-04 批准新增平台抓取预算 purpose（经协作会话转达）；完整设计 §4/§7.2 与 Q27；本文档只记录决定与实施规格，代码实施见 §5 的分段计划。

## 1. 决定

- 新增平台执行预算 purpose **`platform.channel_crawl`**：渠道抓取（crawl 通道的试跑/运行）与 M2 watches 周期刷新**共用**这一个 purpose（不拆两个；若后续要拆，需新的书面决定）。
- 必须走**既有授权全链**：quote → `PLATFORM_GRANT` → egress fence → ACK；不绕过 ToolBroker；**无 Grant 一律拒绝**（fail-closed 语义保留，只是从"端点 409 暂不开放"切换到"无 Grant 即 402/403"）。
- 上限（三个维度同时生效）：
  - 单轮花费上限 `capPerRunMicrousd`（按页数预算 × 单页上界估算，操作员可配置）；
  - 单渠道每日页数上限 500（与既有 `source_channel_run.pages_fetched` 统计对账，UTC 日窗口）；
  - 单轮页数上限 50（`CHANNEL_RUN_MAX_PAGES`，试跑固定 1 页）。
- 撤销与围栏：purpose 纳入平台 scope（`scopeKey='platform'`），沿用既有平台 egress fence 与撤销链——撤销后未消费的 Grant 拒绝、运行中的抓取在**下一次物理请求前**停下，已产生的 `source_channel_run` 记录保留并标注撤销原因。
- 审计：每次抓取运行落 `source_channel_run`（pages/records/failures/耗时/errorCode）；渠道侧个人字段物化时沿用 Q25 访问审计（180 天）。

## 2. 为什么本班车不含代码实施

- 平台策略工件 `platform-authority-policy-matrix/v2` 是**字节级冻结**的：固定 15,583 字节、sha256 钉住、canonical JSON 校验、GrowthOS 期 provenance，且矩阵行只允许 4 个 schedule row（`EXPECTED_ROW_IDS`）。新增 purpose 必须发布**新版本的策略工件与 provenance**，属于 AGENTS §5 定义的「安全方向变更」，要求书面规格 + 独立 review；当前发车窗口内无法端到端验证平台 worker 与签发链，硬改的风险大于收益。
- 协作会话已确认的回退口径：窗口先到则抓取试跑保持 409，**M1 验收走 CSV 导入通道**（已端到端可用），不阻塞发车。
- 因此本 PR 只落**决定与规格**（本文档）；代码在三处对齐完成后以独立 PR 实施（§5），届时抓取端点从 409 切到授权路径。

## 3. 契约形状（实施规格）

- `purpose: 'platform.channel_crawl'`；`authorityKind: PLATFORM_GRANT`；`workspaceId: null`。
- `subjectType: 'source_channel'`，`subjectId = channelId`，`scheduleId: null`。
- `requestSha256 = sha256(canonical { channelId, mode: 'preview'|'run'|'refresh', pageCap })`：**一次性绑定**通道 + 模式 + 页数上限；篡改即 `EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH`。
- caps：`capPerRunMicrousd`（正数）、`campaignCapMicrousd = 单渠道日上限等值`、`maxRuns = 1`（每次运行一条 Grant）。
- 引擎 verifier：`assertAuthorityPurposeShape` 增加 PLATFORM_GRANT/`source_channel` 分支；**schedule 分支的既有不变量一个字节都不改**（subjectType='schedule'、subjectId=scheduleId、maxRuns=1、invocation 四字段校验保持原样）。channel_crawl 分支以 `requestSha256` + `crawlRunId`（UUID）+ 新策略工件的 `technicalPolicyRevision` 替代 schedule 四字段，并把 `assertPlatformExecutionInvocation` 的字段校验按新分支拆开（不放松原分支）。
- 三处对齐（缺一不可）：
  1. **引擎**：`EXECUTION_BUDGET_PLATFORM_PURPOSES`、`assertAuthorityPurposeShape`/verifier、`platform-authority-ingestion` 的 purpose→scope 映射、DB `ExecutionBudgetPurpose` 枚举（`ALTER TYPE ... ADD VALUE 'platform.channel_crawl'`）。
  2. **策略矩阵**：新版本工件（new artifact_id/provenance/matrix_revision），新增一行 `platform.channel_crawl/channel-crawl`（`temporal_namespace: 'platform-automation'`，`default_issuance_state: 'DENIED'`，`execution_envelope` 写明 per-run/day 上限），更新 `platform-authority-policy-asset.ts` 的冻结常量与 `verifyPlatformAuthorityPolicyAsset` 的行校验。
  3. **gain-saas**：内部签发端点（`/api/internal/v1/platform-channel-crawl-grants`，mTLS + 运营角色），按渠道日配额与 cap 校验后签发 PLATFORM_GRANT；复用现有 R4 密钥/audience 与 fence ACK 链；每次签发落审计。
- **执行位置**：抓取活动必须在持有 platform writer 的进程（platform worker）运行；API 只负责发起（Temporal StartWorkflowExecution）与查询，不直接出网。渠道抓取工作流与其 task queue 归属随实施 PR 落地。
- 页面级硬执行：`pageCap = min(请求值, 单轮 50, 渠道当日剩余配额)`；额度在活动内以 DB 统计（`source_channel_run` 当日 SUM）判定，越过即截断并记 `BUDGET_TRUNCATED`。

## 4. 实施 PR 的验收

- 无 Grant / 错误 purpose / 过期 Grant → 402 或 403；Grant 与 channel+mode+pageCap 任一不符 → `EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH`。
- 单轮花费上限与单渠道日页数上限被硬执行（构造越界用例断言截断 + PARTIAL 语义）。
- 撤销链：撤销后未消费 Grant 拒绝、运行中渠道在下一次请求前停下；fence/ACK 对新 purpose 与 4 个 schedule 走同一条链。
- 平台 4 个 schedule 保持 paused 不受影响；`platform.channel_crawl` 的签发默认 `DENIED`，需运营显式按渠道开启。

## 5. 分段计划

1. **P1（引擎契约）**：purpose 枚举/verifier/ingestion + 单测（新分支不放松原分支）。
2. **P2（策略矩阵新版）**：新工件 + provenance + 冻结常量更新 + 校验；独立 review。
3. **P3（gain-saas 签发）**：内部端点 + 配额/审计 + 单测。
4. **P4（执行接线）**：渠道抓取工作流（platform worker）+ `source_channel_run` + 页数/花费硬执行 + 撤销演练；抓取端点从 409 切到授权路径，保留无 Grant 即拒。

## 6. 实施进度

- 2026-11-05：**P2（策略矩阵新版）已实施**——新增 reviewed-v3 工件与 provenance v3：四个 schedule 行与 reviewed-v2 逐字节相同（行集 sha256 钉住），仅新增 `channel_crawl` 小节（DENIED、页数上限与引擎常量绑定）；readiness/能力签名/技术报价的四行不变量未动。GrowthOS 已退役，v3 按 backend-authored successor 发布：provenance 保留 v2 的 GrowthOS 溯源与字节基线，`backend_review` 记录独立 diff review。报价夹具在 v3 身份下确定性重算。
- 2026-11-05：**P1（引擎契约）已实施**——purpose 枚举（两段式迁移）、形状/绑定 CHECK 的 channel-crawl 分支、`crawl_run_id` 列与唯一索引、`ingest_and_admit_platform_channel_crawl_run_v1` 摄入函数（仅 platform writer 可执行）、verifier/types/contracts 双形状。schedule 摄入函数与 4 个平台 schedule 不变量未改动。P2（策略矩阵新版）、P3（gain-saas 签发）、P4（执行接线/409 切换）仍待实施。

## 7. 未做（本文档范围）

- 不包含任何代码改动；抓取端点在 P4 前保持 `409 CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY`。
- M2 watches 周期刷新的调度（复用本 purpose 的 refresh run）随 P4 一并接线。
