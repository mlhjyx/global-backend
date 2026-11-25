---
date: 2026-11-25
pr:
title: Fix WsThrottlerGuard tenant isolation and add DSR list and streaming document download endpoints
---

- 起因：MT-P0 多租户止血发现三项引擎缺陷：`WsThrottlerGuard` 在控制器 `AuthGuard` 之前运行且误读 `req.ctx` 导致所有同源代理请求落入同一 IP 限流桶；`GET /api/v1/deletion-requests` 缺失导致隐私页无法拉取真实 DSR 列表；资料下载仅返回内网 MinIO presigned URL 且缺少鉴权流式下载端点。
- 改动：
  - 修复 `apps/api/src/common/ws-throttler.guard.ts`，改读 `req.requestContext?.workspaceId` 并注入可选 `TokenVerifier` 在 Bearer JWT 校验通过且 workspace 获准时按 `ws:<workspaceId>` 限流（不提前写 `req.requestContext`，公共/服务令牌/非法令牌回落 IP）；同步更新并新增单测、Redis 集成测试及 HTTP 端到端集成测试。
  - 新增 `GET /api/v1/deletion-requests`（`apps/api/src/compliance/deletion.controller.ts`、`deletion.service.ts`），走 `withWorkspace` + RLS 与游标分页，过滤 `subjectType IN ('contact', 'company')` 并校验 `cursor` / `status`。
  - 新增 `GET /api/v1/seller-documents/:documentId/content`（`apps/api/src/seller-knowledge/seller-documents.storage.ts`、`seller-documents.service.ts`、`seller-documents.controller.ts`），通过 S3 `GetObjectCommand` + `StreamableFile` 流式代理下载并转义 `Content-Disposition` 文件名。
  - 补充 `apps/api/src/docs/operation-descriptions.ts` 并重新导出 `packages/contracts/openapi/openapi.json`。
- 测试：完成 `@global/db` 生成、`@global/contracts` 与 `@global/api` 构建、OpenAPI 导出与 Spectral 校验、`@global/api` 全量单测、一次性 Redis 限流测试及治理脚本检查。
- 未做：仅完成后端引擎 PR 改动与测试；`gain-saas` BFF/前端对接与跨仓联调在后续 PR 跟进。
