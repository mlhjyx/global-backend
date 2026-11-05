# Q33② discovery run 总池硬闸门（DISCOVERY_RUN_POOL_CAP）· 落地设计文档（2026-11-05）

> 生命周期：`DRAFT`
> 生命周期依据：承 `2026-11-05-cheap-first-provider-routing.md` §11 自审核正（PR #819：`QUICK_SCAN_POOL_LIMIT` 是消费侧上限，不是物化闸门；`DISCOVERY_RUN_POOL_CAP`/`POOL_CAP_REACHED` 未实现、另行排期）与本任务定义；待产品负责人批准后转 `APPROVED` 并进入 TDD。
> 任务启动门（计划 §0.6）：① 设计文档 ② 闭环设计 ③ 联网研究（§7）→ 产品负责人过目批准 → 开工。

## 1. 背景与目标

Q33② 的验收口径包含「public_web 把总池补到 500」。cheap-first 设计 §4.3/§4.4 要求 run 总池帽 `DISCOVERY_RUN_POOL_CAP`（默认 500）与 `POOL_CAP_REACHED` 语义；PR #819（执行层）只落地了「每源查询预算 ≈ 公司帽」的等价物，总池帽经自审核正确认**从未实现**：`QUICK_SCAN_POOL_LIMIT=500` 只是 quick-scan 消费侧的 take 上限（`discovery.run2.activities.ts`），不约束发现阶段的抓取与物化。

目标：**单个 run 无论源配比如何，公司物化总量不超过 `DISCOVERY_RUN_POOL_CAP`（默认 500）**；达到闸门时有可审计观测；env 可一键回退。

## 2. 现状与触点（已核对 2026-11-05，main `adf3feb4`）

| 环节 | 位置 | 现状（与闸门相关的事实） |
| --- | --- | --- |
| 查询执行 | `temporal/discovery.activities.ts:902` `executeQuery` | 查询期只写 raw / `discovery_query_operation_attempt` / `discovery_query_attempt_item` / 查询收据；**不建 canonical 公司** |
| 工作流阶段 | `temporal/discovery.workflow.ts:528-531` | 全部查询跑完后才进入 `canonicalize`：`query stage → canonicalizeRun`；run2 快扫在其后消费**全工作区**公司池 |
| 物化入口 | `temporal/discovery-company-materialization.ts:565` `executeDiscoveryCompanyMaterialization` | 新 run 全部 `GOVERNED_C_TX`（`discovery.service.ts:157` 写 `materialization_contract_version`）；`LEGACY` 只服务契约前历史 run 的重放 |
| 物化批 | 同上 `:326` `materializeLockedDiscoveryCompanyBatch` + DB 函数 `append_discovery_company_materialization_batch_v1` | 按 `query_ordinal` 顺序逐查询、每批 ≤128 项；append 严格校验 batch item set 与 attempt item 完全一致（`itemSetSha256`），**每行必须落一个 outcome，不能静默丢行** |
| outcome 契约 | `discovery_company_materialization_outcome` 表 | `NOT_CANONICALIZABLE` 的 `not_canonicalizable_reason_code` 受 CHECK 约束，现仅 `MISSING_NAME`/`NON_PRODUCT_PROVENANCE`/`COMPANY_IDENTITY_INVALID` |
| run 池口径 | `discovery.activities.ts:2830`（`discoverRunContacts`） | 「run 物化的公司」= 本 run `CANONICALIZED` outcomes 的 distinct `canonical_company_id`；下游按此消费 |
| 观测 | run stats（`workflow.ts:962`）+ `run_event`（`discovery/run2/run-events.ts` `appendRunEvent`） | stats 由工作流汇总；run_event 由 run2 活动在事务内追加；canonicalize 目前不写 run_event |
| 消费侧上限 | `discovery/run2/quick-scan.ts:14` `QUICK_SCAN_POOL_LIMIT=500` | 只限 quick-scan 从全工作区池取多少家；与本闸门无关（§11 已更正） |

由事实推出的落点约束：

1. **查询期做不了「已物化数」闸门**：物化发生在全部查询之后，查询期该计数恒为 0（§4.3 的「查询前计数」在当前架构下不成立）。
2. **闸门只能落在物化期**：在物化批内按 run 统计已入池公司数，达界时把「会新增公司」的行改成显式跳过 outcome；这与 §11 的裁定（另有「物化期闸门」选项）一致。
3. 跳过必须走既有 outcome 契约的表达（每行有归宿、带原因），不能靠丢弃 item。

## 3. 承重假设（可证伪）

1. 「run 池」口径与下游一致：distinct `canonical_company_id`（本 run `CANONICALIZED` outcomes，含 CREATED/UPDATED/LINKED/REUSED 四种 mutation）即 quick-scan/联系人阶段眼里的 run 贡献；若下游改按别的口径消费，闸门口径要跟着改。
2. 新 run 的公司只从 governed 物化批产生（legacy 路径只服务契约前历史 run），因此闸门放进物化批即可覆盖全量。
3. 闸门决策只依赖**已提交的 DB 状态 + 批内顺序**：Temporal 重试时从 inspect 续跑，批次事务全有或全无；已提交批次的 item 带 `exactExistingOutcome` 原样重放，不会被重新裁定——决策可确定性重算。
4. 每批一次 `DISTINCT` 查询（走 `(workspace_id, run_id, ...)` 索引前缀）在「≤64 查询 × 每查询 ≤2 批」的量级可接受（≤128 次/run，单次 ≤ 数千行）。

## 4. 设计

### 4.1 闸门落点：governed 物化批内的写前判定

- 在 `executeDiscoveryCompanyMaterialization` 进入 `BATCH` 时，同一事务内：
  1. **seed**：`SELECT DISTINCT canonical_company_id FROM discovery_company_materialization_outcome WHERE workspace_id AND run_id AND outcome='CANONICALIZED'`（走 `withWorkspace`，RLS 作用域）。
  2. 逐候选处理，在**确定要写 canonical 之前**（三个分支：`reusableIdentity` 复用、`identityLink` 已存在、按 dedupeKey upsert 新/旧公司）查闸门：
     - 该 `canonical_company_id` 已在 run 池 → 放行（不增长，只是重复命中）；
     - 会新增公司（新建，或首次入池的既有全局公司）且池已达 `cap` → **跳过**：该行落 `NOT_CANONICALIZABLE` + `not_canonicalizable_reason_code='RUN_POOL_CAP_REACHED'`，不写 canonical/identity_link/evidence；
     - 否则放行并记入批内池集合。
  3. 跳过行的表达复用既有 outcome 契约（`companyParse` INVALID + reasonCode，与 `MISSING_NAME` 同形），append 函数逐行校验通过，`finalize_query` 计入 `outcome_not_canonicalizable_count`，**item set 不变、查询收据不变**。
- 终态优先级不变：`RESTRICTED_PROCESSING` / `SUPPRESSED` / `EXPIRED_BEFORE_CANONICALIZATION` / `RAW_QUARANTINED` / `RAW_REJECTED` / 无身份（`MISSING_NAME` 等）照旧判定，**不被改写成 cap 原因**；闸门只作用于「本来会 CANONICALIZED」的行。
- **不在 `executeQuery` 加查询期闸门**：物化数为 0（事实 1）；每源抓取量由 PR #819 的查询预算约束，本闸门是产出兜底，两者叠加而非替代。
- **LEGACY（契约前历史 run）不设闸**：历史重放必须产出与原结果一致的 outcome，否则破坏确定性。

### 4.2 计数口径与 RLS

- 口径：`count(DISTINCT canonical_company_id)`，`outcome='CANONICALIZED'`，`workspace_id + run_id` 双过滤；跳过行不计入。
- RLS：全部经 `withWorkspace`（app_user + workspace GUC）；不新增表、不做跨 run 状态，天然按租户隔离（跨租户不可见已有 RLS 保证）。

### 4.3 与 per-source 查询预算（PR #819）的叠加关系

- 规划层（#819）：结构化源每轮查询预算 ≈ 每源 ≤100 家；本闸门（执行后物化期）：run 总产出的硬上限 500 家。
- 两者独立可同时生效：预算先限「抓多少」，闸门兜底「入池多少」；`public_web` 无查询预算，因此**总池闸门是 public_web 唯一的产出口**（Q33② 的兜底配额语义）。
- 达界后 run 仍正常完成（状态不变，见 D-e），只多 stats/run_event 观测。

### 4.4 观测

- `canonicalizeRun` 返回值（仅在有跳过时新增字段，旧历史重放形状不变）：`poolCap: { cap, skipped }`。
- 工作流 stats 增 `poolCap: { cap, skipped }`（有条件合入 `workflow.ts` 的最终 stats）。
- `run_event`：在 `finalize_discovery_company_materialization_run_v1` 的**同一事务**内追加一条 `type='pool_cap_reached'`、`level='warn'`、`payload={cap, skipped}`（先查同 run 同 type 事件，保证幂等；与 run 收据同事务提交，原子）。`run-events.ts` 的类型 union 增 `pool_cap_reached`（表无枚举约束，纯 TS 类型）。
- 可审计性：outcome 行本身持久（可按 run + reason 查），stats 进 run 记录，run_event 供进度流展示。

### 4.5 配置与回退

| env | 默认 | 说明 |
| --- | --- | --- |
| `DISCOVERY_RUN_POOL_CAP` | `500` | 正整数 = 启用；`off` = 关闭；未设/非法值回退 500（失败方向取「仍然设闸」） |

- 回退：`DISCOVERY_RUN_POOL_CAP=off` + 重启 worker（纯代码路径 kill switch），新 run 行为与现状完全一致；镜像回滚也可用上一 digest。
- 迁移只**放宽** CHECK 约束（加一个 reason code 值），对旧代码无影响，回滚无需回滚迁移。
- 部署窗口注意：跨版本时正在物化的 run，已落库的跳过行在旧代码重算批次时会产生不同 item set → 既有 `DOMAIN_ACK_..._CONFLICT` fail-closed 保护；切换时避免在飞 run（与既有发布纪律一致），必要时重跑该 run。

### 4.6 性能

- 每批一次 `DISTINCT` 查询（索引前缀 `(workspace_id, run_id)`），最坏 ≤128 次/run；v2 如需再优化可用查询收据聚合列或 run 级计数缓存，本期不做。

### 4.7 边界语义（验收对照）

| 场景 | 期望 |
| --- | --- |
| 恰好 cap | 第 cap 家放行；第 cap+1 家起跳过（`RUN_POOL_CAP_REACHED`） |
| 跨查询累计 | 查询 1 物化 N 家，查询 2 从 N 起算，总量仍 ≤ cap |
| public_web 与结构化源混合 | 同一口径累计，无论 provider；已入池公司重复命中不增长、不跳过 |
| 同批同 dedupeKey | 第一行算新增；第二行命中批内已建公司，不重复计数 |
| SUPPRESSED/RESTRICTED/EXPIRED/隔离/拒收/无身份 | 既有终态，不被 cap 改写 |
| env=off | 不设闸，行为与现状一致 |

## 5. 闭环设计（§0.6 ②）

- **SoR**：物化 outcome（引擎，run 内）；run stats / run_event（引擎观测）；gain-saas 归因无需改动（per-provider companies 仍准确）。
- **事件**：不新增公共事件；`DiscoveryRunCompleted` 载荷不变；run_event 只加一种内部类型。
- **端到端演示**（真库 postgres spec）：构造 >500 家可物化的 run（跨 2 个查询、混合 provider）→ `canonicalizeRun` → 500 家 `CANONICALIZED`、其余 `NOT_CANONICALIZABLE/RUN_POOL_CAP_REACHED`；stats 与 run_event 可查；同一 run 在 env=off 下全量物化。
- **负向**：达界跳过留痕且不破坏收据；重放不重复计；终态优先级不被改写；跨租户不可见（RLS）。

## 6. 测试与 TDD 步骤（先红后绿）

1. 新模块 `discovery/run-pool-cap.ts`（env 解析 + 批内闸门纯逻辑）单测：默认 500、`off`、非法值回退、恰好 cap 边界、dedupe。
2. 物化批接线单测（mock tx，沿用 `discovery.activities.spec.ts` 的 `$queryRaw` 分派模式）：达界跳过、已入池放行、终态优先级、REPLAYED 路径不变；同步补齐既有用例的 seed 查询 mock。
3. 真库 postgres spec（env 门控，沿用 activation spec 的脚手架：`prisma migrate deploy` + owner SQL 构造 governed 行）：500 边界、跨查询累计、混合源、stats、run_event、env=off。
4. 工作流 stats 形状单测（有条件字段）。
5. `gctl check` 全绿 → 自审 → PR。

## 7. 联网研究（§0.6 ③；2026-11-05）

- **per-run 预算帽实践**（n8n 预算文）：给每次 run 设上限（行数/调用数），**被截断的 run 必须能与完整 run 区分**，并留下停止点与剩余量；预算要用下游 mock 先验证。
- **ETL 行帽与跳过核算**（lumnik / 137foundry / datadriven.io）：每行必须有归宿（写入 / 跳过 / 隔离）并带原因，静默丢弃是错误；按 run 的记录核算（in/out/skipped/errored）是可观测性的基本盘。
- **重放与幂等**（DLQ redrive 实践）：批量重放用幂等键与尝试帽，更新记录而不删除，保留审计轨迹。
- 对我们设计的裁定：跳过必须落显式 outcome + 原因（不静默丢）；stats 必须能区分「达界」；重放确定性优先于重新决策（已提交批次不重判）——三点都直接落在 §4.1/§4.4/承重假设 3。
- 借：上面三条原则；自建：闸门本身（我们已有 outcome 契约与审计，不引外部 quota 库）；避：不照搬第三方配额服务的窗口/令牌桶模型——我们的帽是 run 级产出上限，不是速率限制。

链接：
- https://dev.to/haopengai/the-workflow-that-wouldnt-stop-spending-putting-a-budget-on-every-n8n-run-4ajf
- https://docs.lumnik.io/transparency/ingestion-honesty/
- https://137foundry.com/articles/monitoring-data-integration-pipelines-production
- https://datadriven.io/learn/py_pattern_error_handling_intermediate/section/1
- https://www.geospatialorchestration.com/resilience-failure-handling-for-gis-pipelines/dead-letter-queues-for-failed-geotasks/reprocessing-dead-letter-geotasks-safely/

## 8. 迁移与回滚

- 一个新迁移：放宽 `discovery_company_materialization_outcome_shape_check` 的 reason code 枚举（加 `RUN_POOL_CAP_REACHED`）。无表/列变更、无 `schema.prisma` 变更（Prisma 不建模 CHECK）、不触碰收据/合约 SHA。
- 回滚：env=off 立即生效（重启 worker）；迁移可保留（放宽约束对旧代码无影响）。

## 9. 风险与开放问题

| 风险 | 处置 |
| --- | --- |
| 跨版本在飞 run 重算批次冲突 | 既有 CONFLICT fail-closed 已兜底；发布窗口避免在飞 run，必要时重跑（§4.5） |
| 计数查询开销 | 每批一次、索引前缀；量级评估见 §4.6，慢则 v2 汇总 |
| 「500」口径争议（distinct 公司 vs outcome 行数） | 取 distinct 公司（与下游消费一致，D-a）；outcome 行可能多于 500 |
| LEGACY 不设闸 | 历史重放确定性优先（D-d）；新 run 全是 governed |
| quick-scan 消费侧上限 | 不动（仍是全工作区池 take 500），与本闸门无关 |

## 10. 决策点（请产品负责人确认）

- **D-a 闸门口径**：run 的 distinct 物化公司（`CANONICALIZED` outcomes 的 distinct `canonical_company_id`）≤ cap；已在池公司重复命中不计数。（推荐：是）
- **D-b 跳过表达**：复用 `NOT_CANONICALIZABLE` + 新 reason code `RUN_POOL_CAP_REACHED`（一个迁移放宽 CHECK），不新增 outcome 枚举值、不动收据合约。（推荐：是）
- **D-c 默认与开关**：默认 500 enforce；`DISCOVERY_RUN_POOL_CAP=off` 关闭；非法值回退 500。（推荐：是）
- **D-d LEGACY 范围**：契约前历史 run 不设闸，保持重放确定性。（推荐：是）
- **D-e run 状态**：达界不改 run 状态（不算 PARTIAL/FAILED），仅 stats + run_event 观测。（推荐：是）
