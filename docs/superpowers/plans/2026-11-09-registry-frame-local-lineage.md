# registry_frame 的 local_query 血缘变体（ch03 T3-09 执行面设计）

> 生命周期：`DRAFT`
> 依据：GainOS v3.0 第 3 章（召回与枚举）T3-09 执行面被 2026-11-08 收紧的 governed-lineage 契约挡住（见 §1 证据）；本文件提请产品负责人拍板后才进入施工。C 面（注册与路由，PR #918 后继）不含执行。

## 1. 问题与证据（为什么 T3-09 执行面需要先改契约）

`registry_frame` 是**零出网本地查询**（读 `registry_entity` 平台表）。但当前 discovery 执行器恒以 governed-lineage 模式运行：

- `apps/api/src/temporal/discovery.workflow.ts` 恒传 `queryReceiptMode: DISCOVERY_QUERY_RECEIPT_MODE` → `executeQuery` 的 `lineageLookup` 非空 → `buildGovernedDiscoveryQueryExecutionPlan` 走 `governed` 分支。
- 路由闸门：`provider.registry.ts#routeCompanyDiscovery` 只放行 `declaresDiscoveryCompanyLineage(adapter)`（`company-discovery-lineage.ts`）的适配器；计划期同口径计数 `SOURCE_LINEAGE_UNAVAILABLE`。
- 血缘契约是**封闭且回执绑定**的：
  - `company-discovery-lineage.ts` 的 `PROVIDER_RECEIPT_CONTRACT` 是 `satisfies Record<DiscoveryCompanyLineageProviderKey, …>`，7 个 key 各自绑定 producerId/resultSchema；
  - `parseDiscoveryCompanyResultLineage` 要求 `receiptCoverage` 逐条覆盖 `recordCount`（`covered.size !== recordCount → invalid`）；
  - 回执本身来自 durable-results 服务（模型网关 / ToolBroker 结算），带 authority/account/resultDigest 绑定。

本地 SQL 没有物理调用，产不出 durable 回执 → 按现行契约 `registry_frame` 永远无法通过物化准入。这是契约缺口，不是实现缺陷。

## 2. 方案：`local_query` 血缘变体

给血缘契约增加一种**显式的本地确定性来源**，不伪造物理回执、不绕过物化准入：

### 2.1 定义

- **provider key**：`registry_frame`（已注册，`classes=['company_registry']`，默认 `data_provider.status=DISABLED`）。
- **producer id**：`registry.query`；**resultSchema**：`registry-query/v1`。
- **lineage schema**：复用 `discovery-company-result-lineage/v1` 的**结构**，但该 provider 的 `attemptReceipts`/`receiptCoverage` 指向一条 **local operation receipt**（见 2.2），而不是模型/工具回执。
- **operation identity**：`operationId = sha256("registry.query:v1" + workspaceId + runId + queryKey)`（确定性；同 run 同查询重复执行得到同一 id）。
- **resultDigest**：按 `(scheme, reg_number, content_hash, last_snapshot_id)` 字典序序列化后 sha256，附 filters 规范串与涉及的 frame 快照 id 集合——即「本次查询命中的实体集」的规范哈希。审计方可用同一 snapshot + filters 重算并比对。
- **时间语义**：操作无物理副作用，`settled` 恒为确定成功；失败仅来自本地 DB 读失败（按普通 provider 失败处理，不产生回执）。

### 2.2 回执形状

新增 `LocalQueryExecutionReceipt`（durable-results 的窄变体）：

- `authorityId/accountId`：沿用 run 的 execution budget binding（成本恒 0，但保留归属与审计键）；
- `operationId`：2.1 的确定性 id；
- `resultDigest`：2.1 的实体集哈希；
- `recordCount`：本次结果条数；
- 不含物理调用字段（无 gateway/tool 结算信息）。
- **只允许 `registry.query` 一个 producer** 创建该变体（注册表 + 类型双重约束），防止其他 provider 借道伪造「本地回执」。

### 2.3 治理登记（增量改动清单）

1. `company-discovery-lineage.ts`：`PROVIDER_RECEIPT_CONTRACT` 增加 `registry_frame: { producerId: 'registry.query', resultSchema: 'registry-query/v1' }`；`DiscoveryCompanyLineageProviderKey` 联合加 `registry_frame`。
2. `parseDiscoveryCompanyResultLineage`：接受 local receipt 变体（按 provider 白名单分流），**其他 provider 仍走原严格校验**。
3. durable-results：定义 `LocalQueryExecutionReceipt` 类型与 `parse` 校验；仅 `registry.query` producer 可构造（编译期 + 运行时白名单）。
4. domain-ack：`DISCOVERY_DOMAIN_ACK_PRODUCERS` 增加 `registry.query`；`discovery-query-governed-lineage.ts` 的 `PROVIDER_CONTRACT`（源类校验、domainAckKey `runId:providerKey:operationId`）加 `registry_frame`。
5. governed plan：`buildGovernedDiscoveryQueryExecutionPlan` 对 local provider 只要求 1 条 receipt 覆盖全 records（recordIndexes 0..N-1）；其余 provider 不变。
6. provider 适配器：`registry-frame.provider.ts` 声明 `companyResultLineage`，在 `discoverCompanies` 内构造 local receipt 并经 `ctx.onDurableReceipt('registry.query', receipt)` 报送。
7. 物化/raw 落库：沿用现管线（`applyDomainAckConsumerTransactions` 的 receipt 校验对 local 变体放行）。
8. 治理面：`provider-registry.json` 的 `call_gates` 增补 `governed_local_lineage`；`docs/governance` 的相关 schema（如有枚举）同步。

### 2.4 回放与审计语义

- **回放**：workflow/activity 重试时，`attestQueryLineageV2` 依据确定性 operationId 判定 `REPLAYED`，直接返回首次结果——语义等同物理回执的重放保护；结果只依赖 (snapshot, filters)，天然幂等。
- **审计**：任何人事后可按报告记录的 snapshotId + filters 从 `registry_entity` 重算 resultDigest，验证「回执 ↔ 数据」一致；这比物理回执更强（物理回执只能证明调用发生过，不能证明结果正确）。
- **血缘声明**：lineage 里明示 `locality: 'LOCAL_QUERY'`（新增字段），报告与运营台能把「本地枚举」与「外网取证」区分开，不回混淆「受治理血缘」的含义。

### 2.5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 借 local 变体伪造血缘（其他源假装本地） | producer/类型/白名单三处闭锁：只有 `registry.query` 能构造 local receipt；parse 按 providerKey 只接受对应 producer |
| resultDigest 与真实数据不一致（bug 或篡改） | digest 可从 DB + snapshot 重算；CI 增加「重算一致」postgres 测试；审计时抽样复核 |
| 契约放宽后血缘语义被稀释 | lineage 显式 `locality` 字段；governed plan 对 local provider 单独分支，普通 provider 校验零放宽 |
| 物化拿不到 receipt 的老行为 | 该 provider 默认 DISABLED + 单独 env 开关 `REGISTRY_FRAME_PROVIDER=off|shadow|on`，先 shadow（只算不落）再 on |
| DB 读数百万级拖慢查询 | 沿用 query.ts 的 limit 帽（≤2000）与索引；超帽截断计入 receipt 元数据 |

### 2.6 回退

- 代码：`REGISTRY_FRAME_PROVIDER=off`（默认）即回到今天行为（注册但不可执行）；契约增量全部 additive，不改变既有 7 个 provider 的校验路径。
- 数据：本地回执可按 operationId 精确删除/重放；不触碰既有表结构。

## 3. 验收（获批后）

1. 单测：local receipt 只允许 `registry.query` 构造；parse 对既有 7 provider 行为不变（现有 spec 全绿）；governed plan 接受 1 receipt 覆盖 N 记录。
2. 真库：shadow 模式跑 1 个 workspace 的小 run（≤3 查询），核对 resultDigest 可从 DB 重算一致、receipt 重放幂等。
3. 血缘报告：运营台/报告能区分 LOCAL_QUERY 与外网取证。
4. 回退演练：开关 off 后 run 行为与今天一致。

## 4. 工作量与依赖

约 3–5 人日（契约改动 2 天 + 适配器接线 1 天 + 真库/回放验证 1–2 天）。依赖：产品负责人对本设计的明确批准（AGENTS §5 架构方向变更）；无需新迁移、无 Copy 绑定文件变更。

## 5. 与本章其他卡片的边界

- 本设计**不**改变 raw/canonical 物化契约的既有语义，也不放宽任何物理源的校验。
- T3-05（FR diffusionCommerciale 过滤）与本设计并行且独立；本设计合入前 T3-09 保持「注册但不可执行」（C 面，已含测试钉死 `SOURCE_LINEAGE_UNAVAILABLE`）。
