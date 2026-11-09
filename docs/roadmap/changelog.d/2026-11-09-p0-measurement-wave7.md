---
date: 2026-11-09
title: Add the zero-model golden replay runner with G1/G2/G3 gates and a mutation-tested demo set (PR-07 script side)
---

- 起因：ch01 PR-07 要求金标 runner 能装载/求值/做 diff/被变异测试打红；引擎侧 `apps/api/src/measurement/golden/` 与 `golden_eval_run` 落表依赖 PR-02/04，本波先交付零模型的 replay 脚本实现。
- 改动：
  - 新增 `scripts/metrics/golden-run.mjs`：读取 `evals/golden-discovery/` 目录契约（items=golden-item/v1、labels=golden-label/v1 且必须 adjudicated=true、predictions=冻结快照），计算逐字段 accuracy/precision/recall/Cohen's κ/混淆矩阵；执行 G1 绝对门（fit precision ≥0.80 / recall ≥0.75）、G3 字段门（domain_correct、is_company ≥0.95；email valid precision ≥0.95）与 G2 相对门（较 `--baseline` 任一指标跌 >2pp 判红）；缺字段记 SKIP；输出 `golden-run/v1`（metrics/gates/diff/sampleSha256/items）+ markdown，失败退出码非零；未裁决标签与未登记标签字段直接拒绝。
  - 新增合成演示夹具 `evals/golden-discovery/fixtures/replay-demo/`（4 条，无真实 PII），同时作为变异测试基准。
  - 新增 `scripts/metrics/golden-run.test.mjs`（8 例：demo 全过、κ 教科书算例、两处变异必红、未裁决/未知字段拒绝、G2 相对门、diff、确定性），导入 governance-contracts 随 `docs:verify` 进 CI；`evals/golden-discovery/README.md` 增 replay 用法与契约；门户与 metrics README 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 8 例）；demo replay 实跑 PASS；`verify-docs` PASS；governance 全绿。
- 未做：引擎 `apps/api/src/measurement/golden/` 模块与 `golden_eval_run` 落表（依赖 PR-02/04）；`--live` 模式（需规划/判定流水线）；真实金标标注（PR-08 人工）；未触碰 `evals/golden-judgments/`（J11 在建）。
