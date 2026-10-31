# Global 后端 · 前端/服务端接入说明

> 本文档给 SaaS 平台前端/服务端开发者，覆盖已完成 M1 阶段收口的 **Site Builder** 与已解除冻结的获客能力。任何新施工仍须按当前代码、owner、合规、成本和验收门重新选择；解冻与 M1 收口都不自动恢复旧 backlog、旧验证或实施授权。REST 契约以 `openapi/openapi.json`（code-first 导出）为准；本文只解释调用顺序，不覆盖生成契约。
>
> **统一接口门户（推荐前端入口）**：`http://<host>:3000/api/portal` —— 自托管 Scalar，一个地址浏览 + 在线调试全部端点。
> 另有 Swagger UI `http://<host>:3000/api/docs`（内部调试）。契约由 `--export-openapi` 从代码生成，代码即事实源。

## 1. 基础约定

| 项 | 约定 |
|---|---|
| Base URL | `http://<host>:3000/api/v1` |
| 认证 | `Authorization: Bearer <token>` —— token 由 **SaaS 平台侧（GrowthOS）签发**的 JWKS 签名令牌，本后端只验签并解出 `sub`（用户）、`workspace_id`（租户）、`roles`。任何环境都不接受未签名令牌；开发环境同样由本地 GrowthOS 身份源签发（ADR-024） |
| 租户 | 一切数据按 `workspace_id` 隔离（数据库 RLS 强制），前端无需传租户参数 |
| 错误模型 | 所有非 2xx 都是 `{ "error": { "code", "message", "details?" } }`；常见 code：`VALIDATION_ERROR`、`NOT_FOUND`、`INVALID_STATE`、`VERSION_CONFLICT`、`NO_APPROVED_CLAIMS`、`SUPPRESSED` |
| 统一信封 | 2xx 一律 `{ "data": ... }`；分页列表 `{ "data": [...], "page": { "next_cursor", "has_more" } }`（游标式 `?limit=&cursor=`，`next_cursor: null` = 到底）。例外：`/health*` 探针不套信封 |
| 幂等 | **仅在 OpenAPI 声明该 header 的端点**支持 `Idempotency-Key`（如 `POST /companies`、Site Builder intake/builds）；不能从通用约定推断所有 POST 已实现 |
| 乐观锁 | 可编辑对象带 `version`；PATCH 可传 `expectedVersion`，冲突返回 409 `VERSION_CONFLICT` |
| 异步 | 长任务（理解/发现/评分）返回 `202`，前端轮询对应状态端点（见下） |

### Site Builder intake · R0 契约迁移（2026-07-16）

`POST /api/v1/site-builder/intake` 是前后端正式联调前的一次 v1 契约纠偏：

- 正式客户端 **MUST** 携带可重试复用的 `idempotency-key`（1–128 位：字母、数字、`.`、`_`、`:`、`-`）。同 key + 同请求重放首个结果；同 key + 异请求返回 `409 IDEMPOTENCY_KEY_REUSED`。端点暂保留无 key 兼容，但该路径不承诺 ACK-loss 下的安全重试；若 Temporal start 已返回而 DB ACK 持久化失败，后端会保留 Site/run，客户端应先查询 workspace 站点状态，绝不能假定失败即未启动。
- 成功信封从旧 `{siteId, mode, status:"building"}` 改为 `{siteId, buildId, status:"generating_demo"}`；`mode` 已移除，`hasWebsite` 不再产生诊断分支。
- `201` 表示 demo workflow 已取得持久启动证据；随后以返回的 `buildId` 轮询 `GET /api/v1/site-builder/builds/{buildId}`。`502 DEMO_LAUNCH_UNAVAILABLE` 时必须使用**同一个 key**重试，不要换 key。
- 站点已占用且不是可原地重试的 `setup_failed` 时返回 `409 SITE_LIMIT_REACHED`；非法 key 返回 `400 INVALID_IDEMPOTENCY_KEY`。

这是已批准并落地的预接入 breaking correction；不提供旧响应双写。前端以本次生成的 OpenAPI/TS 类型为准。

## 2. Site Builder · 当前 as-built 接入顺序

> R0 contract closeout（#126）已在 #121/#123/#124 的行为与安全修复之上，补齐 intake 幂等、`buildId`、稳定错误码、Temporal 启动证据与 code-first OpenAPI。下列形状描述合并后的 as-built；后续目标契约见 `docs/site-builder/07-api-contract-draft.md`。

> **Base URL**：以下路径均包含全局版本前缀 `/api/v1`；客户端应直接使用完整路径，不要省略 `/api/v1`。

1. `POST /api/v1/site-builder/intake` 提交公司、行业、产品、目标市场、网站背景与业务邮箱。
   - 正式客户端必须携带 `Idempotency-Key`；同键同请求重放首次结果，同键异请求返回 `409 IDEMPOTENCY_KEY_REUSED`。
   - 当前返回：`{ "data": { "siteId", "buildId", "status": "generating_demo" } }`；不再返回 `mode`。
2. `GET /api/v1/site-builder/sites` 或 `GET /api/v1/site-builder/sites/{id}` 轮询站点；`status=ready` 后 `previewUrl` 可用。异步终态失败为 `setup_failed`，站点和 intake 会保留，用户可重试。
3. `GET|PATCH /api/v1/site-builder/sites/{id}/profile` 读取/分组保存建站档案。五组使用严格 schema 与 UUID ETag/CAS；PATCH 必须携带 `If-Match` 或 `baseVersionId`，不得依赖 last-write-wins。
4. 素材三步：`POST /api/v1/site-builder/sites/{id}/assets/presign` → 客户端 `PUT` 直传 → `POST /api/v1/site-builder/assets/{assetId}/commit`；随后用 `GET /api/v1/site-builder/sites/{id}/assets` 查询。删除为 `DELETE /api/v1/site-builder/assets/{assetId}`；被 Profile 或当前 active SiteSpec 引用时返回 `409 ASSET_IN_USE`，`details.usages[]` 含 `source/page/component/fieldPath`（SiteSpec 可含 `siteVersionId`）。客户端必须先替换引用再删除。
5. `GET /api/v1/site-builder/sites/{id}/kb/status` 查询文档、chunk 与资料缺口。
6. 精装修构建：`POST /api/v1/site-builder/sites/{id}/builds` 已声明可选 `idempotency-key`，返回 `{data:{buildId,status}}`；轮询 `GET /api/v1/site-builder/builds/{id}`，取消用 `POST /api/v1/site-builder/builds/{id}/cancel`。R3-B1 请求/ACK 合同见下；真实局部 scope 与增量进度仍待 R3-B2，成本真值待 R4-B-min。

### Site Builder build · R3-B1 契约（2026-07-17）

- **Breaking correction / 迁移动作**：对应 PR 必须带 `breaking-change-approved`。升级方先停止发送 page/section/targetId/pages/非 en 与非法 key，再执行 `pnpm --filter @global/contracts gen` 重新生成客户端；不得继续依赖旧 OpenAPI 中“已声明但运行时静默忽略”的字段。
- 正式客户端 **MUST** 为可重试构建携带 `idempotency-key`（1–128 位：字母、数字、`.`、`_`、`:`、`-`）。同 key + 同一规范化请求返回原 `buildId`；同 key + 异请求（包括换 Site）返回 `409 IDEMPOTENCY_KEY_REUSED`。
- `201` 只表示后端已把 Temporal `workflowId + firstExecutionRunId` 双 ID 持久化；不表示构建已经完成。`502 BUILD_LAUNCH_UNAVAILABLE` 时，只有携带原 key 的原请求可以安全重放；无 key 时先查询 build/site，不得盲目换 key 重试。
- 当前机器契约只声明 `scope:"site"`、`stylePreset:"modern-industrial"|"precision-light"` 与单一 `locales:["en"]`。合法 page/section 请求返回 `422 BUILD_SCOPE_UNAVAILABLE`；`options.pages` 或非 `en` locale 返回 `422 BUILD_OPTION_UNAVAILABLE`，不会静默整站重建。
- `targetId` 是 SiteSpec 标识符字符串（1–128 位），不是数据库 UUID。局部构建在 R3-B2 真正落地前不可用。
- 取消只有在 Temporal 执行链已关闭、不可取消补偿完成后才释放 DB active 单飞门；`502 BUILD_CANCEL_UNAVAILABLE` 表示 run 仍保持 active，客户端按同一 `buildId` 重试取消，不能据此启动新构建。若补偿因 DB 故障耗尽重试，重试会在确认执行链已关闭后 redrive 受同站锁/CAS 保护的终态事务。

**SiteSpec / DQ-1**：`@global/contracts` 导出的 `SiteSpec` 1.0.0 是 API 生产端与 Astro Renderer 的唯一共享 TypeScript 真值；前端若需要编辑/物化 Spec，应等待相应 REST 端点进入 OpenAPI，不能直接把内部类型等同于已发布 API。DQ-1 是 type-only；运行时 Zod 与 1.1.0 仍是后续。

## 3. 获客能力 · 端到端调用顺序（冻结已解除；实施仍须当前重审与明确授权）

### 阶段 0：企业理解（Understand）

> 可用性：官网抓取自 2026-08-24 起被执行授权门扣住，公司会停在 `ENRICHING`、不报错（修复中，当前情况以 `docs/status/current.md` 为准）；修复前用第 5 步手工补事实，再走第 3 步审批——公司状态仍停在 `ENRICHING`，但 ICP 设计只读已审批的 Claim 与 offerings，不受影响。

1. `POST /companies { website, name? }` → 202，后台自动：多页抓取 → 抽取事实/产品/画像/公开联系方式
2. 轮询 `GET /companies/:id` —— `status`: `DRAFT → ENRICHING → REVIEW → ACTIVE`
3. `GET /companies/:id/claims?status=NEEDS_REVIEW` → 人工审批 `POST /claims/:id/approve|reject`
   - 每条 Claim 带 `evidence[]`（来源页 URL + 原文片段 + 置信度）——**事实可溯源**
   - 审批满 3 条自动 `ACTIVE`；或 `POST /companies/:id/confirm` 显式确认
4. 辅助视图：`GET /companies/:id/completeness`、`/offerings`、`/conflicts`（知识冲突裁决 `POST /conflicts/:id/resolve`）
5. 手工补充事实：`POST /companies/:id/claims`；纠错撤销：`POST /claims/:id/revoke`

### 阶段 1：ICP（Target）

1. `POST /companies/:id/icps` → AI 生成 ICP（`HYPOTHESIS`）：属性/痛点/触发信号/排除 + 买家委员会 + **机器可评估规则 rules**
2. 人工修订：`PATCH /icps/:id`；规则增删改：`POST /icps/:id/rules`、`PATCH|DELETE /icp-rules/:ruleId`
3. 回测：`POST /icps/:id/backtests { samples: [{name, attributes, expected}] }` → 命中率指标（→ `VALIDATING`）
4. 激活：`POST /icps/:id/activate`（旧 ACTIVE 自动 `SUPERSEDED`）
5. ICP 读取 / 激活结果带 `ruleLint[]`（由规则推导、不落库）：每条否定操作符（`neq` / `not_in` / `not_contains`）的 EXCLUSION 一条提示。
   - 与某条 MUST_HAVE 同 field 同 value 的是镜像：资格门已判 Fit 时评分只记录、不排除，建议删除；
   - 其余否定型排除（如手加的 `country not_in ["DE","AT","CH"]`）资格门判 match 也照样排除，提示里请确认取值写法与公司属性一致。

### 阶段 2：发现（Discover）

1. `POST /icps/:id/query-plans` → AI 生成多源查询计划（`DRAFT`）
   - 只为当前已启用的数据源出查询，每条查询的 `filters.source_hint` 写明它执行的源；`estimatedVolume` 只计会执行的查询
   - 没有可用的已启用数据源时返回 409 `NO_ENABLED_DISCOVERY_SOURCE`（不调用模型）；模型给出的查询全落在不可用的数据源上时返回 409 `NO_RUNNABLE_QUERIES`，不保存计划
   - 模型网关结算了调用却没有可用答案时（内容被过滤、输出截断、非 JSON、流被截断等）返回 502 `MODEL_UPSTREAM_UNUSABLE`，`details.reasonCode` 为网关原因码（例如 `CHAT_COMPLETIONS_CONTENT_FILTERED`、`STRUCTURED_OUTPUT_TRUNCATED`、`CHAT_COMPLETIONS_STREAM_TRUNCATED`；网关直接回了 429 或 5xx 时为 `GATEWAY_HTTP_<状态码>`，例如 `GATEWAY_HTTP_503`），不保存计划；这次调用的预算授权已在调用前消耗并按真实用量结算，用同一授权重试会得到 409 `EXECUTION_BUDGET_GRANT_REUSED`，重试要先向 SaaS 取一份新的授权。`POST /companies/:id/icps` 同
2. 人工确认：`POST /query-plans/:id/confirm`（→ `READY`）
3. 执行：`POST /query-plans/:id/execute` → 202 `{ data: { runId, status } }`；轮询 `GET /discovery-runs/:runId`（`RUNNING → DONE|PARTIAL|FAILED`，stats 含每源计数）
   - 确认之后数据源被停用的查询会跳过，不让 run 失败：`stats.skippedQueries` 按原因计数（`SOURCE_DISABLED` / `SOURCE_LINEAGE_UNAVAILABLE` / `SOURCE_UNKNOWN`），run 判 `PARTIAL`
   - 没有受治理公司血缘的数据源（目前 `wikidata`、`openstreetmap`、`ted`、`openfda`）即使启用也不出查询、不执行；旧计划里指向它们的查询按 `SOURCE_LINEAGE_UNAVAILABLE` 跳过
   - 公司抽取的模型调用失败时（答案不可用、流被截断，或其他普通失败），只跳过那个域名或名录页，run 继续，至少判 `PARTIAL`。模型上游不可用不在此列：网关回 429 或除 504/524 以外的 5xx、或网关地址拒绝连接时，整条查询失败，见下面「查询活动」一条（连到网关超时仍按单个域名的失败跳过）。整个 run 的抽取全部失败、且没有任何记录通过时判 `FAILED`；计划保持 `READY`，但同一计划不能再执行（新授权也会得到 409 `EXECUTION_BUDGET_GRANT_REUSED`），要重跑须重新生成计划。`stats.modelExtractions` 只在有跳过时出现，含：
     - `invoked`：抽取调用次数（一次带修复的抽取算一次）；
     - `failed`：跳过次数；
     - `failedByReason`：按网关原因码计数，例如 `STRUCTURED_OUTPUT_EMPTY_TRUNCATED`、`CHAT_COMPLETIONS_STREAM_TRUNCATED`；没有网关原因码的失败记为 `MODEL_CALL_FAILED`；
     - `queriesAllFailed`：调用全部失败的查询数。大于 0 时多半是模型上游出了故障，值得人工看一下。
   - 某个操作无法重放时（已经发出、却没有持久结果，例如流在中途断开、抓到的页面没能存下），系统不会再发一次，只记一次失败：
     - 官网画像、信号富集、网站监控跳过这一家公司；
     - fit 把这一家记为未判定；
     - 查询的某个数据源在重试时遇到这种操作，这条查询就以零回执结束（回执列出该源、0 条记录，所以物化准入仍然见到每条计划查询一份回执），记为失败，计划继续往下跑。
     - 以上任何一种，run 都至少判 `PARTIAL`。其中「重试时在预留处命中旧操作」属于更早一次尝试留下的残留，任何阶段都只按跳过计数，不再升级（2026-10-28 起）；而「本次尝试自己已出网、结果却没能落库/投影/结算」（`origin=live` 的同一错误）仍是存储或账本故障的现场证据，查询、画像、信号、监控四个阶段对它在同一阶段连续两次遇到时判 `FAILED`。fit 例外：它同时判最多 3 家（`FIT_CONCURRENCY`），一次尝试失败或 worker 丢失后，重试会一起遇到当时在途的这几家留下的调用，所以 fit 里这种公司只记未判定，不算进「连续两次」；同一次尝试里连续两家的流被截断仍会让这次尝试失败。代价是：模型上游持续出那种按无结果结算的故障（504/524 超时、流截断）时，每次重试先把前面尝试留下的公司记为未判定，只有还有没调用过的公司时才会再次失败。活动余下的公司不多时（小 run 或最后一个续跑活动，约 6–9 家以内），fit 会一家没判出就正常结束，run 判 `PARTIAL` 而不是 `FAILED`，这些公司计入 `stats.unreplayableSkips.fit`。每家公司最多调用一次；这种故障里一个 run 最多约有 12 次调用按预留计费（一家一家判时是 2 次）。
     - `stats.unreplayableSkips` 只在有跳过时出现，按阶段计数：`queries`、`websiteProfile`、`fit`、`signals`、`watches`。
   - 词表归一（把查询里的行业/国家词归一到标准码）只为会读归一结果的数据源（`wikidata`、`openstreetmap`）调用模型，其余查询只查已沉淀的别名；一条查询的归一调用丢失（上游 5xx、操作无法重放）时，这条查询照常用各源内置词表执行，不算失败、不改状态。`stats.taxonomyFallback`（回退的查询数）与 `stats.taxonomyModelSkipped`（有词可归一却没有调用模型的查询数）只在大于 0 时出现。
   - 查询活动因**普通**错误（不是控制错误）用尽重试时，这条查询没有回执，run 立即停在查询阶段：判 `FAILED`，`stats.failure = { stage: 'query', errorType, control: false }`（`errorType` 是活动最后一次尝试的错误类型，不含消息），后面的查询不再执行；计划保持 `READY`，但同一计划不能再执行（见上面「公司抽取」一条）。活动最多尝试 3 次（等于预算账本对同一操作的预留上限）。失败是模型上游不可用时（网关回 429 或除 504/524 以外的 5xx，此时 `control: false`；或网关地址拒绝连接，此时按控制错误记 `control: true`），第 2 次尝试前等 5 分钟、第 3 次前等 25 分钟，所以半小时左右以内恢复的上游故障不会让 run 停；这类失败的预留已退回，等待不花钱；更长的故障照旧停在查询阶段。fit 阶段遇到同样的失败按同样的间隔重试。`stats.failures` 只计数据源在重试时遇到无法重放的操作、因而以零回执结束的查询（与 `stats.unreplayableSkips.queries` 相同）；没找到记录、或数据源被停用而以 `accepted: 0` 回执结束的查询不计，这次停止也不计。
   - 官网画像阶段遇到同样的上游不可用时，下一次尝试前等 25 分钟（这个阶段只有 2 次尝试）；仍然失败时画像阶段提前结束，fit 照常判定余下的公司（没有画像证据），run 至少判 `PARTIAL`，`stats.websiteProfile.stageFailed = true`（只在发生时出现；画像阶段因其他普通错误提前结束时同样如此）。
   - 各阶段都跑完、要以 `DONE` 或 `PARTIAL` 收尾时，如果这次 run 的授权已经结束（准入租约到期、被撤销或预算耗尽），run 改记 `FAILED`，`stats.failure = { stage: 'finalize', errorType, control: true }`。其中 `errorType` 是结束原因的代码，取 `EXECUTION_BUDGET_GRANT_EXPIRED`、`EXECUTION_BUDGET_AUTHORITY_REVOKED` 或 `EXECUTION_BUDGET_AUTHORITY_EXHAUSTED`；其余 stats 照常保留；fit 判过公司时照常请求评分。此前这种情况下 run 会一直停在 `RUNNING`。授权在更早的阶段就结束时，run 记在那一阶段（下一次核验所在的阶段），`errorType` 一般是 `ExecutionBudgetGrantError`。判断「授权已结束」请看 `control: true`，不要按 `errorType` 的写法区分。同一结果重复写入（例如收尾结果已提交但回执丢失后重试）不会再写第二次，也不会再发第二个 `DiscoveryRunCompleted`。
   - 准入租约（准入后 3 小时）快用完时，run 提前收工，不再一直跑到租约过期再判 `FAILED`。查询、官网画像、fit、富集、监控注册这几个阶段，每开始一条查询或一家公司之前，先看剩余租约够不够在收尾预留（10 分钟）之前做完这一条；不够就停下，余下的计入 `stats.skippedForLease`，run 判 `PARTIAL`，评分照常请求。
     - `stats.skippedForLease` 只在发生时出现，按阶段计数，只列有跳过的阶段：`queries`、`websiteProfile`（只计本 run 自己、还需要画像的公司）、`fit`、`enrich`（只计还有数据源没读过的公司）、`watches`。`fit`、`enrich` 和 `watches` 是上限：其中可能有本来就会因禁联等原因跳过的公司。
     - 因租约跳过的查询照常落一条零回执（`providers: []`），不带 `skipReason`，不计入 `stats.skippedQueries` 和 `stats.failures`。
     - 查询阶段因租约提前停下、且一条记录都没收到时（例如 run 在准入后很久才开始），run 判 `FAILED`：这次 run 什么都没找到。计划保持 `READY`，但同一计划不能再执行（见上面「公司抽取」一条），要重跑须重新生成计划。
     - 之后某个阶段失败、run 按 BI-25 记 `FAILED` 时，`stats.skippedForLease` 仍会带上失败之前各阶段已因租约跳过的数量。
     - 模型上游不可用时的等待（见上面「查询活动」一条），如果租约装不下「等待 + 再做一条」：fit 和官网画像就地停下，余下的按租约跳过计数；查询把下一次尝试推迟到刚过查询截止点，那次尝试以租约零回执结束。所以租约最后约半小时内遇到上游故障，结果是 `PARTIAL` 而不是 `FAILED`；最后一次尝试也失败时照旧判 `FAILED`。这样结束的查询零回执记 `costCents: 0`，之前几次尝试实际花的钱以预算账本为准。
     - 被跳过的公司不会自动补判（fit 的补判任务目前停用），被跳过的查询也不会自动重跑（`PARTIAL` 会把计划标为 `EXECUTED`）。
     - 画像的单位比 fit 长，快到期时画像先停：fit 仍可能判几家没有画像证据的公司，这些判定之后不会重判。联系路径补读打开时（开关 `company_contact`，目前停用），补读会在 fit 之前用掉一部分租约，且不计入 `skippedForLease`。
     - 信号阶段暂未按租约提前停下。它开始时剩余租约通常约 20 分钟，最少只剩收尾预留；越过租约时 run 仍记 `FAILED`，记在越过之后第一次核验所在的阶段：`signals`、`watches`、`patentEnqueue`，或按上面「各阶段都跑完」一条记在 `finalize`。
   - `stats.websiteProfile`：`profiled` / `matched` / `unclassified` 只计本 run 自己的公司；`backfilled` 是开关 `company_contact` 打开时，用本 run 剩下的画像配额补读联系路径的工作区存量公司数（不在本 run 里；这个键自评分规则 v3 跟进起才有，更早的 run 的 stats 里没有它）。补读候选里，从未尝试过的公司优先，其次是上次尝试最早的；run 创建前 7 天内尝试过的公司（不论读到与否）不补读。
4. 结果：`GET /canonical-companies`（`?status=NEW|ENRICHED|SUPPRESSED`）；详情含**字段级 Evidence**（每个字段值来自哪个源、什么许可）
   - 过了 fit 门的高价值公司自动做**多源富集**（互补并跑，均 CC0 直连数据）：
     - `attributes.gleif.*` —— 法律身份：`lei`/`legal_name`/`legal_form`/`entity_status`/`parent_name`/`ultimate_parent_name`（母子集团关系，识别目标是否某集团子公司）
     - `attributes.wikidata.*` —— 商业事实：`industries`/`products`/`employees`/`inception_year`/`parent_name`/`subsidiary_count`/`lei`/`isin`/`stock_exchange`/`headquarters`/`website`
     - 每字段带 `field_evidence`（`license=public`，`provider_key` 标来源，含 GLEIF/Wikidata 记录 URL）；两源的 `lei` 可交叉验证
5. 高价值企业按需补联系人：`POST /canonical-companies/:id/discover-contacts`；邮箱验证：`POST /contact-points/:id/verify`
6. 禁联名单：`POST|GET|DELETE /suppressions`（domain/email/company_name；即时生效）

### 阶段 3：验证评分（Qualify）

1. `POST /icps/:id/qualify` → 202，后台确定性六维评分（Fit/Role/Intent/DataQuality/Reachability/Engagement）
2. 队列视图：`GET /icps/:id/lead-queues` → `{ data: { recommended, needs_review, rejected, suppressed, sanctions_hold, scored, queueBasis } }`——`scored` 为真表示每条 lead 都有 `total_score`；`queueBasis` 按队列依据计数（`fit_gate_preset` = fit 门按 verdict 预置、评分从未跑过；`score` = 评分阶段算出；`human_accept` / `human_reject` = 人工裁决），四项之和 = lead 总数
3. 列表：`GET /leads?icpId=&queue=`（按总分排序，含公司摘要；每行带 `scored` 与 `queueBasis`，未评分的行只是 fit 门预置的队列）；详情 `GET /leads/:id` 带**逐规则评分依据**
4. 人工裁决：`POST /leads/:id/accept`（→ `QUALIFIED`，发 `LeadQualified` 集成事件——交给 GrowthOS 的出口，GrowthOS 经 `GET /events` 拉取并 `POST /events/ack` 确认）/ `POST /leads/:id/reject { reason }`
   - `LeadQualified.qualification_rule_version` 是这条 lead **实际计分时**的规则版本（评分时写进 `score_detail.ruleVersion`），不是接受那一刻服务端的规则：v3 之前计分、此后没有重评的 lead 标 `additive-6dim-v2`；从未计分的 lead 为 `null`。要按新规则交付，先对该 ICP 重新 `POST /icps/:id/qualify`。
5. 周报 CSV（`ReportController_weekly_v1`）：`GET /reports/weekly?icpId=&week=2026-W42`（`week` 缺省为本周，UTC、周一起），需要 `acquisition:read` + `acquisition:export`。
   - 返回 `text/csv`（UTF-8 带 BOM，中文表头），**不套 `{data}` 信封**；行 = 最新一条裁决是该周 accept、当前仍为 `QUALIFIED`/`CONTACTED`/`CONVERTED` 的线索（被拒后再 accept 的只出现在最后一次 accept 那一周），末尾 5 列留给客户填写。
   - 每行都写一条 `EXPORT` 判定到 `policy_decision_log`（`correlation_id` = 响应头 `X-Report-Id`）：DataRights 拒绝的（禁联 / 无证据）、制裁命中未清的（reason `sanctions_hold`）、历史合成来源的（reason `synthetic_quarantined`）都不导出，计数见 `X-Report-Withheld-Rights` / `-Sanctions` / `-Quarantined`。
   - 成本列 = 该 ICP 下物化过这家公司、且不晚于 accept 的最新一次发现 run 的账本合计；任一预算账户缺失或仍有未结预留时留空。
   - `GET /whoami` 的 `scopes` 以 `x-extensible-enum` 列出已知取值，集合会增长（如本接口的 `acquisition:export`）：客户端须容忍未列出的值，不要按封闭枚举校验。
   - 浏览器跨源读取这些响应头需要网关或 CORS 暴露它们；当前 API 的 CORS 只暴露 `Location`、`X-Request-Id`、`ETag`。

## 4. 事件（服务端集成用）

领域事件经 Transactional Outbox 发布，信封结构见 `events/envelope.schema.json`；哪些事件对外交付以 `apps/api/src/relay/event-registry.ts` 为准。对外交付的集成事件（`GET /events` 拉取 + `POST /events/ack`，配置 webhook 时另行推送）：
`LeadQualified`、`LeadsScored`、`DiscoveryRunCompleted`、`ICPActivated`、`ClaimApproved`、`ClaimRevoked`、`ClaimExpired`、
`KnowledgeConflictDetected`、`DeletionCompleted`、`SiteBuildCostSummaryUpdated`。其中 `LeadQualified`、`DeletionCompleted`、`SiteBuildCostSummaryUpdated` 有专用 payload schema（`events/payloads/`），其余走信封通用契约。
`CompanyProfileCreated`、`DiscoveryRunRequested`、`QualifyRequested`、`DeletionRequested` 等是内部命令，只用来拉起后台工作流，不对外交付。

## 5. 数据真实性说明（前端展示建议）

- **Claim = 事实**：永远带来源 URL + 原文片段，建议 UI 提供「查看原文」
- **ICP = 推断**（`HYPOTHESIS`）：建议 UI 标注「AI 生成，待回测/确认」
- 联系方式发送前必须 `VALID`（邮箱验证状态在 `contactPoints[].status`）

## 6. 模块与接口覆盖（给对接开发者的地图）

接口的权威清单永远是运行中服务的 `/api/docs-json`（门户 `http://100.68.31.20:3000/api/portal` 同源）。这里回答的是另一个问题：**后端的每个功能模块，是否都有对应的 HTTP 接口**，以及没有接口的模块从哪里取数据。

### 6.1 有完整 HTTP 接口的模块（按门户分域）

| 后端模块（`apps/api/src/`） | 门户分域 | 主要接口 |
| --- | --- | --- |
| `company/` `claim/` | Companies · Claims | 提交官网、完整度、产品、事实审批/驳回/撤销、冲突裁决 |
| `icp/` | ICP | ICP 生成/修订/激活、规则、回测、查询计划 |
| `discovery/` | Discovery | 执行查询计划、发现 run 状态、规范化公司、联系人补全、禁联名单、数据源注册表 |
| `lead/` | Leads | 六维评分、队列计数、Lead 详情/交付包、结果回写、开发信草稿、接受/拒绝、制裁复核 |
| `report/` | Reports | 周报 CSV、周报反馈 |
| `events/` | Events | 事件拉取 / ACK / ACK 状态 |
| `compliance/` | Compliance | 删除请求受理与状态（Art.17） |
| `site-builder/` | SiteBuilder | intake、向导档案、素材、知识库状态、构建、预算 quote；预览页 `GET /api/v1/preview/{slug}`（含静态资源）返回渲染后的 HTML，**不在 OpenAPI 里**（`@ApiExcludeController`，给 iframe 用），预览地址从 `GET /site-builder/sites` 的响应里取 |
| `execution-budget/` | ExecutionBudget | 工作区技术报价（服务间） |
| `platform-authority/` | PlatformAuthority | 技术报价、目标查询、撤销、fence-ack JWKS（服务间） |
| `health/` | System | 存活/就绪/构建身份/时钟 |
| `whoami/` `runtime/` | System | 身份与 scope、admitted clock |

### 6.2 没有独立 HTTP 接口的模块（设计如此）

数据不丢，只是不单独暴露接口——经由别的接口或后台工作流交付：

| 模块 | 为什么没有接口 | 数据从哪来 |
| --- | --- | --- |
| `intent/` `signals/` | 意图信号是发现与评分流程的内部产物（`signal-ingest` / `intent-recompute` 由 worker 跑，`signal-query` 是内部读服务） | 信号随交付包一起给：`GET /leads/{id}/package` 的 `signals`；发现过程的中间状态看 `GET /discovery-runs/{id}` |
| `sanctions/` | 名单刷新是后台工作流；复核在 Lead 流程里 | 命中与复核走 `POST /leads/{id}/sanctions-review`；数据源状态看 `GET /data-providers` |
| `acquisition/` | 执行/投影内部层（source adapter、租户投影、执行包络），被工作流调用 | 结果落库后经 Discovery / Leads 接口读出 |
| `ai-tasks/` `model-runtime/` `model-gateway/` | 模型路由是部署配置（env：`MODEL_ACQUISITION_*`），不是运行时 API | 运营侧改 env 后重建容器，见 RUNBOOK |
| `auth/` | 守卫与令牌校验 | 身份与权限看 `GET /whoami` |
| `relay/` `temporal/` `tools/` `durable-results/` `prisma/` `adapters/` `common/` `docs/` | 基础设施（Temporal 编排、事件 relay、工具预算、持久化） | 状态经健康探针与业务接口体现 |

### 6.3 对接时最容易踩的三件事

1. **工作区（租户）来自 JWT 的 `workspace` claim，接口不收租户参数**；跨租户一律 404。开发取 token 用 `ssh xin@100.68.31.20 /global/local-config/bin/api-token`（300 秒有效）。
2. **长任务是异步的**：`POST /companies`、`POST /query-plans/{id}/execute`、`POST /icps/{id}/qualify`、建站构建都返回 202/201 + id，轮询对应状态接口，别同步等。
3. **服务间通道不要给前端用**：ExecutionBudget / PlatformAuthority 两组用固定用途机器身份（mTLS/JWT），普通前端调用只会拿到 401/403。
