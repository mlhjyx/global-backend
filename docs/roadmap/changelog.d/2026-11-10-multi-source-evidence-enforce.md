---
date: 2026-11-10
title: Enforced cross-source evidence gate and tiered evidence bundle in the judgment chain
---

- 起因：公司理解仍是官网单源；富集结果各写各的 attributes，判定链无法表达「FIT/NOT_FIT 需跨源佐证」。产品负责人 2026-11-10 决定取消影子期：证据包与佐证门直接按 enforce 生效（fail-closed、可回滚开关）。
- 改动：
  - 新增 `discovery/evidence-bundle.ts`：T1（官方注册/招投标/专利）/T2（Wikidata）/T3（官网/技术足迹）分层证据包；判定链在 FIT/NOT_FIT 落地前按当前属性现场装配（零出网），并把包随判定记录同事务写回 `attributes.evidence_bundle`（审计面；落库键名避开属性 sanitizer 黑名单，长数字标识拆分/前缀化）。
  - 判定快照（judge prompt）新增 `cross_source_evidence` 摘要——证据分层真实参与理解输入。
  - 新增 `discovery/judgment/corroboration.ts`：FIT/NOT_FIT 需 ≥2 个独立分层，否则 fail-closed 降级 UNKNOWN（Lead=weak/待复核，绝不自动推荐或自动拒绝）；v2 判定链与 v1 路径同口径；降级与评估记入 `judgment_record.sampling.corroboration`。`JUDGE_CORROBORATION_MODE` 默认 `enforce`（非法值 fail-closed 到 enforce），`shadow`/`off` 为回滚开关。
  - 新增 `scripts/build-evidence-bundle.mts`（DE 样本构建 + 对最近判定的同口径离线佐证样例）。
  - 新增 `docs/eval/golden-icp/`（26 条 ICP 查询 YAML，3 条已标注；口径/标注模板见 README）与 `scripts/evaluate-golden-icp.mts`、`src/discovery/golden-icp.ts`（受限 YAML 解析、确定性排序、precision@K/recall）。
- 测试：单测覆盖证据包装配与属性 sanitizer 回环、佐证评估/降级矩阵（enforce/shadow/off、单层/无包）、判定链降级与证据包写回、golden ICP 解析与 precision@K；dev 库真跑样例见 `docs/evidence/2026-11-10-multi-source-evidence-graph-slice.md`。
- 未做：golden 集 26 条查询中 23 条待标注；companies_house/inpi_rne/google_patents/samgov 暂无 canonical 属性命名空间，暂不计入 T1（留了抽取位）。
