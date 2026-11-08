---
date: 2026-11-08
title: Settle LLM cache hits as zero-cost durable receipts so discovery lineage stays valid
---

- 起因：P1（2026-11-08 二次 run 失败根因）。LLM 缓存命中在 structured-task-runtime-bridge 内短路返回、不产生 durable 收据；discovery lineage 的不变量把「invoked=true 且未失败且无收据」视为未知结果 → 整条 lineage 作废 → `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`。首轮全 miss 全绿、次轮命中即挂。
- 改动：
  - `RouterModelGateway.settleCachedStructured`（新增，`ModelGateway` 可选方法）：缓存命中按真实调用同构落账——reserve(0) → projection/receiptFacts → settle(0) → onDurableReceipt。回执事实用 `not_incurred`（callCount=0、charged/upper=0），即「本次由缓存供给、未发生物理调用」的机器可读标记；金额零重复结算；Temporal 重试经 reservation replay 幂等返回同一收据。
  - bridge：命中且有可落账网关时走该路径并携带 `durableReceipt`；上下文要求持久收据但网关不支持时按 miss 走真实调用（绝不返回无收据的成功结果）。
  - 回归测试：网关零成本结算/重试幂等、bridge 命中携带收据、lineage 对零调用收据成立（无收据对照仍作废）。
- 未做：lineage 契约不改（其对「无收据的 invoked 调用不可审计」的判断是正确的）；`ai_trace` 现在会为缓存命中记录一条 provider=llm-cache、cost=0 的 OK 行（此前完全不落）。
