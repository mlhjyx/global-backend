---
date: 2026-11-09
title: P3 J19（第一批）— 模型评测回执契约与 dry 跑批脚本
---

- 起因：ch04 §4.3.10.2 —— 发布门要读的不是「跑了一下觉得还行」，而是一份带身份与门限判定的回执：哪个模型、哪份金标、什么 rubric/prompt、指标（带 n 与 CI）、过没过。
- 改动：
  - `apps/api/src/discovery/judgment/eval-receipt.ts`：eval-receipt/v1 结构与 fail-closed 校验（五身份字段、指标 [0,1]+n+CI、cases 一致、gate.passed 布尔）；`buildEvalReceipt` 内置保守门限（κ≥0.6、TPR/TNR≥0.75、零失败用例），可覆盖。
  - `apps/api/scripts/judgment/run-judgment-model-evals.mts`：dry 跑批——不调用模型，跑完金标清单的确定性链路（schema→证据→聚合），用 J14 的校准数学算 κ/TPR/TNR（bootstrap 固定种子）并产出回执；`GAINOS_JUDGE_EVAL_LIVE=1` 显式拒绝（真实模型跑批需预算授权，属用户决策项）。
  - `docs/evidence/2026-11-09-judge-eval-receipt-dry.json`：dry 回执样例（gate.passed=true，model_resolved=dry-fixture-no-model-call）。
- 测试：`eval-receipt.spec.ts` 4 例（门限/阻断/覆盖/校验矩阵）；与 J14 校准单测合计 11/11。
- 未做：真实模型跑批与 `eval_receipt` 落表（schema 迁移 + 预算授权）；发布流程读取回执（J20）。
