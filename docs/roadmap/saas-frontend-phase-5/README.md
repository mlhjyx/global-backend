# Phase 5 独立站管理 Capability Pack

> 文档 ID：`GATE-FE-P5-000`
> 状态：`FROZEN_EVIDENCE / APPROVED_AT_GATE_5`
> 授权：产品负责人于 2026-07-20 通过 Gate 4，批准 `DEC-FE-P4-001..011`，保留 `BLK-FE-001..007` 并授权 Phase 5
> 批准：产品负责人于 2026-07-20 批准 `DEC-FE-P5-001..010`、两 lane 状态并授权 Phase 6 文档工作
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 施工分支：`codex/saas-frontend-doc-plan`

Phase 5 把独立站管理从全产品地图推进到模块级产品/UX/接入/运营规格，同时保持实现真值边界。它没有把“整个独立站”笼统标为 Dev-Ready，而是拆成当前可信开发预览纵切与目标发布链。

## 1. 交付物

- [Capability Pack 入口](../../frontend/modules/independent-site-management/README.md)
- [用户旅程与页面规格](../../frontend/modules/independent-site-management/journeys-and-page-spec.md)
- [对象生命周期、权限与状态](../../frontend/modules/independent-site-management/lifecycle-permissions-and-state.md)
- [公开站输出规范](../../frontend/modules/independent-site-management/public-site-output-spec.md)
- [运营与验收](../../frontend/modules/independent-site-management/operations-and-acceptance.md)
- [低保真线框](../../design/independent-site-management-wireframes.md)
- [前端实施蓝图](../../frontend/implementation/independent-site-management-blueprint.md)
- [Gate 5 评审包](gate-5-review.md)

## 2. 核心结论

| Lane | 文档轴 | 实现/用户轴 | 结论 |
|---|---|---|---|
| Intake/Profile/Asset/KB/Build/Cancel/Recovery/Preview | `APPROVED_AT_GATE_5` | 正式 FE `NONE`；后端合同/服务有不同深度证据 | `SPEC_READY_WITH_BLOCKERS` |
| Site Claim review/impact | 交互和 fail-closed 已规格化 | Site public closure 缺 | `BLOCKED` |
| Editor/Version/Publish/Domain/Inquiry/Analytics | 目标页面/依赖/状态已记录 | public objects/contracts/infra/privacy 缺 | `TARGET_NOT_RUNNABLE` |
| Astro public output | 目标内容/a11y/SEO/perf/security 已规格化 | renderer 地基 partial；production chain 缺 | `PARTIAL_AS_BUILT_TARGET_SPECIFIED` |

## 3. 本阶段建立的交接

- `PAGE-FE-030..043` 有 journey、manifest、状态、动作、Copy、responsive、a11y 和 Scenario 映射；
- `PAGE-FE-044..057` 有目标结果、状态和依赖，但没有被点亮为当前承诺；
- Site/Profile/Asset/KB/Claim/Build/Release/Preview/Public service 的状态与 SoR 不再混写；
- 13 个机器 contract operation 被映射到 stack-neutral client/state/upload/build/preview 架构；
- `DSA-FE-SITE-WF-001` 已有 10 个书面低保真线框，仍不标 `DESIGNED`；
- `COPY-FE-SITE-001..029` 已登记为 `DRAFT_SOURCE_COPY`；
- `SCN-FE-SITE-001..018` 有产品/UX验收入口，019..023 保持不可运行；Fixture 仍未创建；
- 指标和事件只保持方向/hypothesis，不接 SDK、不设假目标。

## 4. 没有做

- 未修改前端/后端代码、测试、Schema、migration、OpenAPI、基础设施、依赖或配置；
- 未选择技术栈、BFF、UI library、design tool、analytics/i18n/observability vendor；
- 未生成 Figma/HTML/高保真、Token values、组件库、Fixture 或 Release Bundle；
- 未关闭 `BLK-FE-001..007`，未将责任帽子冒充实际 assignee；
- 未移动/删除/归档 Word、历史稿、原型、分支或 worktree；
- 未触碰 main checkout 用户删除/未跟踪现场；未 push、建 PR 或合并；
- 未进入 Phase 6–8 或任何产品实现。

## 5. Gate 5

Gate 5 只评审 Phase 5 文档、状态分层和实施依赖。推荐批准后，当前纵切仍不能直接施工，除非另行提供正式 repo/Owner、设计源、allowed-actions/Claim 合同和真实 QA/Ops。后置发布链继续走各自 Capability Gate。

Gate 5 已通过。本目录冻结为批准 provenance；Phase 6 只承接其他产品域文档，不修改本包状态或授权实现。
