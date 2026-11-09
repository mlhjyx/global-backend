---
date: 2026-11-09
title: Add the frozen-frame export for recall audits; record the T3-19 vs PR-06 scorecard overlap assessment
---

- 起因：P2 看板先做 T3-19 对比评估——P0 的 PR-06 源记分卡（`scripts/metrics/source-scorecard.mjs`，raw_source_record 数据面、日粒度、8 指标中 5 项已实现）与本卡的 registry 记分卡在**能力形态上重叠 ≈60–70%（>50% 阈值）、可复用代码≈0、registry 侧当前可计算的差异化指标为 0**（域名解析/金标精度/多帧边际增益均未落地）。按规则转 T3-20 Tier A 审计导出骨架；评估记录见 `docs/superpowers/plans/2026-11-09-t3-19-scorecard-overlap-assessment.md`（T3-19 后续建议：扩展 ch01 记分卡家族而非另立并行子系统）。
- 改动：
  - `apps/api/src/registry/recall-frame-export.ts`：`buildRecallFrameExport`——把某 frame 快照的冻结实体集（`last_snapshot_id = snapshot.id` 且未退出）规范排序 + 行级校验 + 逐行 JSON 的 sha256，产出 `recall-frame-export/v1`（manifest：frameKey/snapshotId/sha256/rowCount/exportedAt）。输入乱序不影响哈希；重复业务键/空必填字段 fail-closed。
  - `scripts/frames/recall-frame-export.mts`：只读导出 CLI（默认取最近 PARSED 快照，可指定 snapshot；DATABASE_URL 缺省读 packages/db/.env），产物直接作为 `recall-audit.mjs --frame` 输入；报告记录 snapshotId+sha256+seed 即可完整复算。
  - README 审计流程补「冻结 frame → 抽样输入」一段；产物池导出明确挂起等执行面（local_query 血缘获批）。
- 测试：`recall-frame-export.spec`（确定性哈希/空白归一/变更敏感/重复键与空字段负向/导出→auditRecall 直连可复算）；registry 全组 12 文件 119 项全绿；真库端到端：一次性库迁移 → 装载 FR 帧（3 实体）→ 导出冻结集（manifest sha256 + snapshotId）→ 跑审计 CLI 得到分层报告（FR:28:1-9/10-49/250+，found 2/3），库已删。
- 未做：产物池（run 侧）导出与 Temporal 审计工作流（等执行面）；运营台下钻页（P5）；不碰 Copy 绑定文件、无迁移、未发车。
