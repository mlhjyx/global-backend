---
date: 2026-11-24
pr:
title: Batch 1.1-C — 卖家资料解析心跳/取消/扩展名/租约恢复、pgvector 防 NULLS FIRST 与 HNSW 迭代扫描、超长表格切分与删除自愈
---

- 起因：深度审计发现卖家资料上传与解析链路存在多处高危断层：`seller-document.activities.ts` 缺少 5s 周期心跳与 `cancellationSignal` 透传、向 Docling 传递无扩展名裸 UUID、`claim()` 不接管过期 `processing` 租约且把空文档/终态损坏误送 8 次重试；`seller-documents.service.ts` 在 `commit()` 遇非 `P2002` 异常时滞留 `committing`、presign 仅签内网 `S3_ENDPOINT`、`search()` 漏写 `c."embedding" IS NOT NULL` 导致 PostgreSQL `NULLS FIRST` 倒排且绕开 HNSW 索引；`kb.service.ts` 缺 `hnsw.iterative_scan` 与 `embed_model`/`embed_version` 过滤；`chunker.ts` 对超长 Markdown 表格不做上限切分；`deletion.activities.ts`/`deletion.workflow.ts` 在对象存储删除瞬时失败时直接进入 `completeDeletion` 空重试而不重调 `storage.delete()`。
- 改动：
  - `apps/api/src/seller-knowledge/seller-document.activities.ts`：新增 5s 周期心跳与 `ActivityContext.current().cancellationSignal` 透传；新增 `resolveDoclingFilename` 保留或按 MIME 补全扩展名传给 Docling；`claim()` 支持接管过期 `processing` 租约；`DOCUMENT_NO_CONTENT` 与 `disposition === 'terminal'` 错误立即置 `failed_terminal`，取消时释放租约回 `queued` 立即可重试。
  - `apps/api/src/seller-knowledge/seller-documents.storage.ts` & `seller-documents.service.ts`：支持可选 `S3_PUBLIC_ENDPOINT` 独立签发外部可达 presign URL；`commit()` 支持接管过期 `committing` 租约并在非 `P2002` 数据库异常时回滚 `pending_upload` 与清理孤立 canonical 对象；`retry()` 允许接管过期 `processing` 租约；`search()` 改为两阶段 HNSW + GIN 词法混合 CTE，启用 `SET LOCAL hnsw.iterative_scan = relaxed_order`，补齐 `c."embedding" IS NOT NULL`、`embed_model`/`embed_version` 与 `NULLS LAST`。
  - `apps/api/src/site-builder/kb.service.ts` & `chunker.ts`：`KbService.search()` 启用 `SET LOCAL hnsw.iterative_scan = relaxed_order` 并按 `embed_model`/`embed_version` 过滤；`chunker.ts` 新增 `splitLongTable` 对超长 Markdown 表格按行切分并每块重复表头（≤1600 字符），短表格保持原子。
  - `apps/api/src/temporal/deletion.activities.ts` & `deletion.workflow.ts`：抽离 `deleteSellerDocumentBlobWithRetry`（3 次有界重试并把 `eraseSellerDocumentCleanup` 复杂度从 25 降至 23）；`deletionWorkflow` 在 `patched('seller-document-blob-retry-v1')` 保护下对 `blobDeleted === false` 做 3 轮退避重试 `eraseSubject`，耗尽后仍由 `completeDeletion` fail-closed 报错。
- 测试：9 套关联单测（`seller-document.activities`、`seller-documents.service`、`seller-documents.storage`、`seller-document-ingest.workflow`、`kb.service`、`chunker`、`deletion.workflow`、`deletion-artifact-subject`、`deletion-company-contact-points`）、G9/G15/G16/G17、`execution-authority-policy`、`governance-workflow-constants`、`governance-changelog-fragments`、`governance-verify`、`nest build`、`eslint`、`docs:verify` 与 `gitleaks` 全部通过。
- 未做：不改动 OpenAPI 契约与数据库表结构（零迁移）；S2 PDF 辅助抽取与 `document-claim-basis` N+1 优化安排在 Batch 1.2；未部署。
