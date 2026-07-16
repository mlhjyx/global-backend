-- R2-A2 data phase: deterministically reconcile historical KB rows before adding
-- asset uniqueness/provenance constraints. This migration is idempotent in effect:
-- after the first successful run every upload Asset has at most one healthy document.

BEGIN;
LOCK TABLE asset, kb_document, kb_chunk IN SHARE ROW EXCLUSIVE MODE;

-- Invalid upload provenance cannot be safely relabelled as an intake/wizard document.
-- Delete it; the canonical doc Asset is re-queued below when it has no healthy document.
WITH invalid AS (
  SELECT d.id
  FROM kb_document d
  LEFT JOIN asset a ON a.id = d.asset_id
  WHERE (d.source = 'upload' AND d.asset_id IS NULL)
     OR (d.source <> 'upload' AND d.asset_id IS NOT NULL)
     OR (d.asset_id IS NOT NULL AND a.id IS NULL)
     OR (d.asset_id IS NOT NULL AND (a.workspace_id <> d.workspace_id OR a.site_id <> d.site_id))
)
DELETE FROM kb_document d
USING invalid i
WHERE d.id = i.id;

-- A healthy survivor is ready, has an internally consistent chunk_count and has no
-- missing embeddings. Ties prefer the current embedding version, newest update, then
-- UUID ascending for a deterministic final winner. If a duplicate group has no healthy
-- row, delete the whole group and let the Asset be re-ingested.
WITH metrics AS (
  SELECT d.id,
         d.asset_id,
         d.status,
         d.chunk_count,
         d.updated_at,
         d.created_at,
         COUNT(c.id)::integer AS actual_chunks,
         COUNT(c.embedding)::integer AS embedded_chunks,
         BOOL_AND(c.embed_version = 'bge-m3:2026-07') FILTER (WHERE c.id IS NOT NULL) AS current_embed_version
  FROM kb_document d
  LEFT JOIN kb_chunk c ON c.document_id = d.id
  WHERE d.asset_id IS NOT NULL
  GROUP BY d.id
), ranked AS (
  SELECT m.*,
         (m.status = 'ready'
           AND m.actual_chunks = m.chunk_count
           AND m.embedded_chunks = m.actual_chunks) AS healthy,
         ROW_NUMBER() OVER (
           PARTITION BY m.asset_id
           ORDER BY
             (m.status = 'ready'
               AND m.actual_chunks = m.chunk_count
               AND m.embedded_chunks = m.actual_chunks) DESC,
             COALESCE(m.current_embed_version, true) DESC,
             m.updated_at DESC,
             m.created_at DESC,
             m.id ASC
         ) AS rn,
         MAX((m.status = 'ready'
           AND m.actual_chunks = m.chunk_count
           AND m.embedded_chunks = m.actual_chunks)::integer)
           OVER (PARTITION BY m.asset_id) AS has_healthy
  FROM metrics m
), doomed AS (
  SELECT id
  FROM ranked
  WHERE has_healthy = 0 OR rn > 1
)
DELETE FROM kb_document d
USING doomed x
WHERE d.id = x.id;

-- Any live canonical document Asset without a surviving KB document must be recoverable.
-- Clear a stale lease/error and place it back on the due queue. The A1 status constraint
-- already permits queued; processing_error_code is introduced in the following migration.
UPDATE asset a
SET processing_status = 'queued',
    lease_token = NULL,
    lease_until = NULL,
    retry_at = NULL,
    error = NULL,
    updated_at = now()
WHERE a.kind = 'doc'
  AND a.deleted_at IS NULL
  AND a.content_hash IS NOT NULL
  AND a.processing_status IN ('ready', 'processing', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM kb_document d WHERE d.asset_id = a.id
  );

-- Fail closed before the constraint phase. A failed assertion aborts this migration and
-- reports the exact remaining class instead of letting CREATE UNIQUE/FK fail opaquely.
DO $$
DECLARE
  duplicate_groups integer;
  orphan_or_cross_scope integer;
  chunk_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_groups
  FROM (SELECT asset_id FROM kb_document WHERE asset_id IS NOT NULL GROUP BY asset_id HAVING COUNT(*) > 1) x;

  SELECT COUNT(*) INTO orphan_or_cross_scope
  FROM kb_document d
  LEFT JOIN asset a ON a.id = d.asset_id
  WHERE (d.source = 'upload') <> (d.asset_id IS NOT NULL)
     OR (d.asset_id IS NOT NULL AND (a.id IS NULL OR a.workspace_id <> d.workspace_id OR a.site_id <> d.site_id));

  SELECT COUNT(*) INTO chunk_mismatches
  FROM kb_document d
  WHERE d.asset_id IS NOT NULL
    AND d.status = 'ready'
    AND d.chunk_count <> (SELECT COUNT(*) FROM kb_chunk c WHERE c.document_id = d.id);

  RAISE NOTICE 'R2-A2 KB reconciliation residuals: duplicate_groups=%, orphan_or_cross_scope=%, chunk_mismatches=%',
    duplicate_groups, orphan_or_cross_scope, chunk_mismatches;
  IF duplicate_groups <> 0 OR orphan_or_cross_scope <> 0 OR chunk_mismatches <> 0 THEN
    RAISE EXCEPTION 'R2-A2 KB reconciliation did not converge';
  END IF;
END $$;

COMMIT;
