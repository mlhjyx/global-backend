---
date: 2026-11-09
title: P3 J15（第一批）— conformal 弃权数学模块与已知分布单测
---

- 起因：ch04 §4.3.7 —— 「自动 FIT 错误率 ≤5%」必须是统计承诺而不是口号：阈值 τ 由 calib 金标拟合，使接受集 {s ≤ τ} 的 NOT_FIT 比例在 95% 单侧置信下的 Clopper–Pearson 上界 ≤ α=0.05，取满足条件的最大 τ。
- 改动：新增 `apps/api/src/discovery/judgment/conformal.ts`（纯函数、零依赖）——`conformalScore`（k 次自洽采样 FIT 票占比 → s=1−p̄）、`clopperPearsonUpper`（正则不完全 Beta 反演，Lanczos lgamma + Lentz 连分式；E=0 走闭式 1−δ^{1/n}）、`fitConformalThreshold`（从小到大取安全最大 τ，无安全阈值 → null=全弃权）、`conformalAbstain`（无阈值恒弃权 fail-safe）。
- 测试：`conformal.spec.ts` 8 例——分数枚举、n=59 首次 ≤5% 的设计论断、E=1/n=100≈0.0466 的已知值、单调性、300 全 FIT → τ=0（上界约 1%）、1 错+99 对 → τ=1/3、小样本全弃权、弃权判定。
- 未做：阈值工件落库（`conformal_threshold` 表已建，拟合 CLI 与 L4 运行时接线属 J15 后续批次，依赖 J13 真实标注集与 J14 校准报告）。
