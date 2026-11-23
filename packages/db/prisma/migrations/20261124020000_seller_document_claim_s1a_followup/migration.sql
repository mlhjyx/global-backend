-- S1a 追补：内部 seller_document 清理函数的租户绑定、失败恢复与有界分批。
-- 原迁移 20261123110000 保持不变；本迁移 CREATE OR REPLACE 同一函数。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION erase_seller_document_cleanup_targets_v1(
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
  v_claims UUID[];
  v_sources UUID[];
  v_batch UUID[];
  v_total INTEGER;
  v_offset INTEGER;
  v_deleted INTEGER;
  c_chunks INTEGER := 0;
  c_claims INTEGER := 0;
  c_evidence INTEGER := 0;
  c_refs INTEGER := 0;
  c_sources INTEGER := 0;
BEGIN
  -- The definer runs with the owner's BYPASSRLS-capable identity; bind the
  -- caller's tenant before touching any row so a different workspace cannot
  -- be passed in while holding EXECUTE.
  IF p_workspace_id IS NULL
     OR current_workspace_id() IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO req FROM "deletion_request"
   WHERE "id" = p_deletion_request_id AND "workspace_id" = p_workspace_id
   FOR UPDATE;
  -- FAILED is a recoverable state only while the request still proves its full
  -- frozen scope below; the activity never erases from states it cannot re-prove.
  IF NOT FOUND OR req."subject_type" <> 'seller_document'
     OR req."status" NOT IN ('FROZEN', 'ERASING', 'FAILED') THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  -- Erasure counts are written only after this function returned; a request that
  -- already carries them must be completed/retried through the activity, never
  -- erased again (a second run would report a misleading zero scope).
  IF req."stats" ? 'sellerDocumentCounts' THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  v_doc := req."subject_id";
  v_company := (req."stats" ->> 'companyId')::uuid;
  v_policy := req."stats" ->> 'policyVersion';
  IF v_company IS NULL OR v_policy IS NULL OR v_policy <> 'seller-document-cleanup/v1' THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_claims
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'claimIds', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO v_sources
    FROM jsonb_array_elements_text(COALESCE(req."stats" -> 'knowledgeSourceIds', '[]'::jsonb)) value;

  -- Fixed order: company -> document -> claims/evidence/refs.
  PERFORM 1 FROM "company_profile"
   WHERE "id" = v_company AND "workspace_id" = p_workspace_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_COMPANY_MISSING' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "seller_document"
   WHERE "id" = v_doc AND "workspace_id" = p_workspace_id AND "company_id" = v_company
     AND "deleted_at" IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_DOCUMENT_MISSING' USING ERRCODE = '42501';
  END IF;
  -- Only claims whose reference still points at this frozen document are in scope;
  -- a claim already erased with its reference is gone, and a foreign claim id in the
  -- snapshot must never widen the erasure beyond the request's document.
  SELECT COALESCE(array_agg(DISTINCT ref."claim_id"), '{}') INTO v_claims
    FROM "claim_document_evidence" ref
   WHERE ref."workspace_id" = p_workspace_id
     AND ref."claim_id" = ANY(v_claims)
     AND (ref."document_id" = v_doc OR ref."source_document_id" = v_doc);
  IF EXISTS (
    SELECT 1 FROM "brand_profile_claim_bridge"
     WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_claims)
  ) THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_BRIDGED_CLAIM' USING ERRCODE = '42501';
  END IF;

  -- Bounded batches keep the statement size independent of how many document
  -- claims a legacy request froze, so every snapshot can converge.
  v_total := COALESCE(array_length(v_claims, 1), 0);
  v_offset := 1;
  WHILE v_offset <= v_total LOOP
    v_batch := v_claims[v_offset : v_offset + 99];
    WITH deleted AS (
      DELETE FROM "claim_document_evidence"
       WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_refs := c_refs + v_deleted;
    WITH deleted AS (
      DELETE FROM "evidence"
       WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_evidence := c_evidence + v_deleted;
    WITH deleted AS (
      DELETE FROM "claim"
       WHERE "workspace_id" = p_workspace_id AND "company_id" = v_company AND "id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_claims := c_claims + v_deleted;
    v_offset := v_offset + 100;
  END LOOP;

  v_total := COALESCE(array_length(v_sources, 1), 0);
  v_offset := 1;
  WHILE v_offset <= v_total LOOP
    v_batch := v_sources[v_offset : v_offset + 99];
    WITH deleted AS (
      DELETE FROM "knowledge_source" source
       WHERE source."workspace_id" = p_workspace_id AND source."id" = ANY(v_batch)
         AND NOT EXISTS (SELECT 1 FROM "claim" c WHERE c."source_id" = source."id")
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_sources := c_sources + v_deleted;
    v_offset := v_offset + 100;
  END LOOP;

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

COMMIT;
