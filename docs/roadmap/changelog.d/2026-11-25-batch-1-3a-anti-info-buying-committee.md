---
date: 2026-11-25
pr: 1095
title: "feat(enrichment): Batch 1.3-A 反 info@ 四轨决策委员会、Prospeo v2 迁移与 D3 多通道作战导出"
---

- 起因：获客联系阶段长期偏重官网 `info@` 公共池；`ProspeoProvider` 仍调用已废弃的 `POST /email-finder`（实测 `400 DEPRECATED`）；`A_TIER_SCORE_THRESHOLD` 误写为 `80`（而 `lead.totalScore` 为 `0..1` 归一化分制）导致 A 档公司永远无法命中；`contact-classifier.ts:101` 将未知单段本地部 `other`（如 `jdoe@`）误判为 `amber` 绕过 GDPR 保护；`validateOutreachDraft` 缺少中文绝对化违禁词且对空发件主体/地址存在 `includes("")` 绕过。
- 改动：
  - 将 `ProspeoProvider` 迁移至新版 `POST /enrich-person`（`only_verified_email: true`，解析 `person.email.status` SMTP 验真置信度并兼容旧响应结构）；为 `ApolloProvider` 增加 `APOLLO_PAID_PLAN_ENABLED=0` 付费/BYOK 门控及 `403 API_INACCESSIBLE` 非重试识别；
  - 将 `A_TIER_SCORE_THRESHOLD` 由 `80` 修正为 `0.8`，为 `loadContactEnrichmentTargets` 增加可选 `includeUnverifiedEmails` 以覆及仅有 `CATCH_ALL_RISKY`/`UNKNOWN` 邮箱的联系人（默认不改变冻结安全通道）；将 `contact-classifier.ts` 未知 `other` 类型改为 fail-closed `red`；
  - 新增 `buying-committee.ts`（4 轨多语种决策委员会查询规划、职位归轨、S/A/B/C 四级通道分层、领英 3 句附言硬校验与人机协同副驾剧本、C 级 `info@` 3 句转交请求信）；
  - 新增 `outreach/multi-channel-playbook.ts`（D3 法域多通道路由：CA/AE/SA `CONSENT_REQUIRED`、UK PECR 企业法人判定、DE/EU 严控与拉美 4 重护栏人工 `wa.me`）及 `suppression-value.ts` 的 `phone`/`whatsapp` E.164 归一化；补齐 `draft-validation.ts` 中文禁用夸大词与空发件信息页脚防绕过；
  - 新增 `report/battle-csv.ts`（复用 CWE-1236 公式中和与 UTF-8 BOM 的受审计多通道作战 CSV 导出器）。
- 测试：全量通过 `prospeo.provider.spec.ts`、`apollo.provider.spec.ts`、`enrich-company-contacts.spec.ts`、`contact-classifier.spec.ts`、`draft-validation.spec.ts` 及新增的 `buying-committee.spec.ts`、`multi-channel-playbook.spec.ts`、`battle-csv.spec.ts`；通过 `G9/G15/G16/G17`、`execution-authority-policy`、`nest build`、`eslint`、`docs:verify`、`benchmark:discovery` 与 `gitleaks`。
- 未做：OutboxRelay 队头阻塞修复与 GDPR `Article14Notice`/`LiaRecord` 归入原子 PR 1.3-B；`gain-saas` 独立合同同步与外联 8 连环 Bug/Ring-1 P0 安全封堵同步在 `gain-saas` 仓库推进。
