---
date: 2026-11-26
pr:
title: "fix(report,discovery): 作战清表选人按验真邮箱分档优先并过滤历史占位联系人"
---

- 起因：Batch 1.6.1 现网实测意大利光伏买家作战清表发现两处选人与读模型缺陷：(1) `Memodo` 等公司已有 2 票 `VALID` 直邮联系人（如 `Sales Manager Lombardia`），但 `prioritizeBuyingCommitteeContacts` 仅按职位轨道/顺序排序，误选了无邮箱的 `Teamleiter` 或高管，导致本应 S 级直邮的线索被降级；(2) `AEG Market` 仍把历史 `public_web` 自动生成的 `个人邮箱 (servizioclienti@)` 当成具名决策人展示在作战清表与公司详情中，原因是该记录 `title` 非 `switchboard` 且姓名以 `个人邮箱 (` 而非 `公开联系点` 开头。
- 改动：
  1. 在 `apps/api/src/enrichment/buying-committee.ts` 新增共享纯函数 `isUsableOutreachEmailPoint` 与 `contactEmailQualityTier`，更新 `prioritizeBuyingCommitteeContacts` 先按邮箱质量分档（0: `VALID` 已验真邮箱 > 1: 非 `INVALID` 且非 `pattern_guess` 盲猜的可用邮箱 > 2: 无可用邮箱），同档内维持原有 4 轨决策委员会优先级排序；不带 `points`/`contactPoints` 的富集选人调用方行为保持完全不变。
  2. 在 `apps/api/src/report/battle-csv-builder.ts` 复用 `isUsableOutreachEmailPoint` 统一 `pickBestEmailPoint` 与选人口径，对齐 legacy `status='VALID'` 的验真状态判定，并过滤总机兜底里的 `INVALID` 联系点；在 `apps/api/src/discovery/company-channels.ts` 让 `filterDecisionMakerContacts`（`GET /canonical-companies/:id`）同步按相同邮箱质量与轨道优先级排序。
  3. 在 `apps/api/src/discovery/providers/contact-quality-filter.ts` 新增 `isPlaceholderContact`（并保留 `isGenericSwitchboardContact` 兼容导出），扩展识别中英文历史自动占位名称（`个人邮箱 (...)`、`公司邮箱 (...)`、`企业邮箱 (...)`、`公开联系点 (...)`、`公开总机`、`Personal Email (...)`、`Company Email (...)`、`Corporate Email (...)`、`Public Contact (...)` 等）且绝不误伤中西方真实人名，统一作用于作战清表、`GET /canonical-companies/:id`、`GET /leads` 的 `channelSummary.decisionMakerCount` 与 `loadContactEnrichmentTargets`。
- 测试：新增并跑通 7 个直接受影响测试套件（`contact-quality-filter`、`buying-committee`、`battle-csv-builder`、`company-channels`、`discovery.service.synthetic`、`enrich-company-contacts`、`weekly-report.service`，96/96 passed），回归跑通 `src/report`、`src/enrichment`、`src/discovery`、`src/lead` 全部 268 个测试文件（252 passed / 16 postgres-gated skipped / 0 failed，3,591 passed），通过 `pnpm --filter @global/api build` 及全量治理快门（`check-file-budgets`、`governance-module-boundaries`、`copy-fixed-source-impact`、`governance-document-drift`、`docs:verify`、`governance-changelog-fragments`、`gitleaks`）。
- 未做：无数据库迁移，未触碰 `docs/governance/durable-result-strategies.json` 锁定文件或 Batch 1.7B 的 VIES / rejudge 代码；现网作战清表实测待合并发版后验证。
