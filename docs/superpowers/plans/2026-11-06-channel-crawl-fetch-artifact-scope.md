# 渠道抓取取数与 run 幂等修复 · 落地设计文档（2026-11-06）

> 生命周期：`APPROVED`
> 生命周期依据：2026-11-06 带迁移发车后的 ProPak Asia preview 验收发现两个缺陷（见 §1）；产品负责人 2026-11-06 指示「修复」并在设计文档提交后批准 D-a~D-d 推荐值（「批准开工（推荐）」）。
> 任务启动门（计划 §0.6）：① 设计文档（本文）② 闭环设计（§5）③ 联网研究（§10）→ 产品负责人过目批准 → TDD。

## 1. 背景与目标

2026-11-06 00:17 CST 发车（后端 `abc45ddb`，镜像 `06d6c67f`，含 #817 渠道记录物化）后的验收发现两个真问题：

**缺陷 A（阻断验收）**：渠道抓取的每一页抓取都被 ToolBroker 拒绝。
- 现象：ProPak Asia preview 工作流 `channel-crawl-a4b6a196…` finalize 为 `pages_fetched=1, records_found=0, records_materialized=0, failures=1`；platform-worker 日志 `[tool-broker] DENIED crawl4ai.render GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD`。
- 根因：`crawl4ai.render` 的持久化产物声明为 `artifact_reference` / `PERSONAL_DATA`（HTML 可能含个人数据），ToolBroker 的 G3 规则要求调用方提供 `ctx.artifactSubject`（既有公司/联系主体）才放行；渠道抓取是平台作用域（`workspaceId='platform'`），没有也**不应有**公司主体，于是 `artifactPrecheck` 恒返回 hold（`apps/api/src/tools/tool-broker.ts:849-863`），`ArtifactSubjectBindingContract` 对非 workspace 作用域也恒 DENY（`durable-results/artifact/artifact-subject-binding.contract.ts:145-160`）。自 P4 上线以来渠道抓取实际上从未取到过页面（2026-11-05 冒烟 run 同样 failures=1，当时只核对了工作流绿）。

**缺陷 B**：`source_channel_run.crawl_run_id` 恒为 NULL。
- 根因：`finalizeChannelCrawl`（`temporal/channel-crawl.activities.ts:228-249`）没有把 `crawlRunId` 传给 `recordChannelRunInTransaction`，而迁移 `20261105120000_source_channel_records` 新增的 `crawl_run_id` 唯一列（schema 注释「工作流稳定标识，finalize 幂等」）因此从未写入：Temporal 活动 at-least-once 重试会重复插入 run 行，记录（`source_channel_record.crawl_run_id`）与 run 行关联断链。

目标：
1. 让平台渠道抓取在**不削弱 G3 主体绑定契约**的前提下真正出网取数（A）。
2. finalize 写入 `crawl_run_id` 并做到重试幂等（B）。
3. 修复后重新发车并重跑 ProPak Asia preview 验收（有记录、`records_materialized` 与行数一致、重跑不重复且 `last_seen` 前移）。

## 2. 承重假设（可证伪）

1. 渠道抓取的原始 HTML **不需要持久化**：记录池 `source_channel_record` 已按记录保存 `source_url` 与 `content_hash`（provenance），选择器调试可随时手动抓取；不持久化反而消除一份「无人可擦除的原始页面副本」。若日后需要原始页面回放（审计/回归），再单独立项平台 artifact 存储（见 §9 开放问题）。
2. 将「该工具可在声明过的平台作用域下以**瞬态结果**执行（不落 artifact）」表达为**工具声明 + 调用方显式声明作用域 + broker 校验**的三元约束，可以把影响面封闭在唯一声明的作用域 `platform_channel_crawl` 上；租户调用路径保持现状（无 subject 仍 hold）。
3. `crawl_run_id` 唯一约束 + 先查后写（含并发冲突回读）即可让 finalize 幂等，不需要新的迁移或表。

## 3. 触点（全部已核对）

| 文件 | 现状 | 改动 |
| --- | --- | --- |
| `apps/api/src/tools/tool-contract.ts` | `ToolContext` 无瞬态声明；`Tool` 无瞬态能力声明 | 新增 `transientResultScope?: TransientResultScope`（ToolContext）与 `transientResultScopes?: readonly TransientResultScope[]`（Tool） |
| 新文件 `apps/api/src/tools/transient-result-scope.ts` | — | 关闭集合 `TRANSIENT_RESULT_SCOPES = ['platform_channel_crawl']` 与解析函数 |
| `apps/api/src/tools/tool-broker.ts` | 无 subject 即 hold（`:849-863`）；settle 分支 `else if (reservation)` 已支持无 artifact 结算（`:704-840`，`settle_tool_budget` 允许 schema 为空） | 在 artifact 准入门（`:456-478`）前对 `ctx.transientResultScope` 做校验：工具已声明 + `workspaceId==='platform'` + 非 paid，则跳过 hold、不持久化 artifact，落一条 trace；任一条件不满足 → `ToolPolicyDenied('TRANSIENT_RESULT_SCOPE_DENIED')`（fail-closed） |
| `apps/api/src/tools/source-tools.ts` | `crawl4aiRenderTool` 无瞬态声明 | 声明 `transientResultScopes: ['platform_channel_crawl']`（仅 render；`crawl4ai.fetch`/`http-get` 不动） |
| `apps/api/src/temporal/channel-crawl.activities.ts` | fetch 闭包 context `{workspaceId:'platform', runId, correlationId, platformEgress}`；finalize 不传 `crawlRunId` | context 增加 `transientResultScope: 'platform_channel_crawl'`；finalize 传 `crawlRunId: args.input.crawlRunId` |
| `apps/api/src/channels/channel-run-recorder.ts` | `RecordChannelRunInput` 无 `crawlRunId`；create 无 `crawl_run_id` | 输入增加可选 `crawlRunId`；有值时按唯一键幂等（先查→更新或创建；并发唯一冲突回读后只更新、不重复加 failureStreak） |
| `packages/db/prisma/schema.prisma` | `SourceChannelRun.crawlRunId String? @unique` 已存在（#817） | 不改（无迁移） |

不改动：`ArtifactSubjectBindingContract`（G3 契约本身）、租户抓取路径、`platform_egress_fence`、Grant/R4 链路、`source_channel_record` 物化逻辑、gain-saas。

## 4. 设计

### 4.1 瞬态结果作用域（缺陷 A）

- **关闭集合**：`TransientResultScope = 'platform_channel_crawl'`。新增作用域必须改代码并经评审（与 G3 的安全边界同级的显式清单）。
- **工具声明**：`crawl4aiRenderTool.transientResultScopes = ['platform_channel_crawl']`。语义：「本工具允许在声明的作用域下执行且不持久化 artifact（结果只在本次调用内使用）」。
- **调用方声明**：渠道抓取的 ToolContext 加 `transientResultScope: 'platform_channel_crawl'`。
- **Broker 校验（fail-closed）**：`transientResultScope` 存在时，必须同时满足（a）值在关闭集合内、（b）工具声明了该作用域、（c）`ctx.workspaceId === 'platform'`、（d）非 paid 调用；任一不满足 → `ToolPolicyDenied('TRANSIENT_RESULT_SCOPE_DENIED')`（复用现有 release 语义：未出网即释放预留）。
- **放行后的行为**：跳过 `artifactPrecheck`/`admitArtifactSubjectOrDeny`/`persist`，正常执行物理抓取；结算走既有 `else if (reservation)` 分支（无 projection、无 durable receipt，只计费与 operation 行）。审计：broker trace 的 OK 记录带上作用域名与「未持久化」注记（不进 Temporal 历史、不改收据契约）。
- **已结算的瞬态操作重放**：瞬态结果不落盘，settled operation 无法回放——`reservation.replay` 命中时直接以 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`（remnant）失败关闭，绝不重发物理请求（活动重试会表现为该页失败而不是重复出网）。
- **为什么不是「平台 artifact 持久化」**：那需要给 `ArtifactSubjectBindingContract` 增加无主体平台分支并定义 platform 作用域 artifact 的擦除/保留策略（G3 的 DSR 语义），影响面大且没有即时需求（见 §10 研究：缓存超出技术可用期即构成独立再发布，需可擦除）；瞬态执行不产生第二份副本，是更保守的一侧。两个方案的取舍列入 §9 决策点 D-a。

### 4.2 finalize 幂等（缺陷 B）

- `RecordChannelRunInput` 增加 `readonly crawlRunId?: string`；`finalizeChannelCrawl` 传 `args.input.crawlRunId`（Temporal 每次活动尝试携带同一 UUID）。
- 记录器在事务内：
  1. `findUnique({ where: { crawlRunId } })`：存在 → 只更新 outcome 字段（status/pagesFetched/recordsFound/recordsMaterialized/failures/truncated/errorCode/finishedAt），**不推进 failureStreak**，返回既有 runId；
  2. 不存在 → 创建（含 `crawl_run_id`）并执行现有 failureStreak 逻辑；
  3. 创建撞唯一约束（并发重试）→ 回读并按 1 处理（不重复推进 streak）。
- 无 `crawlRunId` 的调用方（如 `channel.service.recordChannelRun` 的租户路径）行为不变。

## 5. 闭环设计（§0.6 ②）

- **SoR**：运行账本 `source_channel_run`（平台表，含 `crawl_run_id` 唯一）；记录池 `source_channel_record`（含每记录 provenance）；工具执行账本 `tool_budget_operation`（瞬态调用只有计费，无 artifact 行）。
- **对外事件**：不新增；平台出网审计走既有 egress fence/Grant 链与 broker trace。
- **Tool Contract**：`crawl4ai.render` 增加一个**声明式**的瞬态作用域；默认路径（租户、未声明）完全不变——「无主体的 PERSONAL_DATA HTML 出网」只在 `platform_channel_crawl` 一个作用域被打开，其他任何组合仍然 fail-closed。
- **闭环位置**：Discover → 渠道抓取（平台）→ 记录池 → 归因/运营台。
- **端到端演示**：修复发车后，ProPak Asia preview：工作流 finalize `SUCCEEDED`、`records_found>0`、`records_materialized` 与 `select count(*) from source_channel_record where crawl_run_id=…` 一致；同渠道第二次 preview：行数不翻倍、`last_seen` 前移、run 行数不增加。
- **负向测试**：租户 workspace 带瞬态作用域 → 拒；平台 workspace 用未声明的工具/未声明的作用域 → 拒；paid 调用带作用域 → 拒；同一 `crawl_run_id` finalize 两次 → 单行且 streak 只推进一次。

## 6. 迁移与回滚

- 无 schema 迁移（`crawl_run_id` 列与唯一约束已在 `20261105120000` 生效）。
- 回滚 = 代码回退到上一镜像 digest（瞬态作用域是新增行为，旧代码不受影响）；`source_channel_run` 已写入的 `crawl_run_id` 向前兼容（列可空）。

## 7. 测试与 TDD 步骤（先红后绿）

1. Broker（`tool-broker.spec.ts`）：平台 + 已声明工具 + 作用域 → 物理执行成功、`budget.settle` 无 projection；租户 + 作用域 / 未声明工具 / paid → `TRANSIENT_RESULT_SCOPE_DENIED`；未带作用域的平台调用 → 维持现有 hold（回归）。
2. 渠道抓取活动（`channel-crawl.activities.spec.ts`）：fetch 闭包把 `transientResultScope` 放进 context；finalize 把 `crawlRunId` 传给 recordRun。
3. 记录器（`channel-run-recorder.spec.ts` 或新增）：同 `crawlRunId` 两次 finalize → 单行、字段收敛、failureStreak 只 +1；无 `crawlRunId` 的旧路径不变。
4. 工具声明守卫：`crawl4aiRenderTool.transientResultScopes` 只含关闭集合成员（配置/回归测试）。
5. `gctl check` + PR 必需检查；自审（四维度审查）后合并。

## 8. 风险与开放问题

- 瞬态执行意味着原始页面不可回放：选择器调试需重新抓取（公开页面，成本低）。若未来需要平台 artifact 存储（回放/审计），按 §9 决策点 D-a 单独立项。
- `sanctions-download/v1` 仍处于「平台作用域恒 hold」（`PLATFORM_HELD_ARTIFACT_SCHEMAS`）——制裁名单刷新 schedule 目前 paused，未受影响；解冻前需要同类方案（不在本 PR 范围，记入开放问题）。
- 渠道页 HTML 仍可能含个人数据（参展商联系人）；瞬态执行不落副本，记录池联系人字段按 `OWNER-DECISION-2026-11-05`（明文，列注释 `PII_PENDING_ENCRYPTION`）——口径不变。
- `records_found=0` 的失败页在 `failureStreak` 上计为失败一轮（现状语义）；修复后成功轮会把它归零。

## 9. 决策点（请产品负责人确认）

- **D-a 缺陷 A 方案**：采用「瞬态结果作用域（不持久化 artifact）」，而不是「平台 artifact 持久化 + 无主体擦除策略」。（推荐：是；后者留作未来独立立项）
- **D-b 作用域命名与闭集**：`platform_channel_crawl`，关闭集合（新增需改代码评审）。（推荐：是）
- **D-c finalize 幂等语义**：同 `crawl_run_id` 重试 → 更新收敛、不重复推进 failureStreak。（推荐：是）
- **D-d 验收**：修复合并发车后重跑 ProPak Asia preview（两次）作为验收。（推荐：是）

## 10. 联网研究结论（§0.6 ③；2026-11-06）

- **Temporal 活动是 at-least-once**：文档明确「Activities must be designed to be idempotent」，推荐用工作流 Run ID + Activity ID 组成幂等键、由下游以唯一约束吸收重试（<https://docs.temporal.io/activity-definition>）；错误处理最佳实践（非可重试错误、重试策略）（<https://docs.temporal.io/develop/python/best-practices/error-handling>）。→ **借**：finalize 以 `crawl_run_id` 唯一键收敛即该模式的直接应用。
- **爬虫原始内容存储的两种流派**：raw-first（WARC 归档，`revisit` 记录以摘要去重，Browsertrix #884 <https://github.com/webrecorder/browsertrix-crawler/issues/884>；存储成本对比 <https://finedata.ai/blog/parse-at-fetch-vs-store-raw-html/>）vs parse-at-fetch（不存原始页，只留解析结果）。取舍取决于回放需求与重抓成本；我们的渠道页公开可重抓、记录已带 provenance → **避** raw-first 的存储负担，选 parse-at-fetch（瞬态）。
- **缓存与可擦除性**：Article 29 WP Opinion 1/2008（搜索缓存部分）——内容超出「技术可用性」所需时长仍保留个人数据，构成独立再发布、缓存运营者成为控制者并须响应擦除（<http://www.statewatch.org/media/documents/news/2008/apr/wp-29-search.pdf>；EDPB Guidelines 5/2019 相关讨论 <https://www.edpb.europa.eu/sites/default/files/webform/public_consultation_reply/guideline_5_2019_comments_edpb_final.pdf>）。→ **避**：不为平台渠道页新增无主体、无法按数据主体擦除的原始副本；瞬态执行与既有 24h 主体绑定 artifact（租户路径）区分。
- 结论（借/集/建/避）：借 Temporal 幂等键模式；集（无现成平台 artifact 方案可集）；自建「工具声明 + 作用域 + broker 校验」的瞬态执行（改动面最小且默认路径零变化）；避在平台作用域持久化无主体个人数据副本。

## 11. 给产品负责人的说明

- **得到什么**：渠道抓取真正出网取数（验收可过）；`source_channel_run.crawl_run_id` 落库、finalize 重试幂等；租户数据路径与 G3 主体绑定契约零变化。
- **没改什么**：无 schema 迁移；不改收据/工作流契约、Grant/R4 链、egress fence、物化逻辑、gain-saas；`sanctions-download` 的平台 hold 维持现状。
- **风险与回退**：瞬态执行不保留原始页面（重抓成本低）；回退 = 镜像回滚，数据向前兼容。
- **建议**：批准 D-a~D-d 后按 §7 TDD 施工，一个 PR 合入，随后发车并重跑 ProPak preview 验收。
