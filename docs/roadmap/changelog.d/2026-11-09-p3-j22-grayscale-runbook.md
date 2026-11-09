---
date: 2026-11-09
title: P3 J22 — 判定灰度矩阵、回滚计划与演练脚本
---

- 起因：ch04 §4.3.9 J22 —— 两个运行开关（contract/panel）组合起来有 9 种状态，值班时「Lead 现在由谁决定」必须一眼可答；回滚要求 <5 分钟，需要预演而不是临场拼。
- 改动：
  - `apps/api/src/discovery/judgment/grayscale.ts`：纯函数 `describeJudgmentModes(env)`（9 组合的 Lead 路径/记录行为矩阵 + 非法值与「panel 在 contract=off 下不生效」告警）与 `rollbackPlan()`（env 复位→重启 api+worker→确认→留证，合计 <5 分钟）；四阶段灰度清单常量。
  - `apps/api/scripts/judgment/mode-drill.mts`：只读演练 CLI（打印矩阵/警告/回滚计划；非法 env 退出 1）。
  - `docs/backend/judgment-grayscale-runbook.md`：阶段门槛（含 J13 kappa 未达标前 enforce 仅限 dev）、每阶段值班指标、演练命令、回滚步骤与已知边界（shadow 不一致是观察信号、v2 非 durable、run_id 暂空）。
- 测试：`grayscale.spec.ts` 6 例（基线/shadow/enforce 矩阵、非法值告警、回滚计划 <5 分钟与步骤覆盖、阶段清单）。
- 未做：线上首轮真实灰度与演练记录（待发车后按手册执行并把 drill 输出归档）。
