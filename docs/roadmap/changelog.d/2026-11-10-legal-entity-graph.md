---
date: 2026-11-10
title: Deep-acquisition W2 legal entity graph and company-to-entity disambiguation
---

- 起因：获客挖掘 vNext 计划（`docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md`，经计划 PR 单独合入）§3 W2——深度优先要求公司记录可落到法人实体，同名异地与集团/子公司分开；现有 canonical_company 只有域名/名称级去重，没有实体图谱。
- 改动：
  - 迁移 `20261110070000_legal_entity_graph`：新表 `legal_entity`（租户级，身份键 workspace+scheme+country+value，scheme ∈ lei/vat/hrb/siren/ch/kvk/cvr/bolagsverket/other）与 `company_legal_link`（confidence、match_method、match_rule、status auto/review/rejected、证据 JSON），双表 ENABLE+FORCE RLS；设计取舍（为何租户级、为何 country 入键、HRB/VAT 的 caveat）写在迁移头注释。
  - 匹配引擎 `apps/api/src/discovery/entity/`：确定性键优先（复用 registry 的 LEI/VAT 归一；HRB/SIREN/CH/KVK/CVR/bolagsverket 规范式），VIES 校验留 `VatValidator` 注入点（默认不出网，VAT 命中落 review）；无键时 Fellegi–Sunter 概率匹配骨架（blocking=国家+归一化名字前 4 字符，名称/国家/地址字段权重表可配，双阈值 auto/review）；同 scheme 键冲突 → rejected 留档（同名异法人硬门）。
  - 端点：`POST /companies/{companyId}/legal-links/resolve`（登记自实体/候选 → 消歧 → 落库 → 返回链接；acquisition:write）与 `GET /companies/{companyId}/legal-links`（acquisition:read），operation-descriptions 与 OpenAPI 同步。不自动合并两个已存在的 canonical 公司。
- 测试：新增单测覆盖标识规范式、确定性键命中/VIES 三态、同名异法人反例、概率匹配双阈值分档与 blocking 拒配；迁移静态契约 spec（词表闭合/唯一键/复合外键/RLS/授权与 docs/governance/app-user-table-privileges.json 清单一致）。真库面由 CI 的 prisma-drift、rls-catalog、app-user-table-privileges 三道门复核。
- 未做：概率权重表未用标注数据拟合（起始值 + 版本号 fellegi_sunter_v1，W5 主动学习重校准）；父子/集团边（parent_lei 已在证据中，边表留给图谱后续波次）；人工复核端点与「合并两个 canonical 公司」流程；W4 源装载器（legal_entity 目前由 GLEIF/官网 VAT 与 resolve 请求体 candidates 填充）。
