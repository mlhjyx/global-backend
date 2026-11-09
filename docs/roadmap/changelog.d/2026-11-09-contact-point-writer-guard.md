---
date: 2026-11-09
title: Single contact_point writer enforced by an architecture guard
---

- 起因：P1-02 收尾——四态落地后仍有三处（联系人发现 / 邮箱猜测 / 验证回写）各自直写 `contact_point`；四态列、legacy status 投影、`valid_since` 等价约束、catch-all 子类与验证事件账是一个不变量集合，三路各写各的必然分叉（历史上已出现 RISKY 清 verifiedAt、状态与事件账不一致）。
- 改动：
  - 新增 `apps/api/src/discovery/contact-point-writer.ts` 作为唯一写入器：`upsertObservedContactPoint`（发现，首见优先）、`upsertGuessedEmailPoint`（猜测，含四态列与保守降级）、`setEmailPointState`（HTTP verify 与再验证 sweep 共用的状态机回写，含 `dispositionOnly` 的 BLOCKED 处置）、`linkLastVerificationEvent`。
  - 三处调用点与管理服务、再验证 sweep 全部改走写入器；行为与载荷逐字段保持原样（现有 215 个相关用例不改断言即全绿）。
  - 新增架构守卫 `contact-point-writer.guard.spec.ts`：扫描 `apps/api/src/**`（排除测试与写入器自身），任何 `contactPoint.create/upsert/update/updateMany/createMany/delete/deleteMany(` 或原生 SQL 写入 `contact_point` 都会失败并打印迁移指引；守卫自身带正/负例，防止空转。
- 测试：写入器守卫 3 条（无直写、匹配器正负例、写入器原语存在）；受影响 19 个 spec 文件 215 用例全绿；build/lint 通过。
- 未做：读侧迁到 `verification_state`（读投影仍用 `status`）；`phone_type` 写入方（P1-14）。
