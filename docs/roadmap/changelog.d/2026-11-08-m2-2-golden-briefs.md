---
date: 2026-11-08
title: Add the M2.2 golden campaign briefs and the campaign:golden batch runner
---

- 起因：M2.2 第 2 步（设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md`，D-M2.2-a~f 已批准）——规划器质量从「人工感觉」变成可回归的基线：golden brief 资产 + 一键跑批（通过率 + 逐条检查 + 叶子字段 diff）。
- 改动：
  - 新增 `evals/golden-campaign-briefs/`：6 条首样板（德吸塑包装 / 美国电子件 / 德国工业零部件各 2，D-M2.2-d），schema `campaign-golden-brief/v1`（brief + 结构化期望：必含/禁含字段、禁含语义、预算上限、决策策略、动作类型白名单）；只含行业/国家级描述，无租户 PII。
  - 新增断言层与跑批器：`apps/api/src/campaign-golden/{golden-brief,golden-evaluate,golden-diff}.ts` 与 `scripts/campaign-golden.mts`（`pnpm campaign:golden`）；支持零模型 replay（CI/变异测试）、live（POST 规划器端点，M2.1 接口就绪后接金丝雀租户）、`--baseline` 叶子 diff、`--out` 结果快照与 markdown 证据模板。
  - 变异测试：改坏产出（预算越界/缺必含字段/出现发送或单证语义/maxReplans 越界）与改坏期望都必须判红（设计 §7-3）。
- 测试：单测 26 例（资产 schema 负向、6 条资产装载、断言层全矩阵、叶子 diff、真实 CLI：replay 6/6 绿、预算变异判红退出码 1、baseline diff 生效、缺参数稳定报错）。
- 未做：live 实跑依赖 M2.1 的规划接口（未接线，届时用金丝雀租户跑首条基线并回填 `docs/evidence/`）；重规划循环与指标页签分别在 M2.2-1/M2.2-3。
