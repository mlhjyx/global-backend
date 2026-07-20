# 项目文档门户

> 文档 ID：`PORTAL-FE-001`
> 层级：`L1 / Navigation`
> 状态：`CURRENT`
> 维护 Owner：`OWN-DOC-GOV`
> 最后核验：2026-07-20，`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

这是 `/global/backend` 文档的人类入口。项目是统一的出海企业 AI 全球客户开发与增长执行 SaaS；本仓当前主线是 Site Builder 后端能力。“独立站管理”属于统一 SaaS 的一级产品区域，Astro 公开站是它管理的版本化输出，不是平行的第二套 SaaS 前端。

## 1. 五分钟读懂当前项目

按顺序阅读：

1. [产品边界](product-scope.md)：本仓做什么、不做什么、SaaS 与本仓如何分工。
2. [当前状态](status/current.md)：现在真正合入了什么、主线和已知限制。
3. [as-built 架构](architecture/current.md)：当前代码和运行结构。
4. [ADR 注册表](adr/registry.md)：承重决策及其理由。
5. [发布路线](roadmap/release-plan.md)：下一施工顺序。
6. [治理入口](governance/README.md)：能力、对象、场景、冲突和追踪关系。
7. [统一 SaaS 前端规范](frontend/README.md)：Gate 4 已批准的 IA、Shell、权限、状态、AI、设计和交付目标规则。
8. [全 SaaS Capability Pack](frontend/modules/README.md)：完整产品域的人类入口；独立站管理保持 Gate 5 深度，其他域保持地图级诚实状态。

任何“已完成”声明都必须回到上述主题 Owner、机器契约和证据核验。不要从旧 Word、研究稿、本地原型或历史 worktree 推导当前实现。

## 2. 按角色阅读

### 产品负责人

- [产品边界](product-scope.md)
- [能力登记](governance/capability-register.md)
- [核心对象登记](governance/core-object-register.md)
- [冲突登记](governance/conflict-register.md)
- [统一 SaaS 文档治理计划](roadmap/saas-frontend-documentation-program-plan.md)
- 当前 Gate：[Phase 6 评审](roadmap/saas-frontend-phase-6/gate-6-review.md)

### 产品设计与前端

- [统一 SaaS 前端规范入口](frontend/README.md)
- [页面与能力人类目录](frontend/04-page-and-capability-catalog.md)
- [设计系统与内容规范](frontend/09-design-system-and-content-guidelines.md)
- [设计资产与微文案治理](design/README.md)
- [术语与状态](governance/terminology-and-status.md)
- [场景目录](governance/scenario-catalog.md)
- [追踪矩阵](governance/traceability-matrix.md)
- [前端合同与接入规则](frontend/11-frontend-contracts-and-integration.md)；机器真值为 `packages/contracts/openapi/openapi.json`
- [独立站管理旅程与页面](frontend/modules/independent-site-management/journeys-and-page-spec.md)
- [独立站管理低保真线框](design/independent-site-management-wireframes.md)
- [独立站管理实施蓝图](frontend/implementation/independent-site-management-blueprint.md)

注意：`/global/frontend/project-12080666` 是无 Git provenance 的 React/Vite Mock 原型；正式 SaaS 前端仓库、设计 Owner、设计 Token 和部署事实源尚未确定。它不能作为 as-built 或正式视觉规范。

### Site Builder 后端与契约

- [Site Builder 决策入口](site-builder/00-decisions-and-coordination.md)
- [Site Builder PRD](site-builder/01-prd.md)
- [Site Builder 架构](site-builder/02-architecture.md)
- [SiteSpec 契约说明](site-builder/04-sitespec-contract.md)
- [API 合同说明](site-builder/07-api-contract-draft.md)
- [M1 实施设计](site-builder/09-m1-implementation-design.md)
- [R1-min handoff](site-builder/handoffs/r1-min-execution-brief.md)
- [公开站输出目标规范](frontend/modules/independent-site-management/public-site-output-spec.md)

### QA 与证据

- [场景目录](governance/scenario-catalog.md)
- [追踪矩阵](governance/traceability-matrix.md)
- [响应式、a11y 与性能](frontend/10-responsive-accessibility-and-performance.md)
- [分析、测试与发布证据](frontend/12-analytics-testing-and-release-evidence.md)
- [Site Builder 评测与测试](site-builder/08-eval-testing.md)
- [Temporal 测试记录](implementation-records/temporal-workflow-testing.md)
- [独立站管理运营与验收](frontend/modules/independent-site-management/operations-and-acceptance.md)
- [模型路由 active evidence](evidence/model-routing/model1-brand-profile-20260719-v20/README.md)

### 运营、客服与管理员

- [当前状态](status/current.md)
- [核心对象与社会属性](governance/core-object-register.md)
- [权限与数据可见性](frontend/06-permissions-and-data-visibility.md)
- [状态、错误、降级与恢复](frontend/07-state-error-degradation-and-recovery.md)
- [场景中的失败恢复与人工兜底](governance/scenario-catalog.md)
- [Compose 项目迁移 runbook](backend/compose-project-migration.md)
- [Worktree 管理 runbook](backend/worktree-management.md)

面向终端用户、管理员和运营的正式 Guide 将在相应 Capability 达到后续 Gate 时建设；当前工程文档不能替代用户指南。

## 3. 产品地图与当前深度

已批准的一级 IA：

```text
今日
客户开发
独立站管理
增长执行
互动与商机
洞察
```

| 区域 | 当前文档/实现深度 | 说明 |
|---|---|---|
| 今日与公共 Shell | 产品地图已批准；正式 SaaS 实现未知 | 身份、Workspace、Entitlement 和 UI 归 SaaS |
| 客户开发 | 后端有真实能力但新增开发冻结；SaaS 页面为 Mock | 本仓止于 `LeadQualifiedPackage` |
| 独立站管理 | 当前主线；后端 intake/profile/asset/KB/build/preview 深度最高 | 首个用户承诺只到可信开发预览 |
| 增长执行 | 产品地图保留；实现归 SaaS/外部 | Campaign、Content、Publish 等未在本仓建 SoR |
| 互动与商机 | 产品地图保留；实现归 SaaS/外部 | Conversation、Opportunity、QGO/SAO、Outcome 不归本仓 |
| 洞察 | 目标读模型；Site 有局部成本事实 | 不得使用 Mock 图表充当指标真值 |

完整多轴状态见 [能力登记](governance/capability-register.md)。

## 4. 独立站管理当前承诺

批准优先建设的产品纵切是：

```text
资料与信任
→ Build / 取消 / 失败恢复
→ active READY Release 支撑的可信开发预览
```

当前不承诺公网发布、域名/SSL、用户可操作回滚、询盘、站点分析、诊断、任意语言、任意风格或“生产就绪”。内部 `SiteRelease` 地基存在不等于公开发布能力存在。

## 5. 文档类型与使用方式

| 类型 | 用途 | 当前入口 |
|---|---|---|
| Normative/权威 | 当前生效的边界、架构、决策、状态和规范 | 本页 §1 |
| Registry/Contract | ID、状态、Owner、关系和机器合同 | [governance/](governance/README.md)、`packages/contracts/` |
| Evidence | 审计、实现、测试、真机和发布证明 | `docs/evidence/`、`implementation-records/`、Phase 1 |
| Guide | 面向某类用户完成任务 | `docs/backend/`、后续 Capability Guide |
| History/Input | Word、研究、dated proposal、原型和冻结 Gate 包 | [文档登记](governance/document-register.md) |

Phase 1/2 的 roadmap 包是冻结审计与决策 provenance，不是第二套 current Registry。未来正式前端文档只能引用已登记 ID 和事实 Owner。

## 6. 不应作为当前真值的材料

- `docs/site-builder/12-...v3.1.md` 与 `v3.2.md`：dated/superseded proposal。
- 五份 Word：历史或待批准输入，按主题迁移，不整体升级为 PRD。
- `docs/research/`：研究与方案输入。
- `/global/frontend`、`template/`、未跟踪 HTML 和 Playwright 资产：本地无版本或用户现场，只读。
- 历史 worktree/分支：provenance，不等于 main。
- GoodJob、竞品和 OSS：方法与选型输入，不等于我们的范围或实现。

每一类的 Owner、状态和未来去向见 [文档登记](governance/document-register.md)。

## 7. 当前执行 Gate

- Gate 1：通过，Phase 1 冻结。
- Gate 2：通过，推荐组合已批准。
- Gate 3：通过，Phase 3 Registry 已建立。
- Gate 4：通过，`DEC-FE-P4-001..011` 已批准，`BLK-FE-001..007` 保留。
- Phase 5：已通过 Gate 5；当前纵切仍 `SPEC_READY_WITH_BLOCKERS`，后置链仍 `TARGET_NOT_RUNNABLE`。
- Phase 6：已授权并完成全 SaaS 产品域文档交付，当前准备 Gate 6 评审。
- Phase 7–8：未授权。

进入下一阶段前请从 [Gate 6 评审包](roadmap/saas-frontend-phase-6/gate-6-review.md)检查 12 项推荐决定、完整产品覆盖、优先级、跨域缺口和未关闭 blocker。
