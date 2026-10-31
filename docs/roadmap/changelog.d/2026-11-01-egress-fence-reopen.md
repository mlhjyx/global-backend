---
date: 2026-11-01
title: Add an audited, receipt-paired reopen path for the platform egress fence
---

- 起因：签名撤销会把平台 schedule 的出网围栏置为 `DISABLED`，但产品没有设计好的重开路径——`install_platform_egress_policy_v2` 与两个发送阶段都要求 `ACTIVE`。2026-10-31 撤销 fence 实测后只能由库属主手工 `UPDATE` 恢复 dev（见 `docs/evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md`）。
- 改动：
  - 新增迁移 `20261101010000_platform_egress_fence_reopen`：`reopen_platform_egress_fence_v1`（SECURITY DEFINER、owner-only、generation CAS、与 `platform_revocation_receipt` 的 `(schedule_id, fence_sequence, generation)` 精确配对、advisory lock + fence 行锁）与不可变审计表 `platform_egress_fence_reopen_receipt`（FORCE RLS、无任何运行角色表权限、UPDATE/DELETE/TRUNCATE 触发器拒绝）。
  - 重开只把围栏改回 `ACTIVE` 并推进 generation，`fence_sequence` 不变；不安装策略、不撤回已 `SENDING` 的物理调用、不改变撤销/ACK 语义，也不 unpause 任何 schedule。
  - 迁移内 DO 自检（函数 ACL/`search_path`/属主 RLS 能力、审计表 RLS 与触发器、四行围栏）与 `docs/governance/app-user-table-privileges.json` 同步。
  - 设计 `docs/superpowers/plans/2026-11-01-egress-fence-reopen.md`，运维说明 `docs/backend/platform-egress-fence-reopen.md`。
- 测试：`node --test scripts/platform-egress-fence-migration.spec.mjs`（9 项迁移契约）；`PLATFORM_EGRESS_FENCE_REOPEN_DISPOSABLE_TEST=1 node --test packages/db/test/platform-egress-fence-reopen.disposable.spec.mjs`（8 项，一次性 pgvector:pg16，无网络）覆盖成功重开、重放/篡改、无回执与二次关闭、策略缺失、并发、回滚、owner-only 与不可变审计。
- 未做：四个平台 schedule 仍 paused；运行镜像的发布与切换、在 dev managed runtime 上演示 `/health/ready` 恢复需要单独部署授权。gain-saas 运营台/CLI 的调用接线未做。
