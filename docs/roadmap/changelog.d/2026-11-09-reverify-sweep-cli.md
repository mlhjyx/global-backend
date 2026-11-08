---
date: 2026-11-09
title: Batch re-verification CLI for existing contact point emails
---

- 起因：迁移把 274 条存量邮箱排进 UNKNOWN 重验队列，但没有任何批处理入口能消费该队列；人工逐点调用 HTTP 验证既慢又缺幂等与成本记账。
- 改动：
  - `apps/api/scripts/reverify-contact-points.mts`：按 `next_reverify_at`（或 `--ignore-schedule` 按状态）取有界批次，逐点过 suppression（email/domain/company_name/contact_key 四类）与人名邮箱合规门，再调第三方验证器（限流 `--rate`）；供应商原始裁决与投票裁决后的四态分别落事件账与点状态（同事务）。
  - 幂等：`request_hash = sha256(pointId|providerKey|密文值|周期桶)`，同桶重跑不重复计费（调用前预查事件账）；`--dry-run` 离线只报选点与门状态。
  - 门：`PII_ENCRYPTION_KEY` 必需；live 模式要求 `data_provider.millionverifier` ENABLED + `source_policy` 已登记未 SUSPENDED + `MILLIONVERIFIER_API_KEY`。
- 测试：内存 fake 覆盖单验证器 positive 不判 VALID、invalid→INVALID、accept_all→CATCH_ALL_RISKY、网络错误不改状态、合规门/suppression 不触网、幂等预查与 dry-run。
- 未做：Temporal 每日 Schedule `CONTACT_REVERIFY_SWEEP` 接线（P1-19 后续，activity 复用 `runReverifySweep`）；真实 key 到位后的小批实测。
