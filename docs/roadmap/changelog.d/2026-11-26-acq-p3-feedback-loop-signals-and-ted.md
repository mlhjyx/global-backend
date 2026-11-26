---
date: 2026-11-26
pr: 1118
title: feat(acq-p3): 真实反馈自进化、源合格率配额、信号破冰首句与 EU TED 中标角色反转
---

- 起因：获客全链路重构收官阶段（Phase 3 Track 3B）需解决 4 个转化效率短板：线索人工驳回与外联结果未自动沉淀回 ICP 排除规则与 `fit-v3` 反例；渠道配额未按最终合格 `Lead` 率动态分配；交付包 `LeadPackage` 缺少基于真实企业公开信号的破冰首句；EU TED 中标公告将刚中标的 EPC/系统集成商一律按供给侧同行排除。
- 改动：
  - 新增 `FeedbackLearningService`（`POST /api/v1/icps/:icpId/feedback/record` 与 `GET /api/v1/icps/:icpId/feedback/summary`），零迁移将确认驳回/退订沉淀进 `icp.companyAttributes.peer_exclusions` 与最多 5 条脱敏 `fit_counter_examples`，并注入 `fit-v3` 提示词与域名硬否决；
  - 新增 `source-yield-allocator.ts`，按 `finalQualifiedLeads / recalledCandidates` 对齐最终合格线索并动态分配查询配额（保留最低探索下限防冷启动渠道饿死），同时在 `public-web.provider.ts` 的 `NOISE_DOMAINS` 增补 `1688.com` 双重防线；
  - 新增 `signal-icebreaker.ts` 并挂载 `icebreakerSuggestions` 至 `GET /api/v1/leads/:leadId/package`（覆盖 `changedetection`/`rsshub`/`HIRING_BUYING_ROLE`/`AD_CAMPAIGN_ACTIVE`/`NEWS_MENTION`/`TENDER_AWARDED`/`PAGE_CHANGE`，严格零捏造、零 PII，禁联或未清制裁命中时置空）；
  - 新增 `ted-role-classifier.ts` 并接入 `ted.provider.ts` 与信号投影，区分招标方（`contracting_authority`）、中标 EPC/系统集成商高意向买家（`award_winner` → `TENDER_AWARDED`、`self_role='buyer'`）与核心组件同业制造商（`peer_manufacturer` → `self_role='winner'`），完整兼容既有 PG Raw 校验契约；同步重导 `packages/contracts/openapi/openapi.json`。
- 测试：完成本 worktree 全部新增及受影响单元/契约/治理测试与构建（`prisma generate`、`@global/api build`、`--export-openapi`、Spectral lint、`operation-descriptions.spec.ts`、G9、G16、`environment-parity-policy`、`copy-fixed-source-impact`、`governance-document-drift`、`governance-changelog-fragments`、`docs:verify`、`code-intelligence:check`、`gitleaks`）；详见 PR 测试清单。
- 未做：未修改 `schema.prisma` 与数据库迁移，未触碰 4 个 SHA-256 锁定核心文件、Copy 固定源码、Track 3A 专属文件及 `g16-module-boundaries.json`；尚未部署上线做真网实测，待合并部署后由 QA 开展端到端灰度验证。
