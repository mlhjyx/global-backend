-- Forward-only historical cleanup. This migration contains DML only; all
-- sanitizer/audit helpers were created separately in 1300. The retained-scale
-- lock/timing decision remains HOLD until production-sized rehearsal exists.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

UPDATE "canonical_company" AS company
SET "attributes" = sanitize_canonical_company_attributes_v2(company."attributes"),
    "version" = company."version" + 1,
    "updated_at" = statement_timestamp()
WHERE company."attributes" IS NOT NULL
  AND company."attributes" IS DISTINCT FROM
    sanitize_canonical_company_attributes_v2(company."attributes");

UPDATE "field_evidence" AS evidence
SET "value" = jsonb_strip_nulls(jsonb_build_object(
      '_historicalCleanup', 'canonical-attribute-cleanup/v1',
      'reason', 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD',
      'originalValueHash', encode(digest(
        raw_source_canonical_json_v1(evidence."value"), 'sha256'
      ), 'hex'),
      'retainedValue', CASE
        WHEN evidence."field" = 'attributes'
          THEN sanitize_canonical_company_attributes_v2(evidence."value")
        ELSE NULL
      END
    )),
    "allowed_actions" = '[]'::jsonb,
    "data_class" = 'red'
WHERE evidence."entity_type" = 'company'
  AND NOT EXISTS (
    SELECT 1
    FROM "raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = evidence."workspace_id"
      AND disposition."raw_record_id" = evidence."raw_record_id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  )
  AND (
    (
      evidence."field" = 'attributes'
      AND evidence."value" IS DISTINCT FROM
        sanitize_canonical_company_attributes_v2(evidence."value")
    )
    OR regexp_replace(lower(evidence."field"), '[^a-z0-9]', '', 'g') IN (
      'address','contact','contactemail','contactname','contactpoint','email',
      'firstname','fullname','lastname','mobile','ownername','person','persons',
      'phone','publicemail','publicphone','recipientname','telephone','usagent'
    )
    OR evidence."value"::text ~*
      '([[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|(^|[^[:alnum:]])([+]?[0-9][ ()\.-]*){7,}($|[^[:alnum:]])|(^|[^[:alnum:]])(bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith|alice van smith)($|[^[:alnum:]]))'
  );

COMMIT;
