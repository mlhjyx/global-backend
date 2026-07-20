# Phase 4 全局前端规范

> 文档 ID：`GATE-FE-P4-000`
> 状态：`READY_FOR_GATE_4_REVIEW`
> 授权：产品负责人于 2026-07-20 明确“Gate 3 通过，授权 Phase 4”
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 施工分支：`codex/saas-frontend-doc-plan`

Phase 4 将 Gate 2 的产品/IA 决策和 Gate 3 的 Registry 转成完整 SaaS 可复用的前端规范候选。它解决跨模块 Shell、权限、状态、AI/Evidence/Approval、设计、内容、a11y、性能、接入、测试和发布门，不提前进入独立站管理页面级 Dev-Ready。

## 1. 规范产物

- [统一 SaaS 前端规范入口](../../frontend/README.md)：15 份全局前端文档。
- [设计资产与内容治理](../../design/README.md)：设计资产登记、微文案目录和待创建视觉资产。
- [Gate 4 评审包](gate-4-review.md)：决定、验收、blocker 和边界证明。

## 2. 形成的复用基线

- 六项 IA、Workspace Shell、Today、canonical object 与深链规则；
- capability/entitlement/authorization/data scope/Approval/execution authorization 分层；
- 20 个统一页面/任务状态和错误/恢复内容合同；
- AI task、事实/推断/建议/草稿、Evidence、Review、Approval 和外部执行控制链；
- Semantic Token/组件交付合同、10 类产品模式、15 个设计资产记录和 16 条关键 Copy ID；
- WCAG 2.2 AA、键盘/读屏/缩放/reflow、响应式、国际化和性能质量门；
- OpenAPI/event/幂等/ETag/错误/长任务/cache/security 的消费规则；
- analytics、Fixture、测试层级、Release Bundle 和发布后学习闭环。

## 3. 当前不是实现证明

正式 SaaS 前端仓库、设计事实源、Token 数值、组件库、Workspace/allowed actions、Claim public review、事件/隐私合同和实际 QA/运营/安全 assignee 仍缺失。书面规范和设计资产记录不等于高保真设计、组件实现、E2E、部署或用户可用。

## 4. 本阶段未做

- 未创建 `docs/frontend/modules/`、Site Capability Pack、页面级 UX、公开站输出规范或前端实施方案。
- 未生成 Figma/HTML/高保真稿、视觉 Token 数值、组件代码、可执行 Fixture 或真实 Release Bundle。
- 未选择 framework、BFF、UI 库、设计工具、analytics/i18n/observability 供应商或 OSS。
- 未修改代码、测试、Schema、migration、OpenAPI、基础设施、依赖或配置。
- 未移动、删除、归档或重命名 Word、历史稿、原型、分支或 worktree。
- 未触碰主工作区用户删除/未跟踪材料；未 push、建 PR 或合并。

## 5. 下一步

只从 [Gate 4 评审包](gate-4-review.md)审查 `DEC-FE-P4-001..011`、全局模式复用、设计资产追踪和 blocker。收到产品负责人明确 Gate 4 决策前停止 Phase 5–8。
