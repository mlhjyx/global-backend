---
date: 2026-11-09
title: Four-state contact point verification with an append-only verification ledger
---

- 起因：效果审计（2026-11-08）显示 274 条邮箱里 250 条从未验证、24 条仅 pattern 猜测，`contact_point` 没有四态、缺 `source_type`/`verification_method`，验证事实散落在自建 SMTP 的单一返回码里，全库 VALID=0 无法区分「未验证」与「劣质」。
- 改动：
  - 迁移 `20261109120000_contact_point_four_state`：`contact_point` 增 `verification_state`（VALID/INVALID/CATCH_ALL_RISKY/UNKNOWN）等十列与形状/等价约束；`source_type` 回填 `legacy_unclassified` 后收紧 NOT NULL；`verification_method` 增 `third_party_api`；存量按 RISKY→UNKNOWN（仅 catch_all 域进 CATCH_ALL_RISKY）回填并排入重验队列。
  - 新表 `contact_point_verification_event`（append-only 事件账）：唯一幂等键 (workspace, point, provider, request_hash)，RLS 强制，`app_user` 仅 SELECT/INSERT。
  - 纯函数状态机 `contact-point-verification-state`（四态↔legacy status 投影、verdict 映射、转换表、来源分类）与事件写入器 `contact-point-verification-event`。
  - 三处写入路径改造：联系人发现按 adapter/来源页映射 `source_type`；邮箱猜测同步写四态；`verifyContactPoint` 同事务推进状态机并写事件账（BLOCKED 只记账不改状态）。
  - 回填脚本 `apps/api/scripts/backfill-contact-domain-blind-key.mts`（解密→域 HMAC 盲索引，幂等分批、dry-run、不落明文）。
- 测试：状态机/映射纯函数单测（转换表全分支）；迁移静态契约 spec + 迁移后 PostgreSQL 行为 spec（CHECK/valid_since 等价/source_type NOT NULL/事件账幂等与 RLS append-only，接入 CI Raw SQL 步骤）。
- 未做：单一写入器架构守卫（P1-02 后续）；富集尝试账与 catch-all 策略表（P1-08/P1-13 各自迁移）；读侧迁移到 `verification_state`。
