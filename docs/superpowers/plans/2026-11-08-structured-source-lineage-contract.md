# 结构化数据源受治理血缘合同（lineage v3）· 落地设计（DRAFT）

> 生命周期：`DRAFT`
> 依据：执行计划 §0.2 步2 的第③④步被血缘闸门阻塞（证据见
> `docs/evidence/2026-11-08-m0-step2-source-enablement.md`）；缺口是 2026-10-11 lineage gate
> （changelog「Never plan or route a discovery source without governed lineage」）显式推迟的
> 「给 wikidata / openstreetmap / ted / openfda 补受治理血缘（lineage 合同升级，含迁移）」。
> 本设计待产品负责人过目；批准后改 `APPROVED`，落地后改 `CLOSED`。

## 1. 背景与目标

- **目标**：让 wikidata / openstreetmap / ted / openfda 四个免费结构化源通过 §0.2 步2 的
  四步仪式真正进入发现供给——planner 可规划、执行器可路由、公司物化可准入（`CanonicalCompany`
  血缘回执齐备）。
- **非目标**：不改发现编排语义（Phase 2b 已定稿）；不新增数据源；不改变 public_web / directory /
  trade_fair 的现有行为；不引入付费源；不动预算/账本语义（四源均为 0 成本）。

## 2. 承重假设

1. **回执可得**：ToolBroker 结算已产出 `DurableExecutionReceipt`（`tool-broker.ts` 的
   `ctx.onDurableReceipt` 回调；四个结构化工具 `wikidata.sparql` / `osm.overpass` / `ted.search` /
   `openfda.search` 都有 `durableResultStrategy: typed_projection`）。现有 tradefair / public_web /
   directory 的血缘回执走同一机制。
2. **归因可构造**：四源每条记录都能归因到具体 tool 调用——SPARQL / Overpass / TED / openFDA 均单次
   调用返回本查询全部记录，`recordIndexes` 可覆盖全体；若未来分页/多调用，按调用覆盖子集。
3. **合同可升级**：合同哈希钉在 SQL 函数里（见 §3），可用新迁移替换函数体；部署按既有「带迁移的
   切换走无 run 硬窗口」纪律执行，不需要回写历史回执。

## 3. 触点与数据模型

| 触点 | 改动 |
| --- | --- |
| `apps/api/src/discovery/company-discovery-lineage.ts` | `DiscoveryCompanyLineageProviderKey` 并集加 4 键；`PROVIDER_RECEIPT_CONTRACT` 加 4 条（producerId = 工具 id，resultSchema = 工具投影 schema：`wikidata-sparql/v1`、`osm-overpass/v1`、`ted-search/v1`、`openfda-search/v1`） |
| `apps/api/src/discovery/discovery-query-governed-lineage.ts` | `PROVIDER_CONTRACT` 加 4 条（consumer/classes 如实填写）；`LINEAGE_DESCRIPTOR.providerContracts` 同步 → `DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256` 变化 |
| `packages/db/prisma/migrations/<new>_discovery_query_lineage_contract_v3/migration.sql` | `CREATE OR REPLACE` `append_discovery_query_lineage_v2` / `attest_discovery_query_lineage_v2`（及 v1 的 attest 复查路径），把钉死的 `eb5f6f09…` 换成新哈希；无数据回写 |
| `apps/api/src/durable-results/domain-ack-consumer-bindings.ts` | `DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 加 4 条（`domainAggregateType: RawSourceRecord`，`identity: run-provider-operation-result-digest`，resultSchema 同上） |
| `apps/api/src/temporal/discovery.activities.ts:707` | `DISCOVERY_DOMAIN_ACK_PRODUCERS` 补 `ted.search`（其余三个已在集合内）——**该文件正由整改会话在飞，排期需协调** |
| 四个 provider（`wikidata.provider.ts` / `osm.provider.ts` / `ted.provider.ts` / `openfda.provider.ts`） | `readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1`；接线 `ctx.onDurableReceipt` 收集器；`buildDiscoveryCompanyResultLineage({ providerKey, recordCount, observations })` 写入 `DiscoveryResult.lineage`（与 `trade-fair.provider.ts` 同模式） |
| 测试 | `provider.registry.spec.ts` 的血缘/路由断言；`company-discovery-lineage` 与 `discovery-query-governed-lineage` 合同测试；迁移函数 spec；四个 provider 的 collector 单测 |

## 4. 接口/事件契约

- 查询回执 schema（`discovery-query-receipt/v1`）与命令 schema（`discovery-query-lineage-command/v2`）
  **不变**；变化仅为合同对象内容及其哈希（`providerContracts` 进哈希）。
- 每条 `raw_source_record`（ACCEPTED）必须落在某条 `receiptCoverage` 的 `recordIndexes` 内；
  调用了但没有回执的 observation 使整条血缘作废（既有规则），调用失败可证明的记 `failed` 并排除。
- TED/openFDA 的查询仍只由 ICP 冷路径确定性生成（`SYSTEM_PLANNED_SOURCE_KEYS` 不变）。

## 5. 幂等与重试

- 回执/血缘按 `queryKey`（runId+planId+queryOrdinal+query 摘要）与 operationKey 幂等；合同哈希变更
  只影响新写入，重放读既有行（硬窗口保证无在飞旧哈希 run）。
- provider 的 fail-safe 不变：单源失败返回空记录；但**血缘完整性的失败不得被吞**（沿用
  `buildDiscoveryCompanyResultLineage` 的作废语义 → `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`）。

## 6. 权限与合规（RLS/DSR）

- 四源许可不变：wikidata CC0；OSM ODbL（署名+同源共享，provider provenance 已带）；TED CC BY 4.0
  （逐条 license 字段）；openFDA CC0（「注册≠核准」文案红线）。TED/openFDA 具名联系人维持结构性排除。
- `source_policy` 五域均 `APPROVED`/`REVIEWED_OK`（2026-11-08 核对，无需新增行）。
- 无新增 PII 存储面；不改变 DSR 路径。

## 7. 预算与成本

- 四源上游 0 成本；tool 结算收据 cost=0；`usage_ledger` / `cost_ledger` 语义不变。
- 发现 run 成本仍由 LLM 阶段（词表归一/判站/fit）决定，不受本升级影响。

## 8. 迁移与回滚

- 迁移：纯函数替换（`CREATE OR REPLACE FUNCTION`），**无数据回写**；旧哈希行只读保留，供历史重放
  审计（新代码不再写旧哈希）。
- 部署：带迁移的切换必须无 run 硬窗口（既有纪律）；与 `ted.search` producer 集一行的代码变更同车。
- 回滚：revert PR + 反向迁移（重建旧哈希函数体，可从 git 历史取旧 `migration.sql`）。四源在
  `data_provider` 仍为 DISABLED，回滚不改运行供给面（零风险面）。

## 9. 测试与 TDD 步骤

1. **RED**：`provider.registry.spec.ts` 期望四源 `hasCompanyLineage=true` 且进入 routed 列表——现失败。
2. 双合同键添加 → 合同一致性测试绿（该 spec 逐源断言「声明⇔两份合同都收」）。
3. 新迁移函数的 spec：函数体含新哈希、旧哈希被拒。
4. 四 provider collector 单测：
   - 单调用多记录 → `receiptCoverage` 覆盖全部索引；
   - 调用失败（可证明）→ `failed` observation，无回执但血缘有效；
   - 无回执但 invoked → 血缘作废（负向）。
5. 真库有界冒烟：直接 `executeQuery`（source_hint=wikidata/openstreetmap/ted/openfda，各 1 条查询）
   + `canonicalizeRun`，3–5 家；复用 `apps/api/scripts/verify-*-discovery.mts` 的 Tier 1/2 模式
   （其 Tier 2 在血缘闸门下已过时，升级后恢复可用）。
6. 四步仪式第③④步：翻 `data_provider.status`，dev mini-run 验证 perSource 非零供给与 planner 覆盖。

## 10. 风险与开放问题

- **前置缺陷（openFDA 专属）**：`openfda-search/v1` 投影 `maxItems: 12` 与 provider 的
  「`max(query.limit, 50)` 条」取数口径冲突，真实响应必被拒（2026-11-08 真测证据见
  `docs/evidence/2026-11-08-m0-step2-source-enablement.md` §2/§4.4）。openFDA 的第③④步需先修投影
  上界（或工具按 12 截断）并补真实形状测试；与血缘升级互不阻塞，可同批或先修。
- **OSM 上游可用性待重测**：2026-11-08 三个 Overpass 端点均不可用，第②步未过。

- **R1 硬窗口**：合同哈希变更要求部署时无在飞 run（迁移纪律已有）。若无法拿到窗口，需先上「双哈希
  并存」兼容迁移（复杂度上升，不推荐）。
- **R2 绑定列表**：同一 tool id 已被其他域消费（`ted.search`→TenderEvidence、`osm.overpass`→
  LocationEvidence、`wikidata.sparql`→TaxonomyEvidence）。发现域用独立的
  `DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 列表规避 producerId 唯一绑定冲突——设计**不得**把两个
  列表合并；未来若合并需按 (producerId, aggregate) 复合键重构。
- **R3 查询来源**：wikidata/openstreetmap 由 planner 模型写查询（planner 指南已含两源）；ted/openfda
  由冷路径生成（依赖 ICP→CPV/FDA 映射，已有实现）。
- **D1（开放决策）**：v2 就地换哈希 vs 升 v3 命令版本。推荐就地（v2 命令字段不变，v3 会牵动
  repository/DB 函数/回执四面且无额外可验证性）。
- **D2（开放决策）**：OSM 现在一次工具调用提交全部标签；若未来逐标签拆调用，覆盖索引按子调用映射。
  本期按单调用实现。
- **D3（排期）**：与整改会话 acq-remediation 的 `discovery.activities.ts` 工作排序；建议在其 B 批
  合并后施工，避免双写者。

## 11. 给产品负责人的说明

- **得到什么**：四个免费结构化源（Wikidata 公司库、OSM 产业地理、TED 欧盟中标、openFDA 器械注册）
  真正进入发现供给，计划层与执行层自动生效；M0 步2 的第③④步可完成。
- **没改什么**：现有三个血缘源的供给、预算/账本语义、合规姿态（许可、PII 隔离）都不变；不动任何
  在飞工作流的合同版本。
- **风险与回退**：需要一次带迁移的无 run 硬窗口；回退 = revert PR + 反向迁移，四源在
  `data_provider` 仍保持 DISABLED，运行面零变化。
- **建议**：批准本设计后，等整改会话 B 批合并再施工；先 dev mini-run 验收，再随发车带上。
