---
date: 2026-11-04
pr:
title: Run 2.0 finalize V2, shadow comparison and run alerts
---

- 起因：切默认前要能对比新旧两套判定的召回与一致率（影子模式，连续两轮召回不降才切），并把运行健康（预算/失败率/时长）变成可见告警。
- 改动：
  - 阶段时间写入 `discovery_run.phases`（quick_started/quick_done/deep_started/deep_done，活动记录、回放安全）。
  - 新表 `run_shadow_diff`（聚合计数、租户 RLS、append-only）：影子 run 里老路径照常产出，新快扫判定不物化名单，只对比召回与逐家一致率。
  - run 收尾统计新增 `stats.alerts`：预算耗尽、失败率 >30%、超过 30 分钟未完成；部署开关 `DISCOVERY_RUN2_SHADOW`（默认关）。
  - 快扫/深挖的 verdict 汇总进 `stats.quickScan`/`stats.deep`。
- 测试：阶段合并/耗时/影子对比（含占位判定剔除）三条活动单测、影子工作流单测、迁移静态契约；全量 API 单测与 docs/governance 校验。
- 未做：自动切换默认（连续两轮影子达标后由产品负责人点头；告警的外部推送通道随 M1/运维面板）。
