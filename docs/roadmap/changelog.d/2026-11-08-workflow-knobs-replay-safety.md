---
date: 2026-11-08
title: Record discovery workflow tuning constants in start input for replay safety
---

- 起因：审计 L01（P1）——discovery 工作流的池搜索兜底阈值（20）、深挖并发（16）、查询批大小（2）是模块级常量且参与分支/循环；改常量会让在飞历史重放成不同命令序列（NDE），本周只能靠关 env 开关绕行，调参手段实际被冻结。
- 改动：
  - 新增 `discovery.workflow-knobs.ts`：三个旋钮的冻结默认值、合法区间与输入收敛（纯函数）；`DiscoveryRunInput` 增加 `run2PoolSearchFallbackThreshold` / `deepCompanyConcurrency` / `discoveryQueryBatchSize` 可选字段。
  - outbox relay 启动 discovery 工作流时把三个旋钮**显式**写进启动输入（env `DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD` / `DISCOVERY_DEEP_COMPANY_CONCURRENCY` / `DISCOVERY_QUERY_BATCH_SIZE` 可覆盖，非法值回落冻结默认并告警）；旧历史没有字段时按冻结默认重放不变。
  - `raw-retention` sweep 的三个循环上界（`maxBatchesPerWorkspace` / `maxBudgetReconcileBatches` / `maxPagesPerRun`）同样输入化，`continueAsNew` 随输入传递。
  - 新增治理检查 `scripts/governance-workflow-constants.mjs`（并入 `pnpm governance:verify`）：workflow 文件里的模块级数值常量必须带白名单理由，白名单条目过期即失败。
- 测试：新增 `discovery.workflow-knobs.spec.ts`（三旋钮参与控制流 + 非法输入收敛，10 例）；新增 `discovery-workflow-knobs.replay.spec.ts`（旧历史按冻结默认重放、三个旋钮各自的录制值被重放尊重；忽略输入时 3/4 用例转红）；扩展 relay 路由测试（默认注入与 env 覆盖）；治理检查 6 例（含仓库自检）。`pnpm --filter @global/api test`、`pnpm governance:verify` 全绿。
- 未做：deep 阶段的告警阈值（30 分钟 / 失败率 30%）仍为工作流内字面量——它们只影响 stats.alerts，不改变命令序列，未纳入本次；external-intent / kb-recovery / personal-artifact-cleanup / refurbish 的常量已进白名单并标注「待输入化」。
