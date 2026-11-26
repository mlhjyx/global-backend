---
date: 2026-11-26
pr:
title: refactor(slimming): 抽离获客复用工具至中立目录、切断 site-builder 反向依赖并新增 SITE_BUILDER_ENABLED 运行时开关
---

- 起因：Wave 4 S3 架构解绑瘦身——获客主线（`seller-knowledge`、`discovery`、`durable-results`、`enrichment`、`platform-authority`、`tools`、`workspace-purge`）历史上直接反向引用已冻结的 `site-builder/` 目录，且 API 与 Worker 默认静态装配 `SiteBuilderModule` 与 4400+ 行 `site-builder.activities.ts`（含重型图片管线与浏览器探针），拖累纯获客部署的内存与冷启动。
- 改动：
  - 将 8 个跨领域复用的基础设施客户端与纯工具迁至中立目录：`apps/api/src/infra-clients/`（`storage.service.ts`、`object-key.ts`、`docling.client.ts`、`embeddings.client.ts`、`kb-errors.ts`，完整保留 `#1128` 分页/OCR/图像提取与 M10-PR2 租户并发信号量）与 `apps/api/src/common/`（`chunker.ts`、`pii-scrub.ts`、`evidence-ref.ts`、`paid-cost-ledger-contract.ts`）以及 `apps/api/src/model-gateway/paid-cost-context.ts`；在原 `site-builder/` 路径保留极薄 re-export shim，避免大改冻结代码与旧建站测试。
  - 将 24 个非建站生产文件的 import 改指新中立目录，同步收紧 `docs/governance/ci-baselines/g16-module-boundaries.json`，永久移除 `seller-knowledge`/`discovery`/`durable-results`/`enrichment`/`platform-authority`/`tools`/`(root)` 指向 `site-builder` 的 7 条反向运行时依赖边。
  - 新增运行时开关 `SITE_BUILDER_ENABLED=true|false`（默认 `true`，保持现有 OpenAPI 导出、`oasdiff`、`renderer visual` CI 与全部旧测试 100% 兼容）：通过 `SiteBuilderFeatureModule.register()`（`AppModule`）、`loadSiteBuilderWorkerActivities()`（`temporal/worker.ts`）、`settlementReadbackConfigured`、`ManagedDependencyReadinessContributors` 与 `SweepSchedulerService` 在 `SITE_BUILDER_ENABLED=false` 时零加载 `SiteBuilderModule`、`site-builder.activities.ts`、图片管线与 `siteBuilderStorage` 生命周期探针，将 5 个建站 readiness contributor（`storage`/`budget_grant_verification`/`site_builder_model_settlement_readback`/`browser`/`renderer`）注册为无副作用 `ok` 以确保 `/health/ready` 与 `RuntimeWorkAdmissionGuard` 不拦截获客写接口，并跳过 3 个建站周期 sweep 派发。
  - 在 ContractGraph 按 `DETERMINISTIC_TEST` 登记建站 API 模块动态装配，以现有开关双模式测试为依据。改写触发动态导入误报的注释。
  - 关闭建站后，空间清理仍通过现有对象存储客户端删除历史站点对象。有历史站点目标时先检查存储，在检查失败时保留用于定位对象的数据库记录。
- 测试：
  - 仅单测通过：新增 `apps/api/src/runtime/w4-s3-site-builder-decoupling.spec.ts` 验证双模式装配、零反向导入与 shim 符号一致性；复跑 `@global/contracts` + `@global/api` 全量构建、OpenAPI 导出（185 paths 零漂移）、Spectral 契约校验、受影响全部单测、`@global/code-intelligence` 测试、G9/G15/G16/G17、`execution-authority-policy`、`pnpm governance:verify`、`pnpm docs:verify` 与 `gitleaks`。
- 未做：本 PR 保持 `SITE_BUILDER_ENABLED` 默认 `true`，尚未在生产环境将其切为 `false`（待 M11 发布窗口评估后独立切换）。
