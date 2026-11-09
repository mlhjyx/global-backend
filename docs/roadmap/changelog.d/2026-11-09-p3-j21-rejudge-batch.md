---
date: 2026-11-09
title: P3 J21 — 存量重判批次规划器（只读）与操作手册
---

- 起因：ch04 §4.3.9 J21 —— 5,013 家存量需要在 v2 判定上线后分批重判；没有规划器，「给谁判、多少钱、会不会超帽」只能拍脑袋，超帽后还会把「完成率」做成假指标。
- 改动：
  - `apps/api/src/discovery/judgment/rejudge-plan.ts`：确定性规划——有域名优先排序、定长批次切分、成本估算（9900 micros/家，设计实测均值），**超帽拒绝规划而不是静默截断**；非法参数 fail-closed。
  - `scripts/judgment/rejudge-batch.mts`：只读 CLI——从 ACTIVE ICP × 未用当前 `prompt_hash`/`rubric_version` 判过的 canonical_company 生成候选，输出批次/成本/超帽检查；`--execute` 显式拒绝（发车后才允许真实执行）。
  - `docs/backend/judgment-rejudge-batch.md`：规划/执行/异常停手/回滚（env 置回 off + worker 重启 <5 分钟）/验收口径。
- 测试：`rejudge-plan.spec.ts` 5 例（排序、切批与估算、超帽拒绝与显式限额、非法参数、确定性）。
- 顺带修正：J18 的金标 CLI 与本次 CLI 统一放在 `apps/api/scripts/judgment/`（root `scripts/` 在 pnpm 严格布局下解析不到 `@prisma/client`，且需在 app 包上下文运行）；CLI 读查询包在 `set_config` 事务里以满足 RLS（owner 连接同样受 `current_workspace_id()` 约束）。
- 未做：真实重判执行与每批完成率/失败率/成本证据（需发车后由 worker 执行，本手册已写执行步骤与停手条件）。
