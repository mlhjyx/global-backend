-- Identity v2 must also recognize URL-shaped domains on legacy rows. Keep the
-- display value untouched and add an expression index without a historical
-- UPDATE/backfill. CONCURRENTLY avoids blocking existing SaaS traffic.
CREATE INDEX CONCURRENTLY "canonical_company_workspace_normalized_domain_idx"
ON "canonical_company" (
  "workspace_id",
  (NULLIF(
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim("domain"), '^https?://', '', 'i'),
          '^www\.', '', 'i'
        ),
        '[/?#].*$', ''
      )
    ),
    ''
  ))
)
WHERE "domain" IS NOT NULL;
