-- Site builder foundation (docs/site-builder/02 §2): 6 tables, all workspace_id + RLS.
-- kb_chunk.embedding = pgvector vector(1024) (BGE-M3, D14); first vector column in this DB.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "site" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'builder',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "style_preset" TEXT,
    "locales" JSONB NOT NULL DEFAULT '["en"]',
    "active_version_id" UUID,
    "intake" JSONB NOT NULL,
    "profile" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_version" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'build',
    "spec" JSONB NOT NULL,
    "spec_version" TEXT NOT NULL,
    "artifact_key" TEXT,
    "build_status" TEXT NOT NULL DEFAULT 'pending',
    "build_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_build_run" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'demo_v0',
    "scope" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "steps" JSONB,
    "cost_summary" JSONB,
    "temporal_run_id" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_build_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_hash" TEXT,
    "derived_keys" JSONB,
    "processing_status" TEXT NOT NULL DEFAULT 'pending_upload',
    "meta" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_document" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "asset_id" UUID,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lang" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "parsed_meta" JSONB,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunk" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "meta" JSONB,
    "embed_model" TEXT NOT NULL,
    "embed_version" TEXT NOT NULL,
    "embedding" vector(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_workspace_id_idx" ON "site"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_slug_key" ON "site"("slug");

-- CreateIndex
CREATE INDEX "site_version_workspace_id_idx" ON "site_version"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_version_site_id_version_key" ON "site_version"("site_id", "version");

-- CreateIndex
CREATE INDEX "site_build_run_workspace_id_site_id_idx" ON "site_build_run"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "asset_workspace_id_site_id_kind_idx" ON "asset"("workspace_id", "site_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "asset_object_key_key" ON "asset"("object_key");

-- CreateIndex
CREATE INDEX "kb_document_workspace_id_site_id_idx" ON "kb_document"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "kb_chunk_workspace_id_idx" ON "kb_chunk"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_chunk_document_id_seq_key" ON "kb_chunk"("document_id", "seq");

-- AddForeignKey
ALTER TABLE "site_version" ADD CONSTRAINT "site_version_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_build_run" ADD CONSTRAINT "site_build_run_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunk" ADD CONSTRAINT "kb_chunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── RLS: tenant isolation on all six tables (same pattern as data_hub tables) ──
ALTER TABLE "site" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_tenant_isolation" ON "site"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "site_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_version_tenant_isolation" ON "site_version"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "site_build_run" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_build_run_tenant_isolation" ON "site_build_run"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "asset" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "asset_tenant_isolation" ON "asset"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "kb_document" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kb_document_tenant_isolation" ON "kb_document"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "kb_chunk" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kb_chunk_tenant_isolation" ON "kb_chunk"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- ── ANN index (D14): HNSW over halfvec cosine — half precision halves the index
-- size at equal recall for BGE-M3-scale vectors. Queries must cast the same way:
--   ORDER BY embedding::halfvec(1024) <=> $1::halfvec(1024)
CREATE INDEX "kb_chunk_embedding_hnsw_idx" ON "kb_chunk"
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops);
