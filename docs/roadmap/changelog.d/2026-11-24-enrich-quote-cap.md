---
date: 2026-11-24
title: 联系补强报价按受控目录保守计价
---

- 起因：contact.enrich 的 quote envelope models/tools 为空，capMicrousd() 只得到表示最小值 1 µUSD；真实 Grant 的 CapBudget 无法支付 Hunter 等受控付费调用。
- 改动（按 coordination/t-enrich-contacts-quote-cap-design-r1.md）：新增纯价格目录 helper，从 resolveHunterConfig/resolveMillionVerifierConfig/resolveEmailableConfig/resolveZeroBounceConfig 同一 env 归一化源投影四个受控工具的精确 µUSD 单价（tool id/version 1.0.0/costUnit request 保持原值）；envelope 按联系人上界 10、每工具 maxPhysicalInvocations=10、单次价 ceil 到整数分计价（默认合计 400000 µUSD），executionLimits 增加 contactEnrichPricePolicyVersion 与四个精确单价字段，使同分区间调价也进入 policyRevision。报价协议、request hash、controller、safety service 均未改；原槽位/账本仍用精确 µUSD；无迁移、无 app_user 权限变更。g16 基线登记 execution-budget -> enrichment 边（4 个 resolver import）。
- 测试：价格目录/envelope/quote service/OAS 定向 vitest 78/78（含最坏合法 frozen plan 209800 µUSD ≤ 400000 上界、1700→1900 同分区间 policyRevision 变化、越界 fail-closed、无密钥/URL 泄漏）；@global/api build 与 lint 通过；OpenAPI 由 code-first 重新导出且无变化。
- 未做：未真实调用供应商或付费；未改 gain-saas BFF signer（按设计无需改码）；BFF 真 quote 契约回归与 app_user before-wire 证据留待 C1/后续窗口。
