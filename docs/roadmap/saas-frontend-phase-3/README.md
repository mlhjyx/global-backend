# Phase 3 文档治理底座

> 文档 ID：`GATE-FE-P3-000`
> 状态：`READY_FOR_GATE_3_REVIEW`
> 授权：产品负责人于 2026-07-20 明确“Gate 2 通过，按推荐组合授权 Phase 3”
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 施工分支：`codex/saas-frontend-doc-plan`

Phase 3 把 Phase 1 的审计证据和 Phase 2 的批准决策迁入可持续维护的唯一 Registry。它不创建正式 PRD/UX/前端技术方案，不修改产品代码，也不移动历史或用户材料。

## 1. 规范产物

规范事实不复制到本目录；当前入口是：

1. [项目文档门户](../../README.md)
2. [治理入口](../../governance/README.md)
3. [文档与来源登记](../../governance/document-register.md)
4. [术语、状态与责任词典](../../governance/terminology-and-status.md)
5. [能力登记](../../governance/capability-register.md)
6. [核心对象登记](../../governance/core-object-register.md)
7. [标准场景与 Fixture 目录](../../governance/scenario-catalog.md)
8. [冲突与开放决策登记](../../governance/conflict-register.md)
9. [端到端追踪矩阵](../../governance/traceability-matrix.md)

本目录只保存阶段审查 provenance：[Gate 3 评审包](gate-3-review.md)。Gate 3 通过后，Registry 继续作为 current；本目录冻结为 Phase 3 交付记录。

## 2. Gate 2 决策迁移结果

- 目标客户、默认操作者和六项一级 IA 进入 Capability/traceability 关系。
- Company/Offering/Claim/Evidence/Asset 共享事实底座及 27 个对象进入 core object registry。
- 首个纵切拆成稳定 Site child Capability ID，终点固定为可信开发预览。
- Claim 审核保持 fail-closed；public review contract 缺失进入 blocker。
- Publish/Domain/Rollback/Inquiry/Analytics 保留在完整产品地图，但显式标为后置/不可运行。
- 指标与反指标方向保留批准状态；事件、基线、目标、隐私和数据 Owner 仍是条件。
- 正式 SaaS 前端仓库和设计事实源继续 `INPUT_BLOCKED`，没有被 Phase 3 补猜。

## 3. 唯一事实模式

```text
权威边界/架构/ADR/状态/机器契约
                ↓
  Registry：ID、状态、Owner、关系、迁移
                ↓
正式 Spec / Capability Pack / Guide / Release Bundle
```

Phase 1/2 是 Evidence/Decision provenance；Word、研究、竞品、本地原型和历史 worktree 是输入或历史；未来正式 `docs/frontend/` 只能引用 Registry，不创建平行清单。

## 4. 本阶段未做

- 未进入 Phase 4–8；未创建 `docs/frontend/`。
- 未写正式 IA、权限、状态、AI、设计系统、微文案、响应式、a11y、埋点或发布规范。
- 未写独立站 Dev-Ready PRD/UX/前端技术方案。
- 未创建真实 Fixture、前端 E2E、设计资产、用户指南或 Release Bundle。
- 未修改代码、Schema、migration、OpenAPI、基础设施、依赖或配置。
- 未移动、删除、归档、重命名或加 banner 到 Word、v3.1/v3.2、原型、分支或 worktree。
- 未触碰主工作区已删除模板和未跟踪 `.playwright-cli/`、HTML、`template/`。
- 未 push、建 PR 或合并。

## 5. 下一步

只从 [Gate 3 评审包](gate-3-review.md)审查唯一 Owner、迁移覆盖、追踪完整性和未指派 blocker。收到产品负责人明确 `Gate 3 通过，授权 Phase 4` 前停止施工。
