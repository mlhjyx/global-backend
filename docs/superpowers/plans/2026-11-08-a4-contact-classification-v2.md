# A4 落地设计 · 联系方式分类器 v2 + schema 扩展（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP A4（产品负责人 2026-11-08 批准 Phase 1→2 顺序；主会话 2026-11-08 指示 Phase 2 顺序 A4→A1）；调研口径见 `~/.claude/plans/reports/2026-11-08-contact-roadmap.html`（「可转化的分类联系方式」是核心交付）。

## 1. 目标

产品负责人核心口径：交付**可转化的分类联系方式**（不是公司名单）。现状缺口：
- `contact_point` 只有 type/value/status，没有「这是什么类型的邮箱」（role/personal/sales/procurement…）、没有来源页/来源方式、没有 robots/ToS/legal_basis/验证方式/catch-all 记录——下游无法分类、无法审计、无法做发送合规门（A6 的前置）。
- 公司级联系方式层只有 URL（`company_contact_point` 刻意不存邮箱/电话），而 Impressum 法定公开的 **role 邮箱与总机电话是公司事实**（🟡 职能邮箱 / 🟢 总机），A1 挖掘器需要落点。

## 2. Schema 扩展（迁移 `20261108160000_contact_classification_v2`）

1. `contact_point` 增列（全部 nullable，带值域 CHECK）：
   `email_type`（role/personal/generic_sales/procurement/management/finance/support/other）、
   `source_type`（impressum/contact_page/homepage/directory/social/pattern_guess/operator/provider）、
   `source_url`（≤2048、https、无空白）、`robots_status`（allowed/disallowed/unknown）、
   `tos_status`（allowed/restricted/unknown）、`legal_basis`（legitimate_interest/consent/contract/legal_obligation）、
   `verification_method`（smtp_rcpt/pattern_guess/provider_reported/operator/import）、
   `catch_all`（catch_all/not_catch_all/inconclusive/unknown）、`consent_record`（JSONB ≤8192，A6 用）。
   （personal 邮箱与 legal_basis 的纪律留在应用层：`allowPersonalWithoutBasis` 是已批准逃生门，DB 不强制该组合。）
2. 新表 `company_contact_channel`（公司级联系方式层）：
   - `channel`：email | phone | form_url；`value` 按 channel 形状 CHECK（email 形状 / 电话字符集 / https 表单 URL）；
   - `emailType`（仅 email，role 类集合）、`status`（UNVERIFIED/VALID/RISKY/INVALID，自动化只写 UNVERIFIED）、`data_class`：**email=amber、phone/form_url=green**（DB CHECK 强制）；
   - 来源与合规列同 contact_point（source_type/source_url/robots_status/tos_status/legal_basis/verification_method）、first/last_seen、updated_by；
   - 唯一键 (workspace, company, channel, value)；复合 FK 随公司级联删除；RLS FORCE + 租户策略；app_user 最小授权；登记 `docs/governance/app-user-table-privileges.json`。
3. Prisma：ContactPoint 新列 + `CompanyContactChannel` 模型 + CanonicalCompany 反向关系（不重建表；`prisma migrate diff` 对新表归零）。

## 3. 分类器 v2（`discovery/contact-classifier.ts`，纯函数）

- `classifyContactEmail(email)` → `{ emailType, dataClass }`：
  - local-part 归一（小写、去 `+tag`）；按 **国家语言词表** 映射到桶：
    role（info/kontakt/contact/office/hello/anfrage/inquiry…）、generic_sales（sales/vertrieb/ventas/ventes/vendite/commercial…）、
    procurement（einkauf/purchasing/procurement/achat/compras/acquisti…）、management（geschaeftsfuehrung/management/direction…）、
    finance（buchhaltung/accounting/billing/rechnung…）、support（support/hilfe/service/kundendienst…）；
  - 人名形态（`first.last`/`f-last` 等分隔）且不在词表 → personal（red）；无法判定 → other（amber）。
  - dataClass：personal=red，其余=amber（与既有 emailDataClass 口径一致）。
- field_evidence 的 `emailDataClass` 保持既有 `cleanEmail` 口径不变（未识别为 role 即 red，保守不放松；与分类器 `other=amber` 的差异是刻意的：证据分级宁严）。新分类器只决定 `contact_point.email_type`。

## 4. 落库接线

- `contact-persist`：contact_point 写入带 `email_type/source_type='provider'/source_url=record.sourcePage/legal_basis/verification_method='provider_reported'`。
- `email-guess-persist`：带 `email_type='personal'/source_type='pattern_guess'/verification_method='smtp_rcpt'/catch_all=由 verdict.detail 映射`。
- 新写入器 `company-contact-channel.ts`：幂等 upsert（自动化只写 UNVERIFIED、first/last_seen 语义、suppression 前置留给 A1 调用方）。

## 5. 非目标

- A1 Impressum 挖掘（下一 PR，消费本 schema 与写入器）；A6 发送合规门（消费 legal_basis/consent_record）；回填历史行（新列 nullable，增量生效）。

## 6. 测试

分类器多语种矩阵；写入器幂等/状态纪律；两处 persist 的新字段断言；迁移静态契约（值域 CHECK/授权/RLS）与 app-user 权限清单更新；全量零容器 + 治理门禁。

## 7. 回退

纯增量（nullable 列 + 新表），回退=revert 代码；DB 侧对象保留无副作用。
