# 文档与来源登记

> 文档 ID：`GOV-FE-001`
> 层级：`L1 / Registry`
> 状态：`CURRENT`
> 事实 Owner：`OWN-DOC-GOV`
> 当前清单基线：本分支 `origin/main@676c6cd` + Phase 1–8 docs-governance 产物
> 最后核验：2026-07-20

本表是“读哪份、信哪份、旧内容迁到哪里”的当前入口。Phase 1 的 [逐来源明细](../roadmap/saas-frontend-phase-1/source-detail-register.md)保留 `c3f0cca` 时点的 67 份 Markdown 和非 Markdown 审计证据；本表承接其结果并管理之后新增的文档，不重写冻结审计。

## 1. 登记字段与匹配规则

每个受控文档必须能得到以下有效字段：`registry_id`、路径、层级、载体类型、生命周期、唯一 Owner、事实主题、替代/迁移去向、最后核验点。

- “精确登记”优先于“文档族规则”；一个文件命中精确行后不再继承文档族默认。
- 文档族只能用于同一 Owner、生命周期和迁移策略的集合；有例外必须单独登记。
- `KEEP_CURRENT` 表示原路径继续是该主题当前入口。
- `REFERENCE_ONLY` 表示保留作证据/指南，不能承担 current truth。
- `FUTURE_*` 是内容将来的规范归属，不表示现在可以移动原文件。
- Owner ID 定义见 [责任词典](terminology-and-status.md#9-责任角色)。

## 2. 当前承重入口与 Phase 3 Registry

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `DOC-EXEC-001` | `AGENTS.md` | L0 / Normative | `CURRENT` | `OWN-SITE-BE` | 仓库边界、环境、执行入口 | `KEEP_CURRENT` |
| `DOC-EXEC-002` | `CONTRIBUTING.md` | L0 / Normative | `CURRENT` | `OWN-SITE-BE` | Git/worktree/PR/恢复规则 | `KEEP_CURRENT` |
| `DOC-PRODUCT-001` | `docs/product-scope.md` | L1 / Normative | `CURRENT` | `OWN-PRODUCT` | 产品面、边界、跨仓 ownership | `KEEP_CURRENT` |
| `DOC-ARCH-001` | `docs/architecture/current.md` | L1 / Normative | `CURRENT` | `OWN-SITE-BE` | 当前 as-built 架构 | `KEEP_CURRENT` |
| `DOC-ADR-001` | `docs/adr/registry.md` | L1 / Registry | `CURRENT` | `OWN-SITE-BE` | 承重技术/产品决策 | `KEEP_CURRENT` |
| `DOC-STATUS-001` | `docs/status/current.md` | L1 / Normative | `CURRENT` | `OWN-SITE-BE` | 当前主线和完成度 | `KEEP_CURRENT` |
| `DOC-ROADMAP-001` | `docs/roadmap/release-plan.md` | L1/L2 / Normative | `CURRENT` | `OWN-PRODUCT` | Site Builder 施工顺序 | `KEEP_CURRENT` |
| `PLAN-FE-DOC-001` | `docs/roadmap/saas-frontend-documentation-program-plan.md` | L2 / Program plan | `ACTIVE_INPUT` | `OWN-PRODUCT` | 前端文档项目阶段、Gate 和授权 | `KEEP_CURRENT` 至 Gate 8 |
| `PORTAL-FE-001` | `docs/README.md` | L1 / Navigation | `CURRENT` | `OWN-DOC-GOV` | 按角色的文档入口 | `KEEP_CURRENT` |
| `GOV-FE-000` | `docs/governance/README.md` | L1 / Registry index | `CURRENT` | `OWN-DOC-GOV` | Registry 导航 | `KEEP_CURRENT` |
| `GOV-FE-001` | `docs/governance/document-register.md` | L1 / Registry | `CURRENT` | `OWN-DOC-GOV` | 文档生命周期与迁移 | `KEEP_CURRENT` |
| `GOV-FE-002` | `docs/governance/terminology-and-status.md` | L1 / Registry | `CURRENT` | `OWN-DOC-GOV` | 术语、状态与责任角色 | `KEEP_CURRENT` |
| `GOV-FE-003` | `docs/governance/capability-register.md` | L1 / Registry | `CURRENT` | `OWN-PRODUCT` | Capability ID 与多轴状态 | `KEEP_CURRENT` |
| `GOV-FE-004` | `docs/governance/core-object-register.md` | L1 / Registry | `CURRENT` | `OWN-PRODUCT` | Object ID、SoR 与接缝 | `KEEP_CURRENT` |
| `GOV-FE-005` | `docs/governance/scenario-catalog.md` | L1/L3 / Registry | `CURRENT` | `OWN-QA-EVIDENCE` | Scenario/Fixture ID 与证据状态 | `KEEP_CURRENT` |
| `GOV-FE-006` | `docs/governance/conflict-register.md` | L1 / Registry | `CURRENT` | `OWN-DOC-GOV` | 跨来源冲突状态与 Owner | `KEEP_CURRENT` |
| `GOV-FE-007` | `docs/governance/traceability-matrix.md` | L1 / Registry | `CURRENT` | `OWN-DOC-GOV` | 能力到实现/证据关系 | `KEEP_CURRENT` |
| `GOV-FE-008` | `docs/governance/docs-verification.md` | L1 / Normative governance | `CURRENT` | `OWN-DOC-GOV` | 文档 lint、链接、状态、Registry 引用与例外规则 | `KEEP_CURRENT` |
| `GOV-FE-008-MACHINE` | `docs/governance/docs-verification-policy.json` | L1 / Machine policy | `CURRENT` | `OWN-DOC-GOV` | 受控范围、词汇、Registry source、历史 banner 与 Bundle schema | `KEEP_CURRENT`；与 verifier 同步变更 |
| `GOV-FE-009` | `docs/governance/release-and-learning-governance.md` | L1 / Normative governance | `CURRENT` | `OWN-QA-EVIDENCE` | Release Bundle、证据、审批和学习回写 | `KEEP_CURRENT` |
| `REL-FE-000` | `docs/releases/README.md` | L4 / Release index | `CURRENT` | `OWN-QA-EVIDENCE` | 真实用户发布 Bundle 索引；当前数量为 0 | `KEEP_CURRENT` |

Registry 的内容 Owner 仍按主题分开。例如能力批准属于 `OWN-PRODUCT`，API 实现证据属于 `OWN-SITE-BE`；`OWN-DOC-GOV` 只维护关系和完整性。

### 2.1 Gate 4 已批准全局前端规范

以下书面规范已由 `DEC-FE-P4-001..011` 批准为 `CURRENT` 目标规范；这不表示真实前端、视觉设计或部署存在。

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `FE-GLOBAL-000` | `docs/frontend/README.md` | L2 / Navigation | `CURRENT` | `OWN-DESIGN` | 全局前端规范阅读入口 | `KEEP_CURRENT` |
| `FE-GLOBAL-001` | `docs/frontend/00-scope-authority-and-status.md` | L2 / Normative target | `CURRENT` | `OWN-PRODUCT` | 前端范围、权威与事实状态 | `APPROVED_AT_GATE_4` |
| `FE-GLOBAL-002` | `docs/frontend/01-product-experience-principles.md` | L2 / Normative target | `CURRENT` | `OWN-DESIGN` | 体验原则和反模式 | `DEC-FE-P4-001` |
| `FE-GLOBAL-003` | `docs/frontend/02-information-architecture.md` | L2 / Normative target | `CURRENT` | `OWN-PRODUCT` | 完整 SaaS IA 与对象层级 | `DEC-FE-P4-002` |
| `FE-GLOBAL-004` | `docs/frontend/03-users-roles-and-journeys.md` | L2 / Normative target | `CURRENT` | `OWN-PRODUCT` | 用户、责任帽子、Job 与 Journey | `KEEP_CURRENT` |
| `FE-GLOBAL-005` | `docs/frontend/04-page-and-capability-catalog.md` | L2 / Normative target | `CURRENT` | `OWN-PRODUCT` | 完整前端页面/能力人类目录 | Registry 承重 ID/状态 |
| `FE-GLOBAL-006` | `docs/frontend/05-navigation-and-workspace-shell.md` | L2 / Normative target | `CURRENT` | `OWN-DESIGN` | 导航、Shell 与跨页面入口 | `DEC-FE-P4-002` |
| `FE-GLOBAL-007` | `docs/frontend/06-permissions-and-data-visibility.md` | L2 / Normative target | `CURRENT` | `OWN-SAAS-PLATFORM` | 权限分层与数据社会属性 | `DEC-FE-P4-003/004` |
| `FE-GLOBAL-008` | `docs/frontend/07-state-error-degradation-and-recovery.md` | L2 / Normative target | `CURRENT` | `OWN-DESIGN` | 全局状态、错误、长任务与恢复 | `DEC-FE-P4-005` |
| `FE-GLOBAL-009` | `docs/frontend/08-ai-approval-evidence-and-human-control.md` | L2 / Normative target | `CURRENT` | `OWN-PRODUCT` | AI/Evidence/Approval/授权控制链 | `DEC-FE-P4-006` |
| `FE-GLOBAL-010` | `docs/frontend/09-design-system-and-content-guidelines.md` | L2 / Normative target | `CURRENT` | `OWN-DESIGN` | 设计系统、组件和内容交付合同 | `DEC-FE-P4-007` |
| `FE-GLOBAL-011` | `docs/frontend/10-responsive-accessibility-and-performance.md` | L2 / Normative target | `CURRENT` | `OWN-DESIGN` | 响应式、a11y、性能、i18n | `DEC-FE-P4-008` |
| `FE-GLOBAL-012` | `docs/frontend/11-frontend-contracts-and-integration.md` | L2 / Normative target | `CURRENT` | `OWN-SAAS-FE` | 前端合同消费与安全接入 | `KEEP_CURRENT` |
| `FE-GLOBAL-013` | `docs/frontend/12-analytics-testing-and-release-evidence.md` | L2 / Normative target | `CURRENT` | `OWN-QA-EVIDENCE` | 分析、测试、发布证据与学习 | `DEC-FE-P4-009/010` |
| `FE-GLOBAL-014` | `docs/frontend/13-open-decisions.md` | L2 / Decision record | `CURRENT` | `OWN-PRODUCT` | 已批准决定、blocker 与技术开放项 | `KEEP_CURRENT` |
| `DESIGN-FE-000` | `docs/design/README.md` | L2 / Design index | `CURRENT` | `OWN-DESIGN` | 设计资产与内容治理入口 | `KEEP_CURRENT` |
| `DESIGN-FE-001` | `docs/design/design-asset-register.md` | L2 / Design registry | `CURRENT` | `OWN-DESIGN` | 设计资产 ID、版本、Owner 与追踪 | 持续维护 |
| `DESIGN-FE-002` | `docs/design/content-and-microcopy-catalog.md` | L2 / Content registry | `CURRENT` | `OWN-DESIGN` | 跨模块/站点微文案 ID 与本地化状态 | 持续维护 |

### 2.2 Gate 5 已批准的独立站管理规格

以下文件已在 Gate 5 获批；它们细化当前/目标体验，不拥有后端 as-built 或公开发布事实。

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `FE-SITE-000` | `docs/frontend/modules/independent-site-management/README.md` | L2 / Capability Pack | `CURRENT` | `OWN-PRODUCT` | Site 模块承诺、manifest 和状态分层 | `APPROVED_AT_GATE_5` |
| `FE-SITE-001` | `docs/frontend/modules/independent-site-management/journeys-and-page-spec.md` | L2 / Module UX | `CURRENT` | `OWN-PRODUCT` | Site 旅程与 Page manifest | `APPROVED_AT_GATE_5` |
| `FE-SITE-002` | `docs/frontend/modules/independent-site-management/lifecycle-permissions-and-state.md` | L2 / State/auth | `CURRENT` | `OWN-PRODUCT` | Site 对象、权限、状态和恢复 | `APPROVED_AT_GATE_5` |
| `FE-SITE-003` | `docs/frontend/modules/independent-site-management/public-site-output-spec.md` | L2 / Output target | `CURRENT` | `OWN-PRODUCT` | Astro 公开输出与生产门 | `APPROVED_AT_GATE_5` |
| `FE-SITE-004` | `docs/frontend/modules/independent-site-management/operations-and-acceptance.md` | L2 / Ops/acceptance | `CURRENT` | `OWN-PRODUCT` | Site runbook、场景、指标和验收 | `APPROVED_AT_GATE_5` |
| `FE-IMPL-SITE-001` | `docs/frontend/implementation/independent-site-management-blueprint.md` | L3 / Implementation blueprint | `CURRENT` | `OWN-SAAS-FE` | stack-neutral 前端实施交接 | `APPROVED_AT_GATE_5`；`BLK-FE-001` 关闭后实施输入 |
| `DESIGN-FE-003` | `docs/design/independent-site-management-wireframes.md` | L2 / Written wireframe | `CURRENT` | `OWN-DESIGN` | Site 页面流、低保真、responsive/a11y | `APPROVED_AT_GATE_5`；不等于视觉定稿 |
| `GATE-FE-P5-000` | `docs/roadmap/saas-frontend-phase-5/README.md` | L3 / Phase evidence | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 5 交付入口 | `REFERENCE_ONLY` |
| `GATE-FE-P5-001` | `docs/roadmap/saas-frontend-phase-5/gate-5-review.md` | L4 / Gate review | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Gate 5 决策与验收 | `REFERENCE_ONLY` |

### 2.3 Gate 6 已批准的全 SaaS 产品域文档

以下文件已在 Gate 6 获批。它们保证产品地图和边界完整，不把非 Site 域升级为 Dev-Ready。

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `FE-MODULES-000` | `docs/frontend/modules/README.md` | L2 / Capability index | `CURRENT` | `OWN-PRODUCT` | 全 SaaS 产品域入口与深度 | `APPROVED_AT_GATE_6` |
| `FE-P6-SHELL-000` | `docs/frontend/modules/workspace-shell-and-today/README.md` | L2 / Capability Pack | `CURRENT` | `OWN-SAAS-PLATFORM` | Shell/Today 用户闭环与基础合同缺口 | `APPROVED_AT_GATE_6` |
| `FE-P6-TRUTH-000` | `docs/frontend/modules/enterprise-trust-and-knowledge/README.md` | L2 / Capability Pack | `CURRENT` | `OWN-PRODUCT` | 企业事实、知识、Claim/Evidence/Asset 横切 | `APPROVED_AT_GATE_6` |
| `FE-P6-BUYER-000` | `docs/frontend/modules/buyer-development/README.md` | L2 / Frozen Capability Pack | `CURRENT` | `OWN-BUYER-BE` | 冻结客户开发完整地图与后端边界 | `APPROVED_AT_GATE_6` |
| `FE-P6-GROWTH-000` | `docs/frontend/modules/growth-execution/README.md` | L2 / Target Capability Pack | `CURRENT` | `OWN-SAAS-PLATFORM` | Goal/Campaign/Content/Publish 目标闭环 | `APPROVED_AT_GATE_6` |
| `FE-P6-ENGAGE-000` | `docs/frontend/modules/engagement-and-opportunity/README.md` | L2 / Target Capability Pack | `CURRENT` | `OWN-SAAS-PLATFORM` | Conversation/Opportunity/Outcome 边界 | `APPROVED_AT_GATE_6` |
| `FE-P6-INSIGHT-000` | `docs/frontend/modules/insights-and-learning/README.md` | L2 / Target Capability Pack | `CURRENT` | `OWN-SAAS-PLATFORM` | 读模型、成本、归因与学习原则 | `APPROVED_AT_GATE_6` |
| `FE-P6-CONTROL-000` | `docs/frontend/modules/team-integrations-settings-and-operations/README.md` | L2 / Target Capability Pack | `CURRENT` | `OWN-SAAS-PLATFORM` | 控制面、集成、商业与运营边界 | `APPROVED_AT_GATE_6` |
| `BASE-FE-P6-001` | `docs/roadmap/saas-frontend-phase-6/portfolio-coverage-and-priority.md` | L3 / Product baseline | `FROZEN_EVIDENCE` | `OWN-PRODUCT` | 能力覆盖、成熟度与优先级 | `REFERENCE_ONLY` |
| `BASE-FE-P6-002` | `docs/roadmap/saas-frontend-phase-6/cross-domain-handoffs-and-gaps.md` | L3 / Handoff register | `FROZEN_EVIDENCE` | `OWN-PRODUCT` | 跨域交付、责任断点与 Gap | `REFERENCE_ONLY` |
| `BASE-FE-P6-003` | `docs/roadmap/saas-frontend-phase-6/source-migration-coverage.md` | L3 / Migration coverage | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Word/原型/GoodJob/代码内容去向 | `REFERENCE_ONLY` |
| `GATE-FE-P6-000` | `docs/roadmap/saas-frontend-phase-6/README.md` | L3 / Phase evidence | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 6 交付入口 | `REFERENCE_ONLY` |
| `GATE-FE-P6-001` | `docs/roadmap/saas-frontend-phase-6/gate-6-review.md` | L4 / Gate review | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Gate 6 决策与验收 | `REFERENCE_ONLY` |

### 2.4 Gate 7 已批准的 OSS / 外部能力采用治理

以下 current Registry/Card 已由 Gate 7 批准采用决定；Phase 7 来源与评审包冻结。批准仍不授权依赖、采购、账号、部署或生产流量。

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `GOV-OSS-001` | `docs/backend/oss-registry.md` | L1 / Adoption registry | `CURRENT` | `OWN-SEC-COMMERCIAL` | Card、主决定、状态与责任帽总账 | `KEEP_CURRENT` |
| `OSS-FE-000` | `docs/platform/oss-adoption/README.md` | L2 / Adoption index | `CURRENT` | `OWN-SEC-COMMERCIAL` | 采用阅读入口和组合摘要 | `APPROVED_AT_GATE_7`；持续维护 |
| `OSS-FE-001` | `docs/platform/oss-adoption/adoption-policy.md` | L2 / Adoption policy | `CURRENT` | `OWN-SEC-COMMERCIAL` | 七类决定、准入与状态变更规则 | `APPROVED_AT_GATE_7`；持续维护 |
| `OSS-FE-002` | `docs/platform/oss-adoption/foundation-site-and-design.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-001..008` | `APPROVED_AT_GATE_7` |
| `OSS-FE-003` | `docs/platform/oss-adoption/growth-automation-and-engagement.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-009..011` | `APPROVED_AT_GATE_7` |
| `OSS-FE-004` | `docs/platform/oss-adoption/media-generation.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-012..014` | `APPROVED_AT_GATE_7` |
| `OSS-FE-005` | `docs/platform/oss-adoption/knowledge-and-retrieval.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-015..017` | `APPROVED_AT_GATE_7` |
| `OSS-FE-006` | `docs/platform/oss-adoption/documents-and-acquisition.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-018..021` | `APPROVED_AT_GATE_7` |
| `OSS-FE-007` | `docs/platform/oss-adoption/workflow-policy-model-and-observability.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-022..026` | `APPROVED_AT_GATE_7` |
| `OSS-FE-008` | `docs/platform/oss-adoption/documentation-and-quality-methods.md` | L2 / Capability Cards | `CURRENT` | `OWN-SEC-COMMERCIAL` | `ADP-FE-027..031` | `APPROVED_AT_GATE_7` |
| `OSS-FE-009` | `docs/platform/oss-adoption/official-source-snapshots.md` | L3 / Source/runtime evidence | `FROZEN_EVIDENCE` | `OWN-SEC-COMMERCIAL` | Gate 7 官方来源、lockfile 与 runtime 分层 | 新证据建新快照，不重写 |
| `BASE-FE-P7-001` | `docs/roadmap/saas-frontend-phase-7/portfolio-decisions-and-triggers.md` | L3 / Portfolio baseline | `FROZEN_EVIDENCE` | `OWN-SEC-COMMERCIAL` | Gate 7 采用组合与重开触发器 | `REFERENCE_ONLY` |
| `BASE-FE-P7-002` | `docs/roadmap/saas-frontend-phase-7/runtime-hardening-and-exit.md` | L3 / Hardening baseline | `FROZEN_EVIDENCE` | `OWN-PLATFORM` | Gate 7 现用八项硬化和退出门 | `REFERENCE_ONLY` |
| `GATE-FE-P7-000` | `docs/roadmap/saas-frontend-phase-7/README.md` | L3 / Phase evidence | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 7 交付入口 | `REFERENCE_ONLY` |
| `GATE-FE-P7-001` | `docs/roadmap/saas-frontend-phase-7/gate-7-review.md` | L4 / Gate review | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Gate 7 决策与批准 provenance | `REFERENCE_ONLY` |

### 2.5 Phase 8 防漂移与收口包

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `GATE-FE-P8-000` | `docs/roadmap/saas-frontend-phase-8/README.md` | L3 / Phase evidence | `ACTIVE_INPUT` | `OWN-DOC-GOV` | Phase 8 交付与授权边界 | Gate 8 后冻结 |
| `BASE-FE-P8-001` | `docs/roadmap/saas-frontend-phase-8/history-disposition-proposal.md` | L3 / Governance proposal | `ACTIVE_INPUT` | `OWN-DOC-GOV` | 历史 banner、原位保留与未来 archive 门 | Gate 8 决定 |
| `BASE-FE-P8-002` | `docs/roadmap/saas-frontend-phase-8/reading-route-acceptance.md` | L3 / Usability evidence | `ACTIVE_INPUT` | `OWN-QA-EVIDENCE` | 九条角色任务、作者 dry-run 和独立人工状态 | 独立运行后增量记录 |
| `EVID-FE-P8-001` | `docs/roadmap/saas-frontend-phase-8/verification-report.md` | L4 / Machine evidence | `ACTIVE_INPUT` | `OWN-QA-EVIDENCE` | Phase 8 命令、结果、warning 与边界 | Gate 8 后冻结 |
| `GATE-FE-P8-001` | `docs/roadmap/saas-frontend-phase-8/gate-8-review.md` | L4 / Gate review | `ACTIVE_INPUT` | `OWN-DOC-GOV` | Gate 8 决定、验收和保留项 | Gate 8 后冻结 |
| `TPL-FE-REL-001` | `docs/templates/release-bundle-template.md` | L5 / Template | `GUIDE` | `OWN-QA-EVIDENCE` | 真实 Release Bundle 可复制结构 | 复制后必须换 ID/元数据 |
| `TPL-FE-LRN-001` | `docs/templates/release-learning-template.md` | L5 / Template | `GUIDE` | `OWN-PRODUCT` | 发布学习记录结构 | 由真实 Bundle 索引 |

### 2.6 最近 Gate 证据精确入口

| Registry ID | 路径 | 层级 / 类型 | 生命周期 | 唯一 Owner | 唯一事实主题 | 去向 |
|---|---|---|---|---|---|---|
| `GATE-FE-P4-000` | `docs/roadmap/saas-frontend-phase-4/README.md` | L3 / Phase evidence | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 4 交付与批准记录 | `REFERENCE_ONLY` |
| `GATE-FE-P4-001` | `docs/roadmap/saas-frontend-phase-4/gate-4-review.md` | L4 / Gate evidence | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Gate 4 决定与验收 | `REFERENCE_ONLY` |

## 3. 现有 Markdown 文档族

以下规则覆盖 Phase 1 清点的 67 份 Markdown、Phase 1/2 冻结包和当前 Phase 3 评审包。精确入口见 §2，例外见 §4。

| Rule ID | 覆盖路径 | 层级 / 默认生命周期 | Owner | 可证明 / 不可证明 | 迁移或保留去向 |
|---|---|---|---|---|---|
| `DOCSET-ROOT-GUIDES` | `.codex/README.md`、`.github/pull_request_template.md`、根 `README.md` | L0/L5 / `GUIDE` | `OWN-SITE-BE` | 工具、PR、启动入口；不拥有 current status | 原位保留，链接承重入口 |
| `DOCSET-BACKEND-GUIDES` | `docs/backend/*.md` | L0/L2/L5 / `ACTIVE_INPUT` 或 `GUIDE` | `OWN-SITE-BE` | 后端专题规范/runbook；不代表 SaaS UX | 原位保留；前端只引用接缝 |
| `DOCSET-IMPLEMENTATION` | `docs/implementation-records/*.md` | L3 / `FROZEN_EVIDENCE` | `OWN-SITE-BE` | 某专题实施与核验；不拥有当前全局状态 | `REFERENCE_ONLY`，由 current/status 或 capability 引用 |
| `DOCSET-EVIDENCE` | `docs/evidence/**/README.md` | L3 / `FROZEN_EVIDENCE` | `OWN-QA-EVIDENCE` | 精确 bundle 的测试/模型/运行证据 | 保留不可变入口；新证据建新 bundle |
| `DOCSET-RESEARCH` | `docs/research/*.md` | L4 / `DATED_PROPOSAL` | `OWN-PRODUCT` 或专题技术 Owner | 研究、方案与历史评价；不能证明批准或实现 | `REFERENCE_ONLY`；被采纳事实进入对应 Normative/Registry |
| `DOCSET-ROADMAP-HISTORY` | `docs/roadmap/changelog.md`、`decision-maker-*.md`、`sam-sources-sought-p4-design.md`、`sanctions-screening-design.md` | L2–L4 / `FROZEN_EVIDENCE` 或 `DATED_PROPOSAL` | `OWN-PRODUCT` | 历史施工/冻结产品面方案；不改变当前 Site 主线 | 原位保留；获客侧保持冻结 |
| `DOCSET-PHASE-1` | `docs/roadmap/saas-frontend-phase-1/*.md` | L3 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | `c3f0cca` 审计、来源和冲突 provenance | `REFERENCE_ONLY`；当前关系由 governance Registry 承接 |
| `DOCSET-PHASE-2` | `docs/roadmap/saas-frontend-phase-2/*.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-PRODUCT` | Gate 2 论证、选项和批准 provenance | `REFERENCE_ONLY`；批准结果迁入能力/对象/冲突 Registry |
| `DOCSET-PHASE-3` | `docs/roadmap/saas-frontend-phase-3/*.md` | L3 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 3 交付与 Gate 3 审查 | Gate 3 后冻结；Registry 继续维护 |
| `DOCSET-PHASE-4` | `docs/roadmap/saas-frontend-phase-4/*.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 4 交付与 Gate 4 批准 provenance | `REFERENCE_ONLY`；全局规范继续维护 |
| `DOCSET-PHASE-5` | `docs/roadmap/saas-frontend-phase-5/*.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 5 交付与 Gate 5 批准 | `REFERENCE_ONLY` |
| `DOCSET-PHASE-6` | `docs/roadmap/saas-frontend-phase-6/*.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 6 交付与 Gate 6 批准 provenance | `REFERENCE_ONLY` |
| `DOCSET-PHASE-7` | `docs/roadmap/saas-frontend-phase-7/*.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Phase 7 组合、来源和批准 provenance | `REFERENCE_ONLY`；OSS Registry/Card 继续维护 |
| `DOCSET-OSS-ADOPTION` | `docs/platform/oss-adoption/*.md` | L2 / `CURRENT`，来源快照除外 | `OWN-SEC-COMMERCIAL` | Gate 7 已批的 Card 与准入治理 | Registry/Card 持续维护；来源快照不可变 |
| `DOCSET-PHASE-8` | `docs/roadmap/saas-frontend-phase-8/*.md` | L3/L4 / `ACTIVE_INPUT` | `OWN-DOC-GOV` | Phase 8 lint、处置、可用性、证据和 Gate 8 | Gate 8 决定后冻结 |
| `DOCSET-RELEASES` | `docs/releases/*.md` | L4 / Release evidence | `OWN-QA-EVIDENCE` | 真实用户发布 Bundle；当前 0 项 | Bundle 不改写；后续 learning/rollback 建关系 |
| `DOCSET-SITE-ACTIVE` | `docs/site-builder/00`–`09`、`13`、`14` | L1/L2/L3 / `ACTIVE_INPUT` | `OWN-SITE-BE` | Site 产品、架构、合同、施工和评测专题 | 原位保留；状态只由 current/release-plan 承重 |
| `DOCSET-SITE-DECISION-EVIDENCE` | `docs/site-builder/DQ-1-shared-sitespec-contract.md`、`docs/site-builder/handoffs/*.md` | L2/L3 / `FROZEN_EVIDENCE` | `OWN-SITE-BE` | 某决策/施工 handoff 的精确时点 | `REFERENCE_ONLY`；完成后不作为 current status |
| `DOCSET-STATUS-EVIDENCE` | `docs/status/pilot-readiness-gap-report.md` | L3/L4 / `FROZEN_EVIDENCE` | `OWN-PRODUCT` | dated gap report | 原位保留，当前结论回到 `status/current.md` |
| `DOCSET-TEMPLATES` | `docs/templates/*.md` | L5 / `GUIDE` | `OWN-DOC-GOV` | 写作结构；不证明产品/实现 | 旧模板 reference-only；Release/Learning 使用受控模板 |
| `DOCSET-INFRA-GUIDES` | `infra/**/README.md` | L5 / `GUIDE` | `OWN-SITE-BE` | 运行服务任务说明 | 原位保留 |
| `DOCSET-CONTRACT-GUIDES` | `packages/contracts/**/*.md` | L2/L5 / `ACTIVE_INPUT` 或 `GUIDE` | `OWN-SITE-BE` | 契约消费与事件说明 | 机器合同优先；Phase 4/5 建前端映射时只引用 operationId |

`DOCSET-SITE-ACTIVE` 的“00–09”是显式文件集合：`00-decisions-and-coordination.md` 至 `09-m1-implementation-design.md`，不包含 `10`–`12`。

## 4. 兼容、dated 和 superseded 例外

| Registry ID | 路径 | 生命周期 | Owner | 当前解释 | 已映射去向 | 文件动作 |
|---|---|---|---|---|---|---|
| `DOC-HIST-001` | `CLAUDE.md` | `SUPERSEDED` 兼容入口 | `OWN-SITE-BE` | 旧模型/环境/阶段叙述可能过期 | `AGENTS.md` + current authority chain | 保留兼容；不移动 |
| `DOC-HIST-SB-010` | `docs/site-builder/10-model-selection-study.md` | `FROZEN_EVIDENCE` | `OWN-SITE-BE` | dated 模型研究 | `task-routes.ts` + active evidence bundle | 保留证据 |
| `DOC-HIST-SB-011` | `docs/site-builder/11-readdy-component-source-study.md` | `DATED_PROPOSAL` | `OWN-DESIGN` | 组件来源/权利研究 | `ADP-FE-004`；仅多来源净室视觉研究 | 不移动 |
| `DOC-HIST-SB-012A` | `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.1.md` | `SUPERSEDED` | `OWN-DOC-GOV` | 巨型历史提案 | Site 00–14、ADR、status、Phase 5 Site Pack | 已有强 banner；建议原位保留，移动另授权 |
| `DOC-HIST-SB-012B` | `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` | `DATED_PROPOSAL` | `OWN-DOC-GOV` | 巨型 dated 输入，不是施工真值 | Site 00–14、ADR、status/release-plan、Phase 5 Pack | 已有强 banner；建议原位保留，移动另授权 |
| `DOC-HIST-SB-DQ1` | `docs/site-builder/DQ-1-shared-sitespec-contract.md` | `FROZEN_EVIDENCE` | `OWN-SITE-BE` | 已实施决策记录 | `packages/contracts` + SiteSpec current docs | 保留 provenance |
| `DOC-HIST-TEMPLATE-001` | `docs/templates/前端技术方案模板.md` | `REFERENCE_ONLY`，主工作区存在用户删除 | `OWN-DOC-GOV` | 过薄旧模板，分支基线不代表用户要恢复 | 当前规范 + 受控 Release/Learning 模板 | 不触碰主工作区；删除/移动另授权 |

## 5. Word 与平台文档

原文件只作 provenance；迁移表示“事实进入哪个规范主题”，不是把整份 Word 复制或立即移动。

| Source ID | 路径 | 生命周期 | Owner | 已吸收内容 | 剩余迁移去向 | 文件动作 |
|---|---|---|---|---|---|---|
| `SRC-WORD-001` | `docs/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | `DATED_PROPOSAL` | `OWN-PRODUCT` | 用户/JTBD、状态、权限、恢复和运营已进入 Phase 2、4、5、6；OSS/技术候选进入 `ADP-FE-001..031` | 历史范围不复活；采用决定已在 Gate 7 批准，实施仍另过门 | 保留，不移动 |
| `SRC-WORD-002` | `docs/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | `DATED_PROPOSAL` | `OWN-PRODUCT` | 产品叙事、角色和工作方式进入 Phase 2/计划 | 未来产品能力说明和用户/管理员/运营 Guide | 保留，不移动 |
| `SRC-WORD-003` | `docs/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | `SUPERSEDED` | `OWN-PRODUCT` | 仅保留对象/历史场景 provenance | `HISTORY_ONLY`；不得复活旧 SAO/导航/Agent 边界 | 保留，不移动 |
| `SRC-WORD-004` | `docs/platform/全球客户开发与增长执行平台_顶层产品与系统架构设计_v1.0.docx` | `DATED_PROPOSAL` | `OWN-SAAS-PLATFORM` | 系统分层已进入 Phase 4 集成约束和 Phase 6 跨域接缝；外部候选进入 Phase 7 Registry | 具体技术不覆盖 current architecture；Gate 7 组合不授权实现 | 保留，不移动 |
| `SRC-WORD-005` | `docs/platform/全球客户开发与增长执行平台_v3.0文档体系重构与实施治理方案_v1.0.docx` | `FROZEN_EVIDENCE` | `OWN-DOC-GOV` | Gate、RACI、traceability 和来源治理已吸收进计划/Registry | `REFERENCE_ONLY` | 保留，不移动 |

## 6. 本地无版本输入、竞品与外部来源

| Source ID / 集合 | 位置 | 生命周期 | Owner | 当前可用范围 | 迁移/采用去向 |
|---|---|---|---|---|---|
| `SRC-FE-001` | `/global/frontend/project-12080666` | `LOCAL_UNCONTROLLED` | `OWN-SAAS-FE` | React/Vite 页面与交互原型；主要业务 Mock | 正式 repo/Owner 决定后逐页 `Learn/Adapt/Discard`，绝不整体继承 |
| `SRC-FE-002` | `/global/frontend/admin-frontend` | `LOCAL_UNCONTROLLED` | `OWN-SAAS-FE` | 管理端 Mock 参考 | Phase 4 管理/权限边界；不得假定正式管理端 |
| `SRC-FE-003` | `/global/frontend/backend` | `LOCAL_UNCONTROLLED` + 冲突原型 | `OWN-SAAS-PLATFORM` | 旧 Spring identity/API 审计输入 | 与 JWKS/Workspace 冲突，安全处置另立任务，不作为目标 SoR |
| `SRC-DES-001..010` | 主工作区 `template/project-*` | `LOCAL_UNCONTROLLED` / visual reference | `OWN-DESIGN` | 视觉/结构参考，权利未放行 | `ADP-FE-004`：未经书面授权不运行时复用、训练、RAG、蒸馏或商用复用 |
| `SRC-DES-011` | 主工作区 `docs/agile-iteration-flowchart.html` | `LOCAL_UNCONTROLLED` / process proposal | `OWN-QA-EVIDENCE` | 工作方式输入 | Phase 4 质量责任规范；不取消独立证据责任 |
| `SRC-DES-012` | 主工作区 `.playwright-cli/` | `LOCAL_UNCONTROLLED` / runtime artifact | `OWN-QA-EVIDENCE` | 只登记存在 | 不作为受控视觉基线，不修改 |
| `SRC-EXT-GOODJOB-001` | GoodJob `5732e209…` 快照 | `EXTERNAL_REFERENCE` | `OWN-PRODUCT` | 功能设计表达、权限社会属性、指南和工作方式方法 | `ADP-FE-031`；代码/营销/“测试全绿”不成为内部事实 |
| `SRC-OSS-001..020` | Phase 1 OSS 索引 | `EXTERNAL_REFERENCE` | `OWN-SEC-COMMERCIAL` | 官方版本、根许可证与本地关系初审 | 已映射 `ADP-FE-002/003/009..026`；Gate 7 已批决定，逐项准入未关闭 |

外部资料的精确 URL、提交和许可见 [Phase 1 外部审计](../roadmap/saas-frontend-phase-1/external-benchmark-and-oss-audit.md)。

## 7. 按主题的迁移覆盖

| 历史/输入主题 | 当前规范归属 | 后续正式归属 | 未完成条件 |
|---|---|---|---|
| 目标客户、操作者、问题、旅程 | [能力登记](capability-register.md) + Phase 2 provenance | [全局用户/旅程](../frontend/03-users-roles-and-journeys.md) + Site Capability Pack | 一手用户研究仍缺 |
| 一级 IA 与 Site 层级 | `OWN-PRODUCT` 决策 + [能力登记](capability-register.md) | [当前 IA/Shell](../frontend/02-information-architecture.md) | 细节可用性验证未做 |
| Company/Offering/Claim/Evidence/Asset | [核心对象登记](core-object-register.md) | [AI/权限规范](../frontend/08-ai-approval-evidence-and-human-control.md) + [Site 生命周期](../frontend/modules/independent-site-management/lifecycle-permissions-and-state.md) | public Claim 审核/影响合同未完整 |
| Site Build/Release/Preview | current architecture、OpenAPI、[追踪矩阵](traceability-matrix.md) | [Site Capability Pack](../frontend/modules/independent-site-management/README.md) | 正式 SaaS 前端 repo/Owner 未定 |
| Publish/Domain/Rollback/Inquiry/Analytics | [能力登记](capability-register.md)中的 `APPROVED_NOT_BUILT/DEFERRED` | 各自后续 Capability Pack + ADR/契约 | 不得并入当前 preview 承诺 |
| Campaign/Conversation/Opportunity/Outcome | product scope + [核心对象登记](core-object-register.md) | [Phase 6 产品域 Pack](../frontend/modules/README.md)已承接地图；未来独立 Dev-Ready Pack/合同 | 正式 SaaS SoR/repo/Owner 未定 |
| 角色、权限和对象社会属性 | [核心对象登记](core-object-register.md) | [权限与数据可见性](../frontend/06-permissions-and-data-visibility.md) | SaaS/安全/隐私 Owner 和机器合同未定 |
| 失败、恢复、人工兜底 | [场景目录](scenario-catalog.md) | [全局状态](../frontend/07-state-error-degradation-and-recovery.md) + [Site 运营验收](../frontend/modules/independent-site-management/operations-and-acceptance.md) | QA/运营实际 Owner 未指派 |
| OSS、Readdy、外部服务 | Phase 1 外部审计 + [全量 Registry](../backend/oss-registry.md) | `ADP-FE-001..031` 分组 Card 已获 Gate 7 批准 | 实际法务/安全/Owner/退出/生产门未关闭；无实施授权 |
| 发布证据与学习 | [Release/学习治理](release-and-learning-governance.md) + [场景目录](scenario-catalog.md) | `docs/releases/` + 学习记录 | 当前 0 Bundle；Release Owner/指标合同未定 |

## 8. 迁移和归档门

旧文档只有同时满足以下条件才可提出移动、banner 或归档变更：

1. 其承重事实已进入上表指定的唯一规范归属；
2. 所有仓内引用已映射，外部深链风险已记录；
3. successor 有 Document ID、Owner、状态和最后核验点；
4. 历史 provenance、Decision/ADR 和证据仍可追溯；
5. 产品/文档 Owner 明确批准文件动作。

Phase 8 已形成[原位保留建议](../roadmap/saas-frontend-phase-8/history-disposition-proposal.md)：现有强 banner 保留、自动检查，不移动/删除历史文件。未来任何 archive 动作仍需满足本节全部条件并另获授权。
