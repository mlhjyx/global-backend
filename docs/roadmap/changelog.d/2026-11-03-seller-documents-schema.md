---
date: 2026-11-03
title: Add the seller document library schema with RLS, hybrid-search indexes and least-privilege grants
---

- 起因：模块 02 卖家资料库（Phase 2）此前只有设计与 site-builder KB 的复用面；原始资料需要空间隔离的表、活跃内容去重、检索索引与 RLS 授权。
- 改动：
  - 新迁移 `20261103120000_seller_documents`：`seller_document`（状态机/租约/软删/内容 hash）与 `seller_document_chunk`（BGE-M3 `vector(1024)`、生成列 `text_tsv` + GIN、halfvec HNSW、复合 FK 防跨空间挂接）；活跃内容部分唯一索引（`WHERE deleted_at IS NULL`）；两表 FORCE RLS，`app_user` 仅 SELECT/INSERT/UPDATE（物理删除只走 owner 的 DSR 路径）。
  - Prisma 模型 `SellerDocument`/`SellerDocumentChunk` 与 `CompanyProfile.sellerDocuments` 关系；chunk 的向量列用 `Unsupported`，检索将走 raw SQL。
  - `docs/governance/app-user-table-privileges.json` 登记两表；新增静态迁移契约测试。
- 测试：`apps/api/src/seller-knowledge/seller-document.migration.spec.ts`（迁移顺序/事务边界/列集/部分唯一索引/生成列与索引/RLS 与授权/Prisma 同步）；真库 `app_user` 授权由 CI PostgreSQL job 的 app-user 规格覆盖。
- 未做：本 PR 不含 API/pipeline/bucket（后续 PR）；`CompanyProfile.understandingSources/deletedAt` 与 `KnowledgeSource.sellerDocumentId` 等扩展列入后续。
