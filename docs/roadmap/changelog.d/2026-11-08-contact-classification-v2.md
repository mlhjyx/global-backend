---
date: 2026-11-08
title: Classify contact emails and add the company-level contact channel layer
---

- 起因：A4（Phase 2 首项）——核心交付是「可转化的分类联系方式」：contact_point 只有 type/value/status，没有邮箱类型（role/personal/sales/procurement…）、来源页、robots/ToS/legal_basis/验证方式/catch-all 记录；公司级只有 URL 层，Impressum 法定公开的 role 邮箱与总机电话没有落点。
- 改动：
  - 迁移 `20261108160000_contact_classification_v2`：contact_point 增 9 列（值域 CHECK、consent_record ≤8KB；personal 与 legal_basis 的组合纪律留在应用层——`allowPersonalWithoutBasis` 是已批准逃生门，DB 不强制）；新表 `company_contact_channel`（公司级联系方式层：email=amber 且 email_type 不得 personal，phone/form_url=green；来源/合规/验证列、幂等唯一键、RLS FORCE、app_user 最小授权并登记权限清单）。
  - 分类器 `discovery/contact-classifier.ts`：多语种（德/英/法/西/意）role/sales/procurement/management/finance/support/personal/other 映射；人名形态才判 personal（red），判不出不冒认。
  - 落库接线：contact-persist（email_type/source_type=provider/source_url/legal_basis/verification_method=provider_reported）、email-guess-persist（personal/pattern_guess/smtp_rcpt/catch_all 由 verdict.detail 归类）；新写入器 `company-contact-channel.ts`（自动化只写 UNVERIFIED、重复观测只推进 last_seen）。
- 测试：分类器多语种矩阵+人名/判不出边界；写入器分级/拒绝具名人邮箱/幂等；迁移静态契约（CHECK/RLS/权限清单）；既有 contact/guess 落库与 contacts-stage spec 全绿；全量零容器与治理门禁全绿。
- 未做：A1 Impressum 挖掘器（下一 PR，消费本 schema 与写入器）；历史行回填（nullable 增量生效）；A6 发送合规门（消费 legal_basis/consent_record）。
