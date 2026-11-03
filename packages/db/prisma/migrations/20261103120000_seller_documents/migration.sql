-- 模块 02 卖家资料库（Phase 2）：seller_document / seller_document_chunk。
-- 原始文档按空间隔离（RLS FORCE + 策略），bucket 前缀隔离；软删 + DSR 物理删（owner 路径）。
-- 活跃内容唯一性由部分唯一索引持有（WHERE deleted_at IS NULL），重传删除过的同一文件不冲突。
-- chunk 的混合检索：pgvector HNSW（halfvec 余弦）+ 生成列 tsvector 的 GIN。检索走 raw SQL。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "seller_document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_hash" VARCHAR(64),
    "status" TEXT NOT NULL DEFAULT 'pending_upload',
    "processing_stage" TEXT,
    "processing_attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "retry_at" TIMESTAMPTZ(3),
    "processing_error_code" VARCHAR(120),
    "parsed_meta" JSONB,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "facts_extracted_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" UUID,
    "cleanup_event_id" UUID,
    "cleanup_completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "seller_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seller_document_size_bytes_positive" CHECK ("size_bytes" > 0),
    CONSTRAINT "seller_document_kind_check" CHECK ("kind" IN ('pdf', 'docx', 'pptx', 'txt', 'md', 'other')),
    CONSTRAINT "seller_document_status_check" CHECK ("status" IN ('pending_upload', 'committing', 'queued', 'processing', 'ready', 'failed_terminal', 'rejected', 'deleted')),
    CONSTRAINT "seller_document_content_hash_check" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "seller_document_id_workspace_id_key" ON "seller_document" ("id", "workspace_id");
CREATE INDEX "seller_document_workspace_id_company_id_status_created_at_idx" ON "seller_document" ("workspace_id", "company_id", "status", "created_at");
-- 活跃内容去重：同一公司下未删除、已有 hash 的文档唯一。
CREATE UNIQUE INDEX "seller_document_active_content_key" ON "seller_document" ("workspace_id", "company_id", "content_hash") WHERE "deleted_at" IS NULL AND "content_hash" IS NOT NULL;

ALTER TABLE "seller_document"
    ADD CONSTRAINT "seller_document_company_workspace_fkey"
    FOREIGN KEY ("company_id", "workspace_id") REFERENCES "company_profile" ("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "seller_document_chunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "meta" JSONB,
    "embed_model" TEXT,
    "embed_version" TEXT,
    "embedding" vector(1024),
    "text_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE("text", ''))) STORED,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seller_document_chunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_document_chunk_document_id_seq_key" ON "seller_document_chunk" ("document_id", "seq");
CREATE UNIQUE INDEX "seller_document_chunk_id_workspace_id_key" ON "seller_document_chunk" ("id", "workspace_id");
CREATE INDEX "seller_document_chunk_workspace_id_document_id_idx" ON "seller_document_chunk" ("workspace_id", "document_id");
CREATE INDEX "seller_document_chunk_text_tsv_idx" ON "seller_document_chunk" USING gin ("text_tsv");
-- ANN（与 kb_chunk 同口径）：half precision 减半索引体积，查询端同样 cast。
CREATE INDEX "seller_document_chunk_embedding_hnsw_idx" ON "seller_document_chunk" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops);

ALTER TABLE "seller_document_chunk"
    ADD CONSTRAINT "seller_document_chunk_document_workspace_fkey"
    FOREIGN KEY ("document_id", "workspace_id") REFERENCES "seller_document" ("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "seller_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seller_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY "seller_document_tenant_isolation" ON "seller_document"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "seller_document_chunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seller_document_chunk" FORCE ROW LEVEL SECURITY;
CREATE POLICY "seller_document_chunk_tenant_isolation" ON "seller_document_chunk"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- app_user：写入（presign/commit/ingest）与状态更新；物理删除只走 owner（DSR）。
GRANT SELECT, INSERT, UPDATE ON TABLE "seller_document" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "seller_document_chunk" TO app_user;

COMMIT;
