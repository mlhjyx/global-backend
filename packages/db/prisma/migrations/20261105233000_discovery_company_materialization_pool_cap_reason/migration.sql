-- 2026-11-05 run pool cap（docs/superpowers/plans/2026-11-05-run-pool-cap.md）：
-- 给 NOT_CANONICALIZABLE 的原因码加上 RUN_POOL_CAP_REACHED——governed 物化批在 run 的公司池
-- 达到 DISCOVERY_RUN_POOL_CAP 后用它跳过新公司的物化。纯放宽：已存行全部仍满足约束。
ALTER TABLE public.discovery_company_materialization_outcome
  DROP CONSTRAINT discovery_company_materialization_outcome_shape_check;

ALTER TABLE public.discovery_company_materialization_outcome
  ADD CONSTRAINT discovery_company_materialization_outcome_shape_check CHECK(
    query_ordinal BETWEEN 0 AND 1023 AND record_index BETWEEN 0 AND 999999
    AND batch_ordinal BETWEEN 0 AND 4095
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
    AND q_ingest_status IN ('ACCEPTED','QUARANTINED','REJECTED')
    AND (q_ingest_status='QUARANTINED' AND outcome='RAW_QUARANTINED'
      OR q_ingest_status='REJECTED' AND outcome='RAW_REJECTED'
      OR q_ingest_status='ACCEPTED' AND outcome NOT IN ('RAW_QUARANTINED','RAW_REJECTED'))
    AND (
      outcome='CANONICALIZED'
      AND canonical_company_id IS NOT NULL AND identity_link_id IS NOT NULL
      AND identity_canonical_type='company' AND canonical_governed_subject_id IS NOT NULL
      AND canonical_governed_subject_type='canonical_company'
      AND c_relation_id IS NOT NULL
      AND c_relation_key='discovery.canonical_company:'||record_index::text
      AND match_rule IN ('domain_exact','identifier_exact','name_country')
      AND confidence IS NOT NULL AND confidence>=0 AND confidence<=1
      AND confidence <> 'NaN'::DOUBLE PRECISION
      AND confidence <> 'Infinity'::DOUBLE PRECISION
      AND confidence <> '-Infinity'::DOUBLE PRECISION
      AND mutation_class IN ('CREATED','UPDATED','LINKED','REUSED')
      AND evidence_count BETWEEN 0 AND 1000000
      AND evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'
      AND restricted_disposition_id IS NULL AND suppression_match_sha256 IS NULL
      AND suppression_match_count IS NULL AND raw_expired_at IS NULL
      AND not_canonicalizable_reason_code IS NULL
      OR outcome IN ('RAW_QUARANTINED','RAW_REJECTED','RESTRICTED_PROCESSING',
        'SUPPRESSED','NOT_CANONICALIZABLE','EXPIRED_BEFORE_CANONICALIZATION')
      AND canonical_company_id IS NULL AND identity_link_id IS NULL
      AND identity_canonical_type IS NULL AND canonical_governed_subject_id IS NULL
      AND canonical_governed_subject_type IS NULL
      AND c_relation_id IS NULL AND c_relation_key IS NULL AND match_rule IS NULL
      AND confidence IS NULL AND mutation_class IS NULL AND evidence_count IS NULL
      AND evidence_manifest_sha256 IS NULL
      AND (outcome='RESTRICTED_PROCESSING' AND restricted_disposition_id IS NOT NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NULL AND not_canonicalizable_reason_code IS NULL
        OR outcome='SUPPRESSED' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 ~ '^[0-9a-f]{64}$'
        AND suppression_match_count BETWEEN 1 AND 64 AND raw_expired_at IS NULL
        AND not_canonicalizable_reason_code IS NULL
        OR outcome='EXPIRED_BEFORE_CANONICALIZATION' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NOT NULL AND not_canonicalizable_reason_code IS NULL
        OR outcome='NOT_CANONICALIZABLE' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NULL AND not_canonicalizable_reason_code IN(
          'MISSING_NAME','NON_PRODUCT_PROVENANCE','COMPANY_IDENTITY_INVALID',
          'RUN_POOL_CAP_REACHED')
        OR outcome IN ('RAW_QUARANTINED','RAW_REJECTED')
        AND restricted_disposition_id IS NULL AND suppression_match_sha256 IS NULL
        AND suppression_match_count IS NULL AND raw_expired_at IS NULL
        AND not_canonicalizable_reason_code IS NULL)
    )
  );

-- 同一迁移放宽 run_event 的事件词汇表：物化 finalize 在 run 收据同一事务里追加
-- pool_cap_reached（纯放宽，已存事件全部仍满足约束）。
ALTER TABLE public.run_event DROP CONSTRAINT run_event_type_check;

ALTER TABLE public.run_event ADD CONSTRAINT run_event_type_check CHECK(
    "type" IN (
      'phase_started',
      'phase_completed',
      'company_entered_stage',
      'company_done',
      'company_failed',
      'budget_exhausted',
      'lease_skipped',
      'pool_cap_reached',
      'run_finished'
    )
  );
