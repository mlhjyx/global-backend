---
date: 2026-11-09
title: Finish PR-13 matching and diagnostics, add the golden rubric/schemas, and ship the first metric-observation snapshot runner
---

- 起因：ch01 剩余卡要求补齐 PR-13（概率匹配、敏感性、下界）、PR-08 的机器侧（rubric 与金标 schema）以及「下一组指标实现」；不部署、不采购、不触碰 frame 适配器/DB 迁移。
- 改动：
  - `scripts/metrics/capture-recapture.mjs` 扩展（PR-13 余量）：Jaro–Winkler 相似度；Splink 式第二段概率匹配——blocking（姓名首 token+国家 / 邮编前缀+国家）、固定权重 Fellegi–Sunter 形状评分（domain/registry 硬键 ±6、name 0–5、国家/城市/邮编 ±）、阈值 auto≥8 / review 4–8 / reject<4、已由确定性硬键合并的对不重复评分；`--probabilistic` 输出复核队列；Chao (1987) 下界 `D + f1²/(2·f2)`；三 frame 自动留一法敏感性（k=2 子集回退 Chapman，跨度 >40% 降置信）。
  - 新增 `evals/golden-discovery/rubric-v1.md`（字段级标注手册：证据优先、保守 unknown、κ≥0.6 门槛、双标与裁决流程、PII 规则）与 `schema/golden-item.schema.json`、`golden-label.schema.json`、`golden-run.schema.json`（PR-08 机器侧；标注本体仍待产品负责人安排）。
  - 新增 `scripts/metrics/metrics-snapshot.mjs`（下一组指标实现）：只读计算 T0-001/T0-002（按 workspace）、T1-008（按 provider）、T1-009（按 disposition）、T2-001/T2-005/T2-007/T2-008（按国家，T2-008 用 Poisson bootstrap），输出 `metric-observation/v1` 行（metricId/version/stratum/window/counts/value/Wilson 或 bootstrap CI/computationHash），供 PR-03 直接落表；无裁决分母的 T2-002/003/004/009 显式 SKIPPED 而不是把 0 当测得率。
  - `docs/metrics/metric-dictionary.md` 升 v1.3（§6 增补概率匹配/Chao/敏感性、§8 changelog）；`scripts/metrics/README.md` 增补新脚本；`scripts/governance-contracts.spec.mjs` 导入 `metrics-snapshot.test.mjs`（字典版本与运行器一致性、来源约束、SKIPPED 结构）。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（CR 33 例含概率匹配阈值/复核队列/Chao/留一法；snapshot 4 例结构测试）；`scripts/metrics/metrics-snapshot.mjs` 在 `global_dev` 只读实跑（T1-008 55.0%、T1-009 65.7% SCHEMA_INVALID、T2-001 18.1%、T2-008 0.93/账户）；`node scripts/verify-docs.mjs` PASS；governance 全绿（含可达性）。
- 未做：固定权重非 EM（Splink 训练/latent class 属后续）；k>3 与 LCMCR 未实现；真实金标标注（PR-08 人工部分）未做；未动 frame 适配器/DB 迁移；未采购数据。
