-- S1a follow-up r2: 有界、可续接的 seller_document 清理批次。
-- 每次调用只处理一个冻结阶段的一批（<= p_limit）目标并返回下一游标；活动在同一事务里
-- 持久化本批真实计数与游标，全部批次完成（phase=done）后才删 blob 并签完成回执。
-- 旧的整快照函数在本迁移中移除：一次性无界路径不再对 app_user 开放。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION erase_seller_document_cleanup_batch_v1(
  p_workspace_id UUID,
  p_deletion_request_id UUID,
  p_phase TEXT,
  p_after UUID,
  p_limit INTEGER
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
  v_deleted INTEGER;
  v_next_phase TEXT;
  v_next_after UUID;
  c_chunks INTEGER := 0;
  c_claims INTEGER := 0;
  c_evidence INTEGER := 0;
  c_refs INTEGER := 0;
  c_sources INTEGER := 0;
BEGIN
  -- Caller boundary: tenant binding, app principal, no active SET ROLE, before
  -- any row is read or deleted.
  IF p_workspace_id IS NULL
     OR current_workspace_id() IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_phase NOT IN ('claims', 'sources', 'chunks', 'done')
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 200
  THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO req FROM "deletion_request"
   WHERE "id" = p_deletion_request_id AND "workspace_id" = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND OR req."subject_type" <> 'seller_document'
     OR req."status" NOT IN ('FROZEN', 'ERASING', 'FAILED') THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
  END IF;
  -- Counts are committed with every batch, so they may only coexist with an
  -- in-progress cursor; a counted request without one is legacy or finished and
  -- must be completed, never erased again.
  IF req."stats" ? 'sellerDocumentCounts' THEN
    IF COALESCE(req."stats" -> 'sellerDocumentCursor' ->> 'phase', 'done') NOT IN ('claims', 'sources', 'chunks') THEN
      RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_REQUEST_INVALID' USING ERRCODE = '42501';
    END IF;
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

  IF p_phase = 'done' THEN
    v_next_phase := 'done';
    v_next_after := NULL;
  ELSIF p_phase = 'claims' THEN
    -- One bounded window of the frozen, id-sorted claim snapshot; the cursor is
    -- the last id of the window so a retry resumes after it even when every id
    -- in it fell out of the document scope.
    SELECT array_agg(id ORDER BY id) INTO v_batch
      FROM (
        SELECT id FROM unnest(v_claims) id
         WHERE p_after IS NULL OR id > p_after
         ORDER BY id
         LIMIT p_limit + 1
      ) batch_window;
    IF COALESCE(array_length(v_batch, 1), 0) > p_limit THEN
      v_batch := v_batch[1:p_limit];
      v_next_phase := 'claims';
      v_next_after := v_batch[p_limit];
    ELSE
      v_next_phase := 'sources';
      v_next_after := NULL;
    END IF;
    -- Only claims whose reference still points at this frozen document are in
    -- scope; a foreign claim id in the snapshot never widens the erasure.
    SELECT COALESCE(array_agg(DISTINCT ref."claim_id"), '{}') INTO v_batch
      FROM "claim_document_evidence" ref
     WHERE ref."workspace_id" = p_workspace_id
       AND ref."claim_id" = ANY(v_batch)
       AND (ref."document_id" = v_doc OR ref."source_document_id" = v_doc);
    IF EXISTS (
      SELECT 1 FROM "brand_profile_claim_bridge"
       WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_batch)
    ) THEN
      RAISE EXCEPTION 'SELLER_DOCUMENT_CLEANUP_BRIDGED_CLAIM' USING ERRCODE = '42501';
    END IF;
    WITH deleted AS (
      DELETE FROM "claim_document_evidence"
       WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_refs := v_deleted;
    WITH deleted AS (
      DELETE FROM "evidence"
       WHERE "workspace_id" = p_workspace_id AND "claim_id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_evidence := v_deleted;
    WITH deleted AS (
      DELETE FROM "claim"
       WHERE "workspace_id" = p_workspace_id AND "company_id" = v_company AND "id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_claims := v_deleted;
  ELSIF p_phase = 'sources' THEN
    SELECT array_agg(id ORDER BY id) INTO v_batch
      FROM (
        SELECT id FROM unnest(v_sources) id
         WHERE p_after IS NULL OR id > p_after
         ORDER BY id
         LIMIT p_limit + 1
      ) batch_window;
    IF COALESCE(array_length(v_batch, 1), 0) > p_limit THEN
      v_batch := v_batch[1:p_limit];
      v_next_phase := 'sources';
      v_next_after := v_batch[p_limit];
    ELSE
      v_next_phase := 'chunks';
      v_next_after := NULL;
    END IF;
    WITH deleted AS (
      DELETE FROM "knowledge_source" source
       WHERE source."workspace_id" = p_workspace_id AND source."id" = ANY(v_batch)
         AND NOT EXISTS (SELECT 1 FROM "claim" c WHERE c."source_id" = source."id")
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_sources := v_deleted;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO v_batch
      FROM (
        SELECT id FROM "seller_document_chunk"
         WHERE "workspace_id" = p_workspace_id AND "document_id" = v_doc
           AND (p_after IS NULL OR id > p_after)
         ORDER BY id
         LIMIT p_limit + 1
      ) batch_window;
    IF COALESCE(array_length(v_batch, 1), 0) > p_limit THEN
      v_batch := v_batch[1:p_limit];
      v_next_phase := 'chunks';
      v_next_after := v_batch[p_limit];
    ELSE
      v_next_phase := 'done';
      v_next_after := NULL;
    END IF;
    WITH deleted AS (
      DELETE FROM "seller_document_chunk"
       WHERE "workspace_id" = p_workspace_id AND "id" = ANY(v_batch)
       RETURNING 1
    ) SELECT count(*) INTO v_deleted FROM deleted;
    c_chunks := v_deleted;
  END IF;

  RETURN jsonb_build_object(
    'phase', p_phase,
    'nextPhase', v_next_phase,
    'nextAfter', CASE WHEN v_next_after IS NULL THEN NULL ELSE v_next_after::text END,
    'done', v_next_phase = 'done',
    'chunksErased', c_chunks,
    'claimsErased', c_claims,
    'evidenceErased', c_evidence,
    'referencesErased', c_refs,
    'knowledgeSourcesErased', c_sources
  );
END;
$$;
REVOKE ALL ON FUNCTION erase_seller_document_cleanup_batch_v1(UUID, UUID, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_seller_document_cleanup_batch_v1(UUID, UUID, TEXT, UUID, INTEGER) TO app_user;

-- The previous single-call erasure looped the whole frozen snapshot in one
-- transaction; remove it so no unbounded path remains executable by app_user.
DROP FUNCTION IF EXISTS erase_seller_document_cleanup_targets_v1(UUID, UUID);

COMMIT;
