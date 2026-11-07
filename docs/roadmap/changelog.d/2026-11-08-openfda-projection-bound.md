---
date: 2026-11-08
title: Raise the openFDA durable projection bound to the discovery fetch floor
---

- 起因：M0 步2 真测发现 `openfda-search/v1` 投影对 `establishments`/`clearances` 设 `maxItems: 12`，而发现 provider 每次至少取 `max(query.limit, 50) = 50` 条——真实 API 响应必被结算投影拒绝（`TOOL_DURABLE_RESULT_PROJECTION_REJECTED`），openFDA discovery 恒零产出；既有单测夹具 ≤12 条掩盖了真实形状。证据见 `docs/evidence/2026-11-08-m0-step2-source-enablement.md` §2/§4.4。
- 改动：`durable-results/source-result-projections.ts` 的 `openfda-search/v1` 两处 `arraySchema(12, …)` 提到 50（与唯一生产调用方 discovery provider 的取数下限一致）；结构性上限仍精确（51 条被拒），120 KiB 应用层字节门不变，作为真正的信封上界。
- 测试：边界锁定测试更新为 50；新增回归——50 条真机形状可投影并逐字节还原且 <120 KiB，51 条被结构性拒绝；真实 API 复测 openfda discovery 恢复非零供给（见新证据文档）。
- 未做：工具侧截断（不需要——50 已覆盖唯一生产调用口径；若未来有调用方传 limit>50，需同步抬升该上界）。
