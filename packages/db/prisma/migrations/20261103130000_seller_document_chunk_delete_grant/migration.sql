-- 摄入活动在租约内幂等重放时先清掉该文档的旧分块（seller_document_chunk.deleteMany）。
-- 20261103120000_seller_documents 只授了 SELECT/INSERT/UPDATE，线上首次解析即
-- "permission denied for table seller_document_chunk"（2026-11-03 dev 实测）。
-- 只补分块表的 DELETE：seller_document 本身仍只做软删（UPDATE），物理删除留给 owner/DSR。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

GRANT DELETE ON TABLE "seller_document_chunk" TO app_user;

COMMIT;
