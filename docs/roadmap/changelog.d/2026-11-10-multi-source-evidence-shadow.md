---
date: 2026-11-10
title: Shadow evidence bundle, cross-source corroboration gate and golden ICP eval skeleton
---

- 起因：公司理解仍是官网单源；各富集源各写各的 attributes，没有「跨源分层证据」视图；判定链无法表达「FIT/NOT_FIT 需跨源佐证」；缺离线召回评测集。
- 改动：
  - 新增 `discovery/evidence-bundle.ts`：T1（官方注册/招投标/专利）/T2（Wikidata）/T3（官网/技术足迹）分层证据包，已存属性零出网装配 + 缺失域经注入富集 provider（ToolBroker 闸门）实时探测；写 `attributes.evidence_bundle`（shadow，不改判定/展示）。长数字标识（TED 公告号/CPV/VAT）按 sanitizer 兼容形态存储（拆分/前缀/number）。
  - 新增 `discovery/judgment/corroboration.ts`：FIT/NOT_FIT 判定的跨源佐证评估（≥2 个独立分层），`JUDGE_CORROBORATION_MODE` 默认 `shadow`（只记录不拦截），落 `judgment_record.sampling.corroboration`（fit-judge 同事务接线，任何失败降级不影响判定写入）。
  - 新增 `scripts/build-evidence-bundle.mts`（DE 少量样本 shadow 构建 + 对最近判定做离线 corroboration 样例）。
  - 新增 `docs/eval/golden-icp/`（受限 YAML 评测集 + 标注模板 + 口径）与 `scripts/evaluate-golden-icp.mts`、`src/eval/golden-icp.ts`（受限 YAML 解析、确定性排序、precision@K/recall）。
- 测试：单测覆盖证据包装配（分层/覆盖/清洗安全形态/富集探测跳过已存源/失败降级）、佐证评估矩阵（两源/单源/无包/UNKNOWN/开关默认值）、golden ICP 解析与 precision@K；dev 库真跑样例见 `docs/evidence/2026-11-10-multi-source-evidence-graph-slice.md`。
- 未做：证据包未接 run 热路径（CLI 先跑，shadow）；corroboration 的 enforce 拦截语义未实现（预留开关，需单独评审）；golden 集 26 条查询中 23 条待标注。
