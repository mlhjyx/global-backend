# Phase 6 全 SaaS 产品域文档包

> 文档 ID：`GATE-FE-P6-000`
> 层级：`L3 / Phase evidence`
> 状态：`READY_FOR_GATE_6_REVIEW`
> 授权：产品负责人于 2026-07-20 通过 Gate 5，批准 `DEC-FE-P5-001..010`，保留 `BLK-FE-001..007` 并授权 Phase 6 文档工作
> 当前授权终点：Gate 6；未获批准不得进入 Phase 7–8 或任何产品实现

## 1. Phase 6 解决的问题

Gate 5 已把独立站管理写到模块规格层，但完整 SaaS 仍有多个域只存在于 Word、页面目录或 Mock 原型。Phase 6 把这些域补成“地图完整、边界明确、状态诚实”的 Capability Pack，使任何读者都能知道：用户为何进入、对象由谁拥有、上下游怎么交接、当前有什么机器证据、失败后怎么办、进入 Dev-Ready 前还缺什么。

## 2. 交付物

- [全 SaaS Capability Pack 入口](../../frontend/modules/README.md)
- [Workspace Shell 与今日](../../frontend/modules/workspace-shell-and-today/README.md)
- [企业、产品与信任](../../frontend/modules/enterprise-trust-and-knowledge/README.md)
- [市场与客户开发](../../frontend/modules/buyer-development/README.md)
- [增长执行](../../frontend/modules/growth-execution/README.md)
- [互动与商机](../../frontend/modules/engagement-and-opportunity/README.md)
- [洞察与学习](../../frontend/modules/insights-and-learning/README.md)
- [团队、集成、设置与运营](../../frontend/modules/team-integrations-settings-and-operations/README.md)
- [产品组合覆盖与优先级](portfolio-coverage-and-priority.md)
- [跨域接缝与缺口](cross-domain-handoffs-and-gaps.md)
- [历史来源迁移覆盖](source-migration-coverage.md)
- [Gate 6 评审包](gate-6-review.md)

治理 Registry 同步承接文档、Capability、Scenario、追踪和批准状态；Phase 1–5 冻结证据包保持 provenance，不用 Phase 6 重写历史时点。

## 3. 交付深度

| 类型 | Phase 6 要求 | Phase 6 不做 |
|---|---|---|
| 当前 Site 纵切 | 引用 Gate 5 已批规格和 blocker | 不改承诺、不实现、不扩到公开发布 |
| 冻结客户开发 | 用户闭环、Page/Object/合同/接缝/限制完整 | 不恢复新增开发，不造正式前端 |
| SaaS 外部目标域 | 用户结果、边界、目标状态、失败恢复、开放输入完整 | 不虚构 SoR/API/Owner/指标，不称 Dev-Ready |
| Shell/企业事实/控制面 | 说明跨域基础、社会属性和安全默认 | 不选框架、设计工具、身份方案、Billing 或 OSS |
| 来源迁移 | Word/GoodJob/Mock/代码内容均有去向 | 不移动历史文件，不把来源整体升级为 current |

## 4. 不漂移约束

- 当前唯一施工主线仍是 Site Builder；Phase 6 文档不会用历史“大而全”路线稀释当前优先级。
- 一级 IA 继续是“今日/客户开发/独立站管理/增长执行/互动与商机/洞察”；企业事实为横切对象上下文，团队/集成/设置/运营在 Shell 控制面。
- 本仓 Buyer Intelligence 继续止于 `LeadQualifiedPackage`；Campaign、发送/发布、Conversation、Opportunity/QGO/SAO、Outcome、Attribution 归 SaaS。
- `MAP_COMPLETE` 只表示没有失踪能力，不表示设计、前端、API、测试、部署或用户可用。
- `BLK-FE-001..007` 全部保留；Phase 6 新发现以 `GAP-FE-P6-*` 登记，不擅自补成事实。
- Phase 7 才处理 OSS/外部能力采用决策；Phase 8 才执行 lint/归档提案/Release Bundle 收口。

## 5. Gate 6

Gate 6 只批准产品组合覆盖、域边界、优先级、目标接缝和地图级工作簿。它不授权产品代码、Schema、OpenAPI、基础设施、依赖、外部账号、设计工具、历史文件移动、push、PR 或合并。

收到明确 Gate 6 决定前，停止 Phase 7–8。

