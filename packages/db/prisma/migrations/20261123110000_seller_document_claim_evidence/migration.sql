-- 卖方文档 typed 审批接缝 S1a：发布解析修订 + claim_document_evidence 引用表 + 内部清理回执明细。
-- 原句仍只在既有 Evidence；原文件/chunks 仍只在 SellerDocument/seller_document_chunk；本迁移不复制全文。
-- claim_document_evidence 只经受控草稿事务写入；app_user 仅 SELECT/INSERT；document live FK 只 SET NULL document_id。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- 发布的非递减解析修订。旧 ready 且已有完整现行 chunks/hash 的文档在迁移中建立首个修订；
-- 未知/失败/无 chunk 的文档保持 NULL，不伪造 ready。
ALTER TABLE "seller_document" ADD COLUMN "parse_revision" INTEGER;
ALTER TABLE "seller_document"
  ADD CONSTRAINT "seller_document_parse_revision_check"
  CHECK ("parse_revision" IS NULL OR "parse_revision" >= 1);

UPDATE "seller_document" d
   SET "parse_revision" = 1
 WHERE d."status" = 'ready'
   AND d."content_hash" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "seller_document_chunk" c
      WHERE c."workspace_id" = d."workspace_id" AND c."document_id" = d."id"
   );

CREATE TABLE "claim_document_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "claim_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "document_id" UUID,
  "source_document_id" UUID NOT NULL,
  "document_content_sha256" CHAR(64) NOT NULL,
  "parse_revision" INTEGER NOT NULL,
  "chunk_seq" INTEGER NOT NULL,
  "chunk_text_sha256" CHAR(64) NOT NULL,
  "quote_start_byte" INTEGER NOT NULL,
  "quote_end_byte" INTEGER NOT NULL,
  "reference_version" INTEGER NOT NULL DEFAULT 1,
  "claim_statement_digest" CHAR(64) NOT NULL,
  "claim_type" VARCHAR(64) NOT NULL,
  "binding_sha256" CHAR(64) NOT NULL,
  "requester_id" UUID NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_document_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "claim_document_evidence_reference_version_check" CHECK ("reference_version" = 1),
  CONSTRAINT "claim_document_evidence_parse_revision_check" CHECK ("parse_revision" >= 1),
  CONSTRAINT "claim_document_evidence_chunk_seq_check" CHECK ("chunk_seq" >= 0),
  CONSTRAINT "claim_document_evidence_quote_check"
    CHECK ("quote_start_byte" >= 0 AND "quote_start_byte" < "quote_end_byte"),
  CONSTRAINT "claim_document_evidence_digest_check"
    CHECK ("document_content_sha256" ~ '^[0-9a-f]{64}$'
      AND "chunk_text_sha256" ~ '^[0-9a-f]{64}$'
      AND "claim_statement_digest" ~ '^[0-9a-f]{64}$'
      AND "binding_sha256" ~ '^[0-9a-f]{64}$'
      AND "request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "claim_document_evidence_claim_type_check"
    CHECK ("claim_type" ~ '^[A-Za-z0-9._:-]{1,64}$')
);

CREATE UNIQUE INDEX "claim_document_evidence_claim_key"
  ON "claim_document_evidence" ("claim_id");
CREATE UNIQUE INDEX "claim_document_evidence_evidence_key"
  ON "claim_document_evidence" ("evidence_id");
CREATE UNIQUE INDEX "claim_document_evidence_id_workspace_id_key"
  ON "claim_document_evidence" ("id", "workspace_id");
CREATE UNIQUE INDEX "claim_document_evidence_claim_scope_key"
  ON "claim_document_evidence" ("claim_id", "workspace_id", "company_id");
CREATE UNIQUE INDEX "claim_document_evidence_evidence_scope_key"
  ON "claim_document_evidence" ("evidence_id", "workspace_id", "claim_id");
CREATE INDEX "claim_document_evidence_document_idx"
  ON "claim_document_evidence" ("workspace_id", "company_id", "document_id");

ALTER TABLE "claim_document_evidence"
  ADD CONSTRAINT "claim_document_evidence_company_id_workspace_id_fkey"
  FOREIGN KEY ("company_id", "workspace_id") REFERENCES "company_profile" ("id", "workspace_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "claim_document_evidence"
  ADD CONSTRAINT "claim_document_evidence_claim_id_workspace_id_company_id_fkey"
  FOREIGN KEY ("claim_id", "workspace_id", "company_id") REFERENCES "claim" ("id", "workspace_id", "company_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "claim_document_evidence"
  ADD CONSTRAINT "claim_document_evidence_evidence_id_workspace_id_claim_id_fkey"
  FOREIGN KEY ("evidence_id", "workspace_id", "claim_id") REFERENCES "evidence" ("id", "workspace_id", "claim_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- live pointer：document 物理删除只清 document_id，workspace/company/source_document_id 身份保留。
ALTER TABLE "claim_document_evidence"
  ADD CONSTRAINT "claim_document_evidence_document_fkey"
  FOREIGN KEY ("document_id", "workspace_id") REFERENCES "seller_document" ("id", "workspace_id")
  ON DELETE SET NULL ("document_id") ON UPDATE CASCADE;

-- 引用除 document_id 的非空→NULL 外不可变；不阻合法 FK live-pointer 置空。
CREATE FUNCTION "claim_document_evidence_immutable_v1"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."document_id" IS DISTINCT FROM OLD."document_id"
     AND NOT (OLD."document_id" IS NOT NULL AND NEW."document_id" IS NULL) THEN
    RAISE EXCEPTION 'CLAIM_DOCUMENT_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'document_id') IS DISTINCT FROM (to_jsonb(OLD) - 'document_id') THEN
    RAISE EXCEPTION 'CLAIM_DOCUMENT_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "claim_document_evidence_immutable_v1"() FROM PUBLIC, app_user;
CREATE TRIGGER "claim_document_evidence_immutable"
  BEFORE UPDATE ON "claim_document_evidence"
  FOR EACH ROW EXECUTE FUNCTION "claim_document_evidence_immutable_v1"();

ALTER TABLE "claim_document_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim_document_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "claim_document_evidence_tenant_isolation" ON "claim_document_evidence"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "claim_document_evidence" FROM PUBLIC, app_user;
GRANT SELECT, INSERT ON TABLE "claim_document_evidence" TO app_user;

-- 文档分支：origin-only + v4 proof 的 Claim 只允许在存在同租户文档引用时审批。
-- Site/manual 分支的 bridge 要求、审计不可变与 v3 proof 全部保留。
CREATE OR REPLACE FUNCTION reject_bridged_claim_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_changed BOOLEAN;
  approval_transition BOOLEAN;
  document_claim BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'APPROVED' THEN
      RAISE EXCEPTION 'new Claim approval must transition from NEEDS_REVIEW';
    END IF;
    RETURN NEW;
  END IF;

  audit_changed := ROW(
    NEW."verified_by", NEW."verified_at", NEW."verification_method",
    NEW."verification_proof"
  ) IS DISTINCT FROM ROW(
    OLD."verified_by", OLD."verified_at", OLD."verification_method",
    OLD."verification_proof"
  );
  approval_transition :=
    OLD."status" = 'NEEDS_REVIEW' AND NEW."status" = 'APPROVED';

  IF EXISTS (
      SELECT 1 FROM "brand_profile_claim_bridge"
      WHERE "claim_id" = OLD."id"
    ) OR OLD."status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
  THEN
    IF ROW(
      NEW."workspace_id", NEW."company_id", NEW."source_id", NEW."origin_key",
      NEW."fact_key", NEW."type", NEW."statement", NEW."confidence", NEW."valid_until"
    ) IS DISTINCT FROM ROW(
      OLD."workspace_id", OLD."company_id", OLD."source_id", OLD."origin_key",
      OLD."fact_key", OLD."type", OLD."statement", OLD."confidence", OLD."valid_until"
    ) THEN
      RAISE EXCEPTION 'bridged or terminal Claim identity is immutable';
    END IF;
  END IF;

  IF NEW."status" = 'APPROVED'
    AND OLD."status" IS DISTINCT FROM 'APPROVED'
  THEN
    SELECT EXISTS (
      SELECT 1 FROM "claim_document_evidence" evidence
      WHERE evidence."claim_id" = NEW."id"
        AND evidence."workspace_id" = NEW."workspace_id"
        AND evidence."company_id" = NEW."company_id"
    ) INTO document_claim;

    IF NEW."origin_key" IS NULL AND NEW."fact_key" IS NULL THEN
      IF document_claim THEN
        RAISE EXCEPTION 'document Claim approval requires its origin key';
      END IF;
    ELSIF NEW."origin_key" IS NOT NULL AND NEW."fact_key" IS NOT NULL THEN
      PERFORM 1
      FROM "brand_profile_claim_bridge" bridge
      JOIN "brand_profile_evidence_ref" ref
        ON ref."id" = bridge."evidence_ref_id"
       AND ref."workspace_id" = bridge."workspace_id"
       AND ref."site_id" = bridge."site_id"
       AND ref."brand_profile_id" = bridge."brand_profile_id"
      WHERE bridge."claim_id" = NEW."id"
        AND bridge."workspace_id" = NEW."workspace_id"
        AND bridge."company_profile_id" = NEW."company_id"
        AND ref."fact_key" = NEW."fact_key"
      LIMIT 1
      FOR SHARE OF bridge;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'origin-keyed Claim approval requires a surviving exact bridge';
      END IF;
    ELSE
      IF NOT document_claim THEN
        RAISE EXCEPTION 'origin-keyed Claim approval requires a surviving exact bridge';
      END IF;
    END IF;

    IF NOT COALESCE((
      approval_transition
      AND NEW."version" = OLD."version" + 1
      AND OLD."verified_by" IS NULL
      AND OLD."verified_at" IS NULL
      AND OLD."verification_method" IS NULL
      AND OLD."verification_proof" IS NULL
      AND NEW."verified_by" IS NOT NULL
      AND nullif(btrim(NEW."verified_by"), '') IS NOT NULL
      AND NEW."verified_at" IS NOT NULL
      AND NEW."verification_method" IS NOT NULL
      AND NEW."verification_method" = 'human_review'
      AND NEW."verification_proof" IS NOT NULL
      AND jsonb_typeof(NEW."verification_proof") = 'object'
      AND jsonb_typeof(NEW."verification_proof" -> 'action') = 'string'
      AND NEW."verification_proof" ->> 'action' = 'claim_approval'
      AND jsonb_typeof(NEW."verification_proof" -> 'proofVersion') = 'number'
      AND jsonb_typeof(NEW."verification_proof" -> 'approvedVersion') = 'number'
      AND NEW."verification_proof" -> 'approvedVersion' = to_jsonb(NEW."version")
    ), FALSE) THEN
      RAISE EXCEPTION 'Claim approval requires a complete human verification proof';
    END IF;

    IF document_claim THEN
      IF NOT COALESCE((
        NEW."verification_proof" -> 'proofVersion' = '4'::jsonb
        AND jsonb_typeof(NEW."verification_proof" -> 'documentReferenceId') = 'string'
        AND NEW."verification_proof" ->> 'documentReferenceId' = (
          SELECT evidence."id"::text FROM "claim_document_evidence" evidence
          WHERE evidence."claim_id" = NEW."id" AND evidence."workspace_id" = NEW."workspace_id"
        )
        AND jsonb_typeof(NEW."verification_proof" -> 'bindingHash') = 'string'
        AND NEW."verification_proof" ->> 'bindingHash' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(NEW."verification_proof" -> 'claimDigest') = 'string'
        AND NEW."verification_proof" ->> 'claimDigest' ~ '^[0-9a-f]{64}$'
      ), FALSE) THEN
        RAISE EXCEPTION 'Document Claim approval requires a complete v4 proof';
      END IF;
    ELSE
      IF NOT COALESCE((
        NEW."verification_proof" -> 'proofVersion' = '3'::jsonb
        AND jsonb_typeof(NEW."verification_proof" -> 'claimDigest') = 'string'
        AND NEW."verification_proof" ->> 'claimDigest' ~ '^[0-9a-f]{64}$'
      ), FALSE) THEN
        RAISE EXCEPTION 'Claim approval requires a complete v3 human verification proof';
      END IF;
    END IF;
  END IF;

  IF audit_changed AND NOT approval_transition THEN
    RAISE EXCEPTION 'Claim approval audit is immutable after initial approval';
  END IF;

  RETURN NEW;
END
$$;

-- 文档 typed Claim 只带 doc originKey，不伪造 Site factKey；配对约束放宽为允许 origin-only。
-- Site 分支仍要求 factKey 且有精确 bridge；origin-only 且无文档引用的 Claim 在审批时仍被
-- CLAIM_BRIDGE_REQUIRED 拒绝，不放宽任何既有证据路径。
ALTER TABLE "claim" DROP CONSTRAINT "claim_origin_fact_key_pair_check";
ALTER TABLE "claim"
  ADD CONSTRAINT "claim_origin_fact_key_pair_check"
  CHECK ((
    ("origin_key" IS NULL AND "fact_key" IS NULL)
    OR ("origin_key" IS NOT NULL AND "fact_key" IS NOT NULL)
    OR ("origin_key" IS NOT NULL AND "fact_key" IS NULL)
  ) IS TRUE);

-- 内部文档清理的受限 DEFINER：只接受已 FROZEN/ERASING 的 seller_document 请求，
-- 在请求 workspace/company/document/冻结目标范围内擦除 refs/evidence/claims/chunks；
-- 文档行保留为带 cleanup 完成事实的 tombstone。app_user 无一般 DELETE，只能经此函数。
CREATE FUNCTION erase_seller_document_cleanup_targets_v1(
  p_workspace_id UUID,
  p_deletion_request_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  req RECORD;
  v_company UUID;
  v_doc UUID;
  v_policy TEXT;
  v_chunks UUID[];
  v_claims UUID[];
  v_evidence UUID[];
  v_refs UUID[];
  v_sources UUID[];
  c_chunks INTEGER := 0;
  c_claims INTEGER := 0;
  c_evidence INTEGER := 0;
  c_refs INTEGER := 0;
  c_sources INTEGER := 0;
BEGIN
  SELECT * INTO req FROM "deletion_request"
   WHERE "id" = p_deletion_request_id AND "workspace_id" = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND OR req."subject_type" <> 'seller_document' OR req."status" NOT IN ('FROZEN', 'ERASING') THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  v_doc := req."subject_id";
  v_company := (req."stats" ->> 'companyId')::uuid;
  v_policy := req."stats" ->> 'policyVersion';
  IF v_company IS NULL OR v_policy IS NULL OR v_policy <> 'seller-document-cleanup/v1' THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_chunks
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'chunkIds', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_claims
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'claimIds', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_evidence
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'evidenceIds', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_refs
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'referenceIds', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_sources
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'knowledgeSourceIds', '[]'::jsonb)) value;
  IF array_length(v_chunks, 1) > 512 OR array_length(v_claims, 1) > 512 THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;

  -- Fixed order: company -> document -> claims/evidence/refs.
  PERFORM 1 FROM "company_profile"
   WHERE "id" = v_company AND "workspace_id" = p_workspace_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_COMPANY_MISSING' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "seller_document"
   WHERE "id" = v_doc AND "workspace_id" = p_workspace_id AND "company_id" = v_company
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_DOCUMENT_MISSING' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "brand_profile_claim_bridge"
     WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_claims)
  ) THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_BRIDGED_CLAIM' USING ERRCODE = '42501';
  END IF;

  WITH deleted AS (
    DELETE FROM "claim_document_evidence"
     WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_claims)
     RETURNING 1
  ) SELECT count(*) INTO c_refs FROM deleted;
  WITH deleted AS (
    DELETE FROM "evidence"
     WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_claims)
     RETURNING 1
  ) SELECT count(*) INTO c_evidence FROM deleted;
  WITH deleted AS (
    DELETE FROM "claim"
     WHERE "workspace_id" = p_workspace_id AND "company_id" = v_company AND "id" = ANY(v_claims)
     RETURNING 1
  ) SELECT count(*) INTO c_claims FROM deleted;
  WITH deleted AS (
    DELETE FROM "knowledge_source" source
     WHERE source."workspace_id" = p_workspace_id AND source."id" = ANY(v_sources)
       AND NOT EXISTS (SELECT 1 FROM "claim" c WHERE c."source_id" = source."id")
     RETURNING 1
  ) SELECT count(*) INTO c_sources FROM deleted;
  WITH deleted AS (
    DELETE FROM "seller_document_chunk"
     WHERE "workspace_id" = p_workspace_id AND "document_id" = v_doc
     RETURNING 1
  ) SELECT count(*) INTO c_chunks FROM deleted;

  RETURN jsonb_build_object(
    'chunksErased', c_chunks,
    'claimsErased', c_claims,
    'evidenceErased', c_evidence,
    'referencesErased', c_refs,
    'knowledgeSourcesErased', c_sources
  );
END;
$$;
REVOKE ALL ON FUNCTION erase_seller_document_cleanup_targets_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_seller_document_cleanup_targets_v1(UUID, UUID) TO app_user;

-- 内部 seller_document 清理回执明细（nullable；旧 contact/company 回执语义不变）。
ALTER TABLE "deletion_receipt" ADD COLUMN "seller_document_detail" JSONB;
ALTER TABLE "deletion_receipt"
  ADD CONSTRAINT "deletion_receipt_seller_document_detail_check"
  CHECK ("seller_document_detail" IS NULL
    OR ("subject_type" = 'seller_document' AND jsonb_typeof("seller_document_detail") = 'object'));

COMMIT;
