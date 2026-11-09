---
date: 2026-11-09
title: Verification waterfall — primary, second vote, arbitration with per-address budgets
---

- 起因：P1-06——即便两家验证器 key 都到位，再验证链路也只用一家，双正规则永远凑不齐、VALID 永远是 0。验证瀑布（主验→二次确认→仲裁）是 ch02 的出口判据（G2 ≥35%）的直接前置。
- 改动：
  - `apps/api/src/enrichment/verification/verification-waterfall.ts`：provider 无关的编排——主验 invalid 立即停（强否定）；主验 catch_all/unknown 停（解析器未接入前不烧第二票）；主验 VALID 才调二次确认（双正）；前两票未收敛（1:1 冲突 / valid+risky）且存在仲裁者时调第三家。每地址 ≤6 次调用、成本上限、`beforeCall` 限流挂点，返回逐步结果供事件账逐行落账。
  - `provider-pool.ts`：按固定顺序返回凭据已配置的验证器（MillionVerifier → Emailable），kill switch 仍由调用方逐家过 `checkProviderGates`。
  - 再验证核心 `runReverifySweep` 改为接收 provider 列表并走瀑布：逐 provider 幂等预查（崩溃恢复只补跑缺失的那家）、每步一行事件账（原始裁决/成本/延迟）、点状态用投票矩阵的最终结果推进（INVALID 清空 catch-all、UNKNOWN 不动既有分类）。
  - CLI 与 Schedule activity 均构建验证器池并逐家过门；无可用验证器时 CLI 拒绝、activity 返回 skipped（零调用）。
- 测试：瀑布 14 条（双正 VALID、单票 UNKNOWN、invalid 即停、catch_all/unknown 即停、provider_error 不换家、accept_all 优先、仲裁 2:1 与冲突、maxCalls/成本上限、beforeCall 次数、原始裁决→事件词表）；池 4 条；sweep/activity 单测全部迁移到 provider 列表语义（83 用例全绿）。
- 未做：Truelist enhanced（catch-all 解析器）与 ZeroBounce 适配器（瀑布的第三位已留好，接入后无需改编排）；`contact-eligibility` 发送门（P1-16）。
