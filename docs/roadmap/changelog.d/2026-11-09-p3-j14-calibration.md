---
date: 2026-11-09
title: P3 J14（第一批）— 校准数学、报告 CLI 与可复算 fixture 证据
---

- 起因：ch04 §4.3.6 —— 判定质量必须用带 CI 的数字说话：混淆矩阵、TPR/TNR/PPV/NPV/FNR（Wilson 95%）、Cohen's κ（bootstrap CI）与 Rogan–Gladen 校正（观测 pass rate → 真实匹配率），且报告必须可复算。
- 改动：
  - `apps/api/src/discovery/judgment/calibration.ts`（纯函数）：混淆矩阵（UNKNOWN 计未自动通过）、Wilson 区间、κ、确定性 bootstrap（mulberry32 固定种子）、Rogan–Gladen（TPR+TNR≤1 或概率越界 → null，作为「校准集与生产分布不一致」的信号）、`evaluateCalibration` 汇总。
  - `apps/api/scripts/judgment/judge-calibration.mts`：报告 CLI（`--fixture` 合成样例 / `--input` 真实标签对 / `--out` Markdown），输出混淆矩阵 + 全指标 CI + κ bootstrap CI + Rogan–Gladen；同输入同报告。
  - `docs/evidence/2026-11-09-judge-calibration-fixture.md`：合成 fixture 的可复算样例（显著标注 SYNTHETIC，不作真实结论）。
- 测试：`calibration.spec.ts` 7 例——含设计 §4.3.6.3 两个演算例子（0.375/0.844 与 0.286/0.643 逐位对上）、Wilson 73/100、κ 经典 0.4、bootstrap 同种子复算。
- 未做：真实标注集上的校准结论（J13 标注与双标 kappa 达标后运行同一 CLI）；`eval_receipt.metrics` 落库与发布门读取（J19/J20）。
