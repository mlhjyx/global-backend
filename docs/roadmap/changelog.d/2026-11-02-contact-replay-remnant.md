---
date: 2026-11-02
title: Keep contact discovery alive across attendant replay remnants and activity retries
---

- 起因：第七班验收 run 2dcece84 在联系人阶段以 `BudgetOperationReplayError`（origin=remnant）两连败——Temporal 重试的 attempt 2 复用了 attempt 1 留下的「已预留、未结算」账本行（模型付费操作键缺 attempt 维度），与 #726 在理解活动修掉的是同一类问题；同 attempt 内的瞬时重试撞上残影也会直接打挂活动。
- 改动：
  - `discoverRunContacts` 把 Temporal attempt 并入模型 correlationId（`<companyId>:aN`），重试不再继承上一次尝试的未结算操作键；
  - `contact-discovery-core` 与联系人阶段的邮箱补全对 `BudgetOperationReplayError(origin=remnant)` 做**残留吸收**（#684 纪律）：该适配器/该公司本轮跳过并留告警，绝不让一行残影打挂整家公司或整个 run；`origin=live` 仍是活故障，照旧上抛。
- 测试：`execution-receipt-consumers.spec.ts` 新增「remnant 吸收 + 其余适配器继续 + live 仍失败」用例；联系人相关套件 314 项全绿；全量门待 CI。
- 部署：无迁移；随下一班车（含 #726）上线后重跑联系人验收。
- 未做：工具类操作键（如 SMTP 探测）本身仍未带 attempt 维度——靠残留吸收兜底；若要根治需把 attempt 透传到 ToolContext 的操作键派生（另行评估）。
