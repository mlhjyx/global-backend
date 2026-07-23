# 统一 SaaS 前端规范入口

> 文档 ID：`FE-GLOBAL-000`
> 层级：`L2 / Navigation`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-DESIGN`
> 工程基线：`origin/main@73f08f9f6b474b16a92e139f2c83cffcc8a6fb92`
> 最后核验：2026-07-23

本目录定义整个 SaaS 共用的目标前端规则，回答“不同产品域如何保持一致”。它是交给独立前端团队的产品与工程约束，不是本仓已实现的前端，也不替代产品边界、as-built 架构、ADR、状态或机器合同。

## 1. 当前效力

- `DEC-FE-P4-001..011` 继续有效；批准结论统一在[冲突登记](../governance/conflict-register.md)维护。
- 正式 SaaS 前端仓库、CI、部署、设计事实源、Token 数值、组件库和实际 Owner 尚未定位。
- 本地 Mock、Readdy、模板、截图和竞品只能作为参考，不能证明页面、组件或视觉规范已经交付。
- 独立站管理是统一 SaaS 的一级区域；Astro 公开站是版本化输出，不是第二套管理前端。
- 除独立站管理外，其他产品域当前只完成地图级覆盖，仍为 `MAP_COMPLETE / NOT_DEV_READY`。

## 2. 按任务阅读

| 读者/任务 | 建议顺序 |
|---|---|
| 产品与交互设计 | [体验原则](01-product-experience-principles.md) → [IA](02-information-architecture.md) → [用户与旅程](03-users-roles-and-journeys.md) → [页面能力](04-page-and-capability-catalog.md) |
| 前端与平台接入 | [Shell](05-navigation-and-workspace-shell.md) → [权限](06-permissions-and-data-visibility.md) → [状态恢复](07-state-error-degradation-and-recovery.md) → [合同接入](11-frontend-contracts-and-integration.md) |
| AI、事实与审批 | [AI、Evidence 与人工控制](08-ai-approval-evidence-and-human-control.md) |
| 设计系统与内容 | [设计系统与内容](09-design-system-and-content-guidelines.md) → [微文案目录](../design/content-and-microcopy-catalog.md) → [独立站线框](../design/independent-site-management-wireframes.md) |
| QA、发布与运营 | [响应式、a11y 与性能](10-responsive-accessibility-and-performance.md) → [分析、测试与发布证据](12-analytics-testing-and-release-evidence.md) |
| 决策与阻塞处理 | [冲突登记](../governance/conflict-register.md) → [ADR](../adr/registry.md) |
| 独立站管理开发 | [Capability Pack](modules/independent-site-management/README.md) → [实施蓝图](implementation/independent-site-management-blueprint.md) |

## 3. 规范文件

| 文档 | 唯一主题 |
|---|---|
| [01](01-product-experience-principles.md) | 产品体验原则和反模式 |
| [02](02-information-architecture.md) | 完整 SaaS IA、对象上下文和深链 |
| [03](03-users-roles-and-journeys.md) | 用户、责任帽子、JTBD、旅程和研究缺口 |
| [04](04-page-and-capability-catalog.md) | 整个项目的页面/能力人类目录 |
| [05](05-navigation-and-workspace-shell.md) | 全局导航、Workspace Shell 和跨页面面板 |
| [06](06-permissions-and-data-visibility.md) | 授权、数据社会属性、可见性和危险动作 |
| [07](07-state-error-degradation-and-recovery.md) | 统一状态、错误、长任务、并发和恢复 |
| [08](08-ai-approval-evidence-and-human-control.md) | AI 任务、Evidence、Approval、授权和人工控制 |
| [09](09-design-system-and-content-guidelines.md) | 设计 Token、组件、资产和内容交付合同 |
| [10](10-responsive-accessibility-and-performance.md) | 响应式、a11y、性能、国际化和浏览器策略 |
| [11](11-frontend-contracts-and-integration.md) | 身份、OpenAPI、事件、缓存、安全和漂移门 |
| [12](12-analytics-testing-and-release-evidence.md) | 埋点、测试、场景、Release evidence 和学习闭环 |

## 4. 使用规则

1. 新模块先引用共用 Shell、权限、状态、AI、内容和质量模式，只写业务差异。
2. Capability、Page、Scenario、Object 和 Owner 使用[治理入口](../governance/README.md)中的稳定 ID；不得另建平行清单。
3. “已设计”至少需要受控设计源、资产版本、关键状态、响应式与 a11y 标注；Markdown 规格不等于视觉设计。
4. “用户可用”至少需要正式入口、真实合同、相称 E2E、部署与 Release evidence；Mock、截图或模板不计。
5. 未决事项只登记在[冲突登记](../governance/conflict-register.md)，阶段评审过程保留在 Git/PR，不再生成常驻 Gate 文档。

## 5. 当前承接边界

- 独立站管理当前纵切是 `SPEC_READY_WITH_BLOCKERS`；后置公网发布链仍为 `TARGET_NOT_RUNNABLE`。
- 其他非 Site 产品域仍是 `MAP_COMPLETE / NOT_DEV_READY`；客户开发继续 `FROZEN_MAP_ONLY`。
- 不决定 React/Next/Vite、BFF、UI 库、状态库、分析 SDK、i18n 库或设计工具。
- 不生成高保真页面、生产 Token 数值、可执行 Fixture 或部署声明。
- 不把首个用户承诺扩展到公网发布、域名、回滚、询盘、站点分析或诊断。
- 不修改产品代码、OpenAPI、Schema、迁移、基础设施、依赖或运行配置。
