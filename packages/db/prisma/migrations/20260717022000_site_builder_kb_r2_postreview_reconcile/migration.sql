-- R2-A2 post-review convergence migration.
--
-- The shared development database exercised the original 020000/021000 pair before
-- review moved the full correctness gate into 020000. Never hide that history by only
-- rewriting migration checksums: this migration converges both database shapes:
--   1. old 020000 data reconciliation + old 021000 constraints; and
--   2. fresh databases where the revised 020000 already installed the final shape.

BEGIN;
LOCK TABLE site, asset, kb_document, kb_chunk IN SHARE ROW EXCLUSIVE MODE;

-- A child row whose workspace does not match its Site cannot be safely relabelled across
-- tenants. Never hard-delete canonical Asset truth in a migration: abort and require an
-- explicit quarantine/audit path that can preserve object cleanup provenance.
DO $$
DECLARE
  asset_site_scope_mismatches integer;
  document_site_scope_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO asset_site_scope_mismatches
  FROM asset a
  LEFT JOIN site s ON s.id = a.site_id AND s.workspace_id = a.workspace_id
  WHERE s.id IS NULL;

  SELECT COUNT(*) INTO document_site_scope_mismatches
  FROM kb_document d
  LEFT JOIN site s ON s.id = d.site_id AND s.workspace_id = d.workspace_id
  WHERE s.id IS NULL;

  IF asset_site_scope_mismatches <> 0 OR document_site_scope_mismatches <> 0 THEN
    RAISE EXCEPTION 'R2-A2 Site tenant mismatch requires manual quarantine: assets=%, documents=%',
      asset_site_scope_mismatches, document_site_scope_mismatches;
  END IF;
END $$;

-- Repair the old single-column chunk FK provenance before installing/reinstalling the
-- composite FK. On fresh databases this is an intentional zero-row operation.
UPDATE kb_chunk c
SET workspace_id = d.workspace_id
FROM kb_document d
WHERE c.document_id = d.id
  AND c.workspace_id <> d.workspace_id;

-- Re-run upload provenance reconciliation so the new constraints never merely hide an
-- old bad row. Non-upload sources cannot be relabelled as uploaded material.
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

-- Preserve exactly one genuinely healthy upload document per Asset. Zero-chunk ready
-- rows are not healthy. If no row is healthy, remove all candidates for clean re-ingest.
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
           AND m.actual_chunks > 0
           AND m.actual_chunks = m.chunk_count
           AND m.embedded_chunks = m.actual_chunks) AS healthy,
         ROW_NUMBER() OVER (
           PARTITION BY m.asset_id
           ORDER BY
             (m.status = 'ready'
               AND m.actual_chunks > 0
               AND m.actual_chunks = m.chunk_count
               AND m.embedded_chunks = m.actual_chunks) DESC,
             COALESCE(m.current_embed_version, true) DESC,
             m.updated_at DESC,
             m.created_at DESC,
             m.id ASC
         ) AS rn,
         MAX((m.status = 'ready'
           AND m.actual_chunks > 0
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

-- Reconcile the Asset half of the state machine after choosing the document survivor.
UPDATE asset a
SET processing_status = 'ready',
    lease_token = NULL,
    lease_until = NULL,
    retry_at = NULL,
    processing_error_code = NULL,
    error = NULL,
    updated_at = now()
WHERE a.kind = 'doc'
  AND a.deleted_at IS NULL
  AND a.content_hash IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM kb_document d WHERE d.asset_id = a.id
  );

UPDATE asset a
SET processing_status = 'queued',
    lease_token = NULL,
    lease_until = NULL,
    retry_at = NULL,
    processing_error_code = NULL,
    error = NULL,
    updated_at = now()
WHERE a.kind = 'doc'
  AND a.deleted_at IS NULL
  AND a.content_hash IS NOT NULL
  AND a.processing_status IN (
    'queued', 'ready', 'processing', 'failed', 'failed_retryable'
  )
  AND NOT EXISTS (
    SELECT 1 FROM kb_document d WHERE d.asset_id = a.id
  );

-- Assert convergence before replacing the provenance FKs.
DO $$
DECLARE
  duplicate_groups integer;
  orphan_or_cross_scope integer;
  chunk_mismatches integer;
  chunk_workspace_mismatches integer;
  site_scope_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT asset_id FROM kb_document
    WHERE asset_id IS NOT NULL
    GROUP BY asset_id HAVING COUNT(*) > 1
  ) x;

  SELECT COUNT(*) INTO orphan_or_cross_scope
  FROM kb_document d
  LEFT JOIN asset a ON a.id = d.asset_id
  WHERE (d.source = 'upload') <> (d.asset_id IS NOT NULL)
     OR (d.asset_id IS NOT NULL AND (
       a.id IS NULL OR a.workspace_id <> d.workspace_id OR a.site_id <> d.site_id
     ));

  SELECT COUNT(*) INTO chunk_mismatches
  FROM kb_document d
  WHERE d.asset_id IS NOT NULL
    AND d.status = 'ready'
    AND (
      d.chunk_count <= 0
      OR d.chunk_count <> (SELECT COUNT(*) FROM kb_chunk c WHERE c.document_id = d.id)
      OR EXISTS (
        SELECT 1 FROM kb_chunk c WHERE c.document_id = d.id AND c.embedding IS NULL
      )
    );

  SELECT COUNT(*) INTO chunk_workspace_mismatches
  FROM kb_chunk c
  JOIN kb_document d ON d.id = c.document_id
  WHERE c.workspace_id <> d.workspace_id;

  SELECT COUNT(*) INTO site_scope_mismatches
  FROM (
    SELECT a.id
    FROM asset a
    LEFT JOIN site s ON s.id = a.site_id AND s.workspace_id = a.workspace_id
    WHERE s.id IS NULL
    UNION ALL
    SELECT d.id
    FROM kb_document d
    LEFT JOIN site s ON s.id = d.site_id AND s.workspace_id = d.workspace_id
    WHERE s.id IS NULL
  ) x;

  RAISE NOTICE 'R2-A2 post-review residuals: duplicate_groups=%, orphan_or_cross_scope=%, chunk_mismatches=%, chunk_workspace_mismatches=%, site_scope_mismatches=%',
    duplicate_groups, orphan_or_cross_scope, chunk_mismatches,
    chunk_workspace_mismatches, site_scope_mismatches;

  IF duplicate_groups <> 0 OR orphan_or_cross_scope <> 0 OR chunk_mismatches <> 0
     OR chunk_workspace_mismatches <> 0 OR site_scope_mismatches <> 0 THEN
    RAISE EXCEPTION 'R2-A2 post-review reconciliation did not converge';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS site_id_workspace_id_key
  ON site(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS asset_id_workspace_id_site_id_key
  ON asset(id, workspace_id, site_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_document_asset_id_key
  ON kb_document(asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_document_id_workspace_id_key
  ON kb_document(id, workspace_id);

-- Drop either historical or final names, then install the exact schema.prisma shape.
ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_site_id_fkey;
ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_site_workspace_fkey;
ALTER TABLE asset ADD CONSTRAINT asset_site_workspace_fkey
  FOREIGN KEY (site_id, workspace_id)
  REFERENCES site(id, workspace_id)
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_site_workspace_fkey;

ALTER TABLE kb_document DROP CONSTRAINT IF EXISTS kb_document_site_id_fkey;
ALTER TABLE kb_document DROP CONSTRAINT IF EXISTS kb_document_site_workspace_fkey;
ALTER TABLE kb_document ADD CONSTRAINT kb_document_site_workspace_fkey
  FOREIGN KEY (site_id, workspace_id)
  REFERENCES site(id, workspace_id)
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE kb_document VALIDATE CONSTRAINT kb_document_site_workspace_fkey;

ALTER TABLE kb_document DROP CONSTRAINT IF EXISTS kb_document_asset_scope_fkey;
ALTER TABLE kb_document ADD CONSTRAINT kb_document_asset_scope_fkey
  FOREIGN KEY (asset_id, workspace_id, site_id)
  REFERENCES asset(id, workspace_id, site_id)
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE kb_document VALIDATE CONSTRAINT kb_document_asset_scope_fkey;

ALTER TABLE kb_chunk DROP CONSTRAINT IF EXISTS kb_chunk_document_id_fkey;
ALTER TABLE kb_chunk DROP CONSTRAINT IF EXISTS kb_chunk_document_workspace_fkey;
ALTER TABLE kb_chunk ADD CONSTRAINT kb_chunk_document_workspace_fkey
  FOREIGN KEY (document_id, workspace_id)
  REFERENCES kb_document(id, workspace_id)
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE kb_chunk VALIDATE CONSTRAINT kb_chunk_document_workspace_fkey;

DROP INDEX IF EXISTS asset_kb_queued_due_idx;
CREATE INDEX asset_kb_queued_due_idx
  ON asset(retry_at, created_at, id)
  WHERE kind = 'doc' AND processing_status = 'queued' AND deleted_at IS NULL;

DROP INDEX IF EXISTS asset_kb_processing_expired_idx;
CREATE INDEX asset_kb_processing_expired_idx
  ON asset(lease_until, created_at, id)
  WHERE kind = 'doc' AND processing_status = 'processing' AND deleted_at IS NULL;

COMMIT;
