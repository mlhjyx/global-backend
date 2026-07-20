# 统一 SaaS 前端规范入口

> 文档 ID：`FE-GLOBAL-000`
> 层级：`L2 / Navigation`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> 内容 Owner：`OWN-DESIGN`
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 最后核验：2026-07-20

本目录把 Gate 2 批准的统一 SaaS 产品体验和 Gate 3 的治理 Registry 转成可供所有产品域复用的前端规则。它回答“整个 SaaS 的前端如何保持一致”，不提前代替独立站管理的模块 PRD、页面级 UX 或实施方案。

## 1. 当前效力

- 本包是 Gate 4 的规范候选；Gate 4 通过前仍是 `ACTIVE_INPUT`，不能称为已生效设计系统或 as-built 前端。
- 产品边界、架构、ADR、状态和机器合同仍分别以 [权威链](../README.md#1-五分钟读懂当前项目)为准；本目录只消费这些事实。
- 正式 SaaS 前端仓库、CI、部署、设计 Owner、设计事实源、Token 数值和组件库均未定位。本包定义约束、交付合同和安全默认，不虚构现有实现。
- `/global/frontend`、Readdy、模板、截图和竞品只可作为已登记参考，不能证明页面、组件或视觉规范已经交付。
- 独立站管理是统一 SaaS 的一级区域；Astro 站是版本化输出，不是第二套管理前端。

## 2. 阅读路线

| 读者 | 建议顺序 |
|---|---|
| 产品/设计 | [范围与权威](00-scope-authority-and-status.md) → [体验原则](01-product-experience-principles.md) → [IA](02-information-architecture.md) → [用户与旅程](03-users-roles-and-journeys.md) → [页面能力](04-page-and-capability-catalog.md) |
| 前端/平台 | [Shell](05-navigation-and-workspace-shell.md) → [权限](06-permissions-and-data-visibility.md) → [状态恢复](07-state-error-degradation-and-recovery.md) → [合同接入](11-frontend-contracts-and-integration.md) |
| AI/事实/审批 | [AI、Evidence 与人工控制](08-ai-approval-evidence-and-human-control.md) |
| 设计/内容 | [设计系统与内容](09-design-system-and-content-guidelines.md) → [设计资产登记](../design/design-asset-register.md) → [微文案目录](../design/content-and-microcopy-catalog.md) |
| QA/发布/运营 | [响应式、a11y 与性能](10-responsive-accessibility-and-performance.md) → [分析、测试与发布证据](12-analytics-testing-and-release-evidence.md) |
| 决策者 | [开放决策](13-open-decisions.md) → [Gate 4 评审](../roadmap/saas-frontend-phase-4/gate-4-review.md) |

## 3. 规范文件

| 文档 | 唯一主题 |
|---|---|
| [00](00-scope-authority-and-status.md) | 范围、事实层、状态与非目标 |
| [01](01-product-experience-principles.md) | 产品体验原则和反模式 |
| [02](02-information-architecture.md) | 完整 SaaS IA、对象上下文和深链 |
| [03](03-users-roles-and-journeys.md) | 用户、责任帽子、JTBD、旅程和研究缺口 |
| [04](04-page-and-capability-catalog.md) | 整个项目的前端页面/能力人类目录 |
| [05](05-navigation-and-workspace-shell.md) | 全局导航、Workspace Shell 和跨页面面板 |
| [06](06-permissions-and-data-visibility.md) | 授权、数据社会属性、可见性和危险动作 |
| [07](07-state-error-degradation-and-recovery.md) | 统一状态、错误、长任务、并发和恢复 |
| [08](08-ai-approval-evidence-and-human-control.md) | AI 任务、Evidence、Approval、授权和人工控制 |
| [09](09-design-system-and-content-guidelines.md) | 设计 Token/组件/资产/内容交付合同 |
| [10](10-responsive-accessibility-and-performance.md) | 响应式、a11y、性能、国际化和浏览器策略 |
| [11](11-frontend-contracts-and-integration.md) | 身份、OpenAPI、事件、缓存、安全和漂移门 |
| [12](12-analytics-testing-and-release-evidence.md) | 埋点、测试、场景、Release Bundle 和学习闭环 |
| [13](13-open-decisions.md) | 未关闭决策、Owner、默认值和阻止范围 |

## 4. 使用规则

1. 新模块先引用本包的 Shell、权限、状态、AI、内容和质量模式；只有证明全局模式不适用时才提出例外。
2. 模块文档只写差异和业务特有状态，不复制本包全文。
3. 每个 Capability/Page/Scenario/Object/Design Asset/Microcopy 都使用稳定 ID，并可回到 [治理入口](../governance/README.md)。
4. “已设计”至少需要受控设计源、资产版本、关键状态、响应式和 a11y 标注；Markdown 需求不等于视觉设计。
5. “用户可用”至少需要正式前端入口、真实合同、相称 E2E、部署和 Release evidence；Mock 或截图不计。

## 5. Phase 4 明确不做

- 不写 `docs/frontend/modules/` 的模块 Dev-Ready 规格；独立站管理属于 Phase 5。
- 不决定 React/Next/Vite、BFF、UI 库、状态库、分析 SDK、i18n 库或设计工具。
- 不生成高保真页面、HTML 原型、Figma 文件、生产 Token 数值或可执行 Fixture。
- 不扩展首个用户承诺到公网发布、域名、回滚、询盘、站点分析或诊断。
- 不修改产品代码、OpenAPI、Schema、迁移、基础设施、依赖或运行配置。
