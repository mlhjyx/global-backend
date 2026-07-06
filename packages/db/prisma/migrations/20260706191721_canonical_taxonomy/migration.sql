-- CreateTable
CREATE TABLE "canonical_taxonomy" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parent_code" TEXT,
    "label_en" TEXT NOT NULL,
    "labels" JSONB,
    "crosswalks" JSONB,
    "wikidata_qid" TEXT,
    "osm_tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_taxonomy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_alias" (
    "id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_alias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "canonical_taxonomy_kind_idx" ON "canonical_taxonomy"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_taxonomy_kind_code_key" ON "canonical_taxonomy"("kind", "code");

-- CreateIndex
CREATE INDEX "term_alias_kind_term_idx" ON "term_alias"("kind", "term");

-- CreateIndex
CREATE UNIQUE INDEX "term_alias_kind_term_key" ON "term_alias"("kind", "term");


-- 平台级参考数据（无租户、无 RLS）：app_user 只读，seed 由 owner 连接写入
GRANT SELECT ON "canonical_taxonomy", "term_alias" TO app_user;
