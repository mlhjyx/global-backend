# 1b 花费维度补口 · run 成本结算设计文档（2026-11-06）

> 生命周期：`APPROVED`
> 生命周期依据：协调计划 §0.2 步 3「1b 花费维度补口」+ 2026-11-04 评审结论「`$15/30 天`花费上限因 cost_ledger 恒 0 实际未生效」；产品负责人 2026-11-06 批准 D-a~D-e 推荐值开工（「批准开工（推荐）」）。
> 任务启动门（计划 §0.6）：① 设计文档（本文）② 闭环设计（§5）③ 联网研究（§9）→ 产品负责人过目批准 → TDD。

## 1. 背景与目标

现状（已核对代码，2026-11-06）：
- 引擎每次模型调用都会写 `ai_trace` 与 `usage_ledger`（`apps/api/src/model-gateway/ai-trace.sink.ts`，`resource_type='ai_tokens'`、`cost_usd` 可空、`ref_type='ai_trace'`、`ref_id=ai_trace.id`、`meta={task, model, …}`，**无 runId**）。
- run 收尾（`apps/api/src/temporal/discovery.activities.ts` 的 finalize 活动）发布的 `DiscoveryRunCompleted` 载荷只有 `{planId, status, stats, taskRef…}`，**不带成本**。
- gain-saas 事件消费者（`apps/server/src/service/event-consumer.service.ts`）的成本分支 `payload.cost ?? payload.cost_usd` 在 `DiscoveryRunCompleted` 分支**之后**，而该分支处理完直接 `return` —— 即使引擎将来带上 cost，也永远走不到 `cost_ledger.create`。
- `cost_ledger` 无唯一约束；事件消费是 at-least-once（ACK 丢失会重放）。
- 结果：`WorkspaceBudgetPolicyService` 的花费上限（窗口内 `cost_ledger` 求和）恒为 0，**`$15/30 天`只对 run 次数生效，对花费不生效**。

目标：
1. 引擎在 run 收尾时把该 run 的模型成本汇总进 `DiscoveryRunCompleted` 载荷。
2. gain-saas 消费端真正落 `cost_ledger`，且**重放不重复计费**。
3. 花费上限从「恒 0」变为真实值；不改客户价格语义（仍是平台内部配额）。

## 2. 承重假设（可证伪）

1. ~~`usage_ledger` 的 `cost_usd` 对模型调用可用~~ —— **已证伪（2026-11-06 实测）**：`usage_ledger` 中 `ref_type='ai_trace'` 共 10,769 行，`cost_usd` **全部为 NULL**（0 行 >0）。根因：`ai_trace`/`usage_ledger` 记的是 `result.usage?.costUsd`（provider 上报值），而 new-api 网关响应不带 cost；预算 settle 用的是另一条 `centsFromTokens`（token 折算）路径，没回写账本。**因此「成本基准」是本设计的前置子项（§4.0）。**
2. run 的时间窗聚合（`created_at BETWEEN run.started_at AND now()`）在「同 workspace 同一时刻只有一个 discovery run」的常规语义下精确；并发 run 会互相计入（现行产品语义：BFF 每 workspace 串行发起，见 `discovery_run_link`；风险登记 §8）。
3. `ai_trace → usage_ledger` 的异步写入（fire-and-forget + catch warn）在 finalize 时刻可能仍有极少量尾部落账（毫秒~秒级）；接受 v1 的轻微尾部误差，用 `costBasis` 字段标注口径。
4. 事件载荷加字段对消费端向后兼容（`DiscoveryRunCompleted` 无 contracts 载荷 schema；SaaS 读取是宽容的）。
5. token 折算价（`LLM_CENTS_PER_MTOK`，默认 100¢/M tok ≈ $1/M）作为花费**上界**是诚实的（该口径已在预算 settle 复审中采用，见 `router-model-gateway.ts` 注释）；花费上限用上界口径只会提前拒绝，不会少计。

## 3. 触点（已核对）

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `apps/api/src/model-gateway/ai-trace.sink.ts`（写 `ai_trace`/`usage_ledger`） | `costUsd: entry.costUsd ?? null`，provider 不报即 NULL | **§4.0 成本基准**：status OK、tokens>0 且 provider 未报 `costUsd` 时按 `LLM_CENTS_PER_MTOK` 折算写入（与预算 settle 同口径），`meta.costSource='token_estimate'`；provider 上报优先（`meta.costSource='provider'`） |
| `apps/api/src/temporal/discovery.activities.ts`（finalize 活动，outbox 事件写入处，约 :3409） | 载荷无成本 | 事务内新增聚合查询并写 `cost`（USD number）与 `costBasis` |
| `packages/contracts/events/payloads/` | 无 discovery-run-completed schema | 不改（如未来加 schema，`cost` 属于新增字段） |
| `gain-saas/apps/server/src/service/event-consumer.service.ts` | 成本分支在 `DiscoveryRunCompleted` return 之后 | 把成本落账移到事件类型分支**之前**（对所有带 `payload.cost` 的事件生效） |
| `gain-saas/apps/server/prisma/schema.prisma` + migrations | `CostLedger` 无唯一约束 | 迁移：`CREATE UNIQUE INDEX … ON cost_ledger (workspace_id, source_event_id) WHERE source_event_id IS NOT NULL`（partial，宽松兼容存量 NULL 行） |
| 消费端插入 | `costLedger.create` | 改为幂等插入（`createMany({ skipDuplicates: true })` 或 `ON CONFLICT DO NOTHING`），与事件重放对齐 |
| `WorkspaceBudgetPolicyService` | 已按窗口求和 `cost_ledger` | 不改（数据变真即生效） |

## 4. 设计

### 4.0 成本基准：给 `usage_ledger` 补上成本（前置子项，D-e）

- 位置：`apps/api/src/model-gateway/ai-trace.sink.ts`（与写入 `ai_trace`/`usage_ledger` 同一事务）。
- 规则：`status === 'OK' && tokens > 0 && entry.costUsd 非有限数` → `costUsd = tokens × LLM_CENTS_PER_MTOK / 1e6 / 100`（即复用 `centsFromTokens` 的单价与取整口径；**不覆盖 provider 上报值**）。`meta.costSource` 标注 `provider | token_estimate`。
- 为什么不引价目表：真实价目随网关渠道变动且不在此仓维护；上限场景只需要一个诚实上界，`LLM_CENTS_PER_MTOK` 已由环境可调。精确价目表/渠道结算属后续项（§8）。
- 存量 10,769 行 NULL 不回溯（历史无精确 token 价格意义有限）；积分从本项上线后开始。

### 4.1 引擎侧：run 成本汇总进事件（D-a）

在 finalize 活动的同一事务内（写 outbox 之前）：

```sql
SELECT COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
FROM usage_ledger
WHERE workspace_id = $1::uuid
  AND ref_type = 'ai_trace'
  AND created_at >= $2            -- run.created_at（DiscoveryRun 无 startedAt 字段，实现按 §7 步 1 采用 createdAt）
  AND created_at <= now()
```

- 载荷新增：`cost`（USD，number）与 `costBasis: 'usage_ledger-window/v1'`（口径标注：工作空间 + 时间窗）。
- 无成本行时 `cost: 0`（消费端 `> 0` 才记账，等价不记）。
- finalize 活动是 at-least-once：其幂等已由 run 状态机保证（重复 finalize 会被拒/返回），事件只发一次。
- 不在 finalize 之外另发「成本补发」事件；如后续发现尾部误差不可接受，再评估「先刷 ai_trace 队列再 finalize」或 runId 归属（§9 D-a 备选）。

### 4.2 SaaS 侧：真正落账且幂等（D-b/D-c）

- 把成本处理提到 `handleEvent` 的类型分支之前：

```ts
const cost = payload.cost ?? payload.cost_usd;
if (typeof cost === 'number' && cost > 0) {
  await tx.costLedger.createMany({
    data: [{ workspaceId, sourceEventId: evt.event_id, amountMicros: Math.round(cost * 1_000_000), occurredAt: new Date() }],
    skipDuplicates: true,
  });
}
```

- 迁移加 partial unique index（Postgres `CREATE UNIQUE INDEX … WHERE source_event_id IS NOT NULL`）。存量 `cost_ledger` 当前 0 行，迁移无冲突风险。
- `amountMicros` 为 `Int`（int4）：单笔上限约 $2147——单 run 成本远低于此；仍加守卫（超过则记上限并 warn？）→ v1 直接写入并依赖既有列类型（超出会报错，属极端情况，列入 §8 风险）。

### 4.3 与花费上限的关系

`WorkspaceBudgetPolicyService` 的 SPEND 检查窗口求和 `cost_ledger`；数据变真后 `$15/30 天` 自动生效，无需改该服务。注意其「enforce 开关 + 存量 26 空间豁免」不变。

## 5. 闭环设计（§0.6 ②）

- **SoR**：模型成本事实在引擎 `usage_ledger`；对外结算事件 `DiscoveryRunCompleted`（新增 `cost`/`costBasis`）；SaaS 账本 `cost_ledger`（唯一键防重放）。
- **事件**：不改事件类型、不改 schemaVersion（载荷新增字段；无 contracts schema 约束）。
- **Tool Contract**：不涉及。
- **闭环位置**：Discover run 收尾 → 事件 → SaaS 配额/花费上限。
- **端到端演示**：发一次真实 mini-run → 引擎事件载荷 `cost>0` → `cost_ledger` 出现一行且 `source_event_id` = 事件 id → 同事件重放（手动 ack 重投）不产生第二行 → `WorkspaceBudgetPolicyService.evaluate` 的 `usedSpendMicros` 非 0。
- **负向测试**：重放同一事件 → 不重复；`cost=0`/缺失 → 不落行；跨 run 窗口隔离（两个 run 时间窗不重叠时各计各的，重叠时按 §2.2 语义记录口径并测试文档化行为）；越权事件（无 workspace 的事件）不落账。

## 6. 迁移与回滚

- gain-saas 一条 additive 迁移（partial unique index）。回滚 = 镜像回滚（索引残留无害）；引擎侧纯代码。
- 部署顺序：先发 SaaS（消费端容忍 cost 字段缺失）→ 再发引擎（开始发 cost）。同班发车即可：先重启 gain-saas 再切引擎镜像（或同时，消费端对未知字段宽容）。

## 7. 测试与 TDD 步骤

0. 成本基准（§4.0）：ai-trace sink 单测——provider 上报优先、无上报且 tokens>0 时按 `LLM_CENTS_PER_MTOK` 折算、status≠OK 或 tokens=0 不折算、`meta.costSource` 标注。
1. 引擎：finalize 聚合 SQL 的 postgres spec（两个 run 各写成本行 → 各自事件只含自己窗口内的成本；`cost_usd NULL` 行被 SUM 忽略）。
2. SaaS：消费者单测——`DiscoveryRunCompleted` 且 `payload.cost>0` → `cost_ledger` 落行；同事件再次消费 → `skipDuplicates` 吞掉；`cost=0` 不落行。
3. 迁移测试：唯一索引存在且 partial（`pg_indexes` 断言）。
4. 真机：一次 mini-run 端到端（§5）。
5. `gctl check` + PR 必需检查；自审后合并。

## 8. 风险与开放问题

- **时间窗口径**：同 workspace 并发 run 会互相计入（短期双计/漏计）。现行 BFF 流程每 workspace 串行发起 run，常规不并发；风险登记，后续用「runId 写入 usage_ledger.meta 或独立列」做精确归属（见 D-a 备选）。
- **尾部未落账**：ai_trace 异步写入的毫秒级尾部可能漏计；`costBasis` 标注口径。
- **`amountMicros` int4 上限**：单笔 >$2147 会溢出报错（极端场景）；必要时改 BigInt 列（另立项）。
- **NULL 成本条目**：若网关返回 `costUsd=null` 的调用较多，结算会低估；施工前先跑一条量的 SQL 作为门槛（假设 1 的可证伪检查）。
- **存量 26 空间 policy 豁免**：花费上限对新空间生效即可，不回溯改存量（用户既有决定）。

## 9. 联网研究结论（§0.6 ③；2026-11-06）

- **outbox/inbox 幂等**：outbox 与业务同事务写入、中继至少一次投递；消费端幂等的最终闸门是**唯一约束 + 冲突吞掉**（不是先查后写），并发重复投递靠唯一键冲突路径吸收；保留期/清理与重复命中率是可观测指标（[Inbox 模式详解](https://raw.githubusercontent.com/mjmirza/patterns/refs/heads/main/patterns/10-microservices/inbox.md)、[o4x 的 ON CONFLICT DO NOTHING 实现](https://pkg.go.dev/github.com/hacomono-lib/o4x@v0.2.5/core)、[transaction-outbox](https://github.com/gruelbox/transaction-outbox)）。→ **借**：`(workspace_id, source_event_id)` partial unique + `skipDuplicates` 即该模式的最小实现；避免「先查后写」竞态。
- **按 run 结算的用量计量**：OpenMeter（Kong）推荐「run 完成时发一条带**预聚合总量**的事件，以 run 标识做去重」，LLM 用量按 provider/model 等维度 `groupBy` 计量；其自身依赖 Kafka+ClickHouse（[OpenMeter 文档](https://openmeter.io/docs/metering/guides/common-examples)、[GitHub](https://github.com/openmeterio/openmeter)）。→ **借**「一次 run 一个聚合事件」的形状；**避**引入 Kafka/ClickHouse 级基础设施（我们的规模用引擎 `usage_ledger` + 事件 + SaaS 账本即可）。
- 结论（借/集/建/避）：借 outbox/inbox 唯一约束幂等与「一 run 一聚合事件」；集（无现成可集，OpenMeter 过重）；自建引擎侧窗口聚合 + SaaS 幂等落账；避消费端先查后写与跨服务分布式锁。

## 10. 决策点（请产品负责人确认）

- **D-a 成本归属口径**：v1 采用「工作空间 + run 时间窗」从 `usage_ledger` 聚合（改动面最小），把「runId 精确归属」列为后续项（需在网关链路传 runId 或加列）。
- **D-b 消费端位置**：把成本处理移到事件类型分支之前，对所有带 `payload.cost` 的事件生效（修掉 `DiscoveryRunCompleted` 分支提前 return 的盲区）。
- **D-c 幂等实现**：partial unique `(workspace_id, source_event_id)` + `skipDuplicates`（先查后写被否，见 §9）。
- **D-d 上线顺序**：先发 gain-saas（消费端宽容），再发引擎（开始发 `cost`），同班车完成。
- **D-e 成本基准**：`usage_ledger` 成本为空是本设计的前置缺口（实测 10,769/10,769 NULL）。v1 采用「token 折算上界」（`LLM_CENTS_PER_MTOK`，与预算 settle 同口径，不引价目表）；精确价目/渠道结算列为后续项。

## 11. 给产品负责人的说明

- **得到什么**：`$15/30 天`花费上限从恒 0 变为真实生效（成本按 token 上界折算，D-e）；每个 run 的成本进事件与 SaaS 账本，重放不重复计费。
- **没改什么**：不改客户价格、不改事件类型/收据契约、不改 run 次数上限逻辑、不回溯存量豁免空间。
- **风险与回退**：时间窗口径在并发 run 下不完全精确（现行流程不并发）；回退 = 镜像回滚，索引残留无害。
- **建议**：批准 D-a~D-d 后按 §7 TDD 施工（引擎 + gain-saas 两个 PR 或一个跨仓发布组合），随后发车并跑一次 mini-run 端到端验证。
