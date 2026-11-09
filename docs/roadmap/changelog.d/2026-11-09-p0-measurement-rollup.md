---
date: 2026-11-09
title: Add the measurement rollup workflow — first ten metrics into metric_observation plus daily and weekly rollups (ch01 PR-03)
---

- 起因：ch01 PR-03 要在 PR-02 的四表上跑通「采集 → 观测 → 日/周聚合」，让指标第一次以带窗口与哈希的 append-only 观测入库；本切片不接调度（平台 Schedule 属运维窗口），提供工作流 + 活动 + 本地运行/回填命令。
- 改动：
  - `apps/api/src/measurement/metric-queries.ts`：首批 10 个指标的只读 SQL（T0-001/002、T1-008/009、T2-001/005/007/008 实现；T2-002/009 登记并显式 skipReason）；窗口语义 snapshot=目标日、rolling 7d=[dayStart-6d, dayEnd]，SQL 只出计数，CI 在 TS 计算。
  - `apps/api/src/measurement/rollup.ts`（纯函数）：stratum_key 规范 JSON、computation_hash、Wilson 区间、参数化 bootstrap（比率型计数，固定 seed）、最近观测挑选、日/周 rollup 行构建；`rollup.spec.ts` 11 例。
  - `apps/api/src/measurement/run.ts`：按日运行——逐指标查询→构建观测→`INSERT … ON CONFLICT ON CONSTRAINT metric_observation_identity_key DO NOTHING`→日/周 rollup upsert（DISTINCT ON 取每 stratum 最新观测）；owner 连接作为平台级服务写者；`run.spec.ts` 5 例（含跳过语义与调用计数）。
  - `apps/api/src/temporal/measurement.workflow.ts` + `measurement.activities.ts`：`measurementRollupWorkflow({day})`，15 分钟活动超时、3 次重试；worker 注册（`createMeasurementActivities({ ownerDb })`）并由 `customer-workflows` 导出；`measurement.workflow.spec.ts` 2 例（含非法日期非重试失败）。
  - `apps/api/scripts/measurement-rollup.mts`：默认 UTC 昨天，`--day` 单日，`--backfill-days N` 逐日回填（与实时同实现，幂等）。
  - `docs/metrics/rollup-workflow.md` 说明指标表、幂等/迟到口径、运行命令、调度待运维窗口与 PR-04 衔接。
- 测试：SQL 形状在 `global_dev` 只读复核（T0-001 403/0、T2-001 403/73、T1-009 三原因与分母一致）；本地无完整 node_modules，vitest 由 CI 执行；`verify-docs` 本地 PASS。
- 未做：每日 Temporal Schedule 注册（平台执行合同/运维窗口）；PR-04 API 与看板；T2-002/009 的自动纳管（等分母）；未触碰 Copy 绑定文件与 `evals/golden-judgments/`。
