---
date: 2026-11-03
title: Grant seller_document_chunk DELETE to app_user so ingest replay can clear prior chunks
---

- 起因：Phase 2 资料摄入在首次线上验收即失败——活动内的幂等重放先 `deleteMany` 旧分块，而 `20261103120000_seller_documents` 只授了 SELECT/INSERT/UPDATE，触发 `42501 permission denied for table seller_document_chunk`（dev 实测，文档回落 queued）。
- 改动：新迁移 `20261103130000_seller_document_chunk_delete_grant` 仅对 `seller_document_chunk` 追加 `GRANT DELETE ... TO app_user`（RLS 仍按 workspace 隔离）；`seller_document` 本身维持软删（UPDATE），物理删除仍归 owner/DSR。同步 `docs/governance/app-user-table-privileges.json` 与迁移规格断言。
- 测试：迁移规格的授权断言更新；`app-user-table-privileges.postgres.spec.ts` 在 CI 的 PostgreSQL job 按治理清单核对真库授权。
- 未做：不新增周期扫描重新拉起 `retry_at` 回退的文档（当前靠 `POST /seller-documents/:id/retry`），留 Phase 2 后续。
