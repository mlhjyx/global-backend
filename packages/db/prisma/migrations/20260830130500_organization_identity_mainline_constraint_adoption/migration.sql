BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.canonical_company IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.discovery_company_materialization_outcome IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.organization_identity_decision IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.organization_identifier IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.organization_canonical_mapping IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.organization_identity_conflict_party IN ACCESS EXCLUSIVE MODE;

DO $inventory$
DECLARE
  main_index_oid oid;
  temporary_index_oid oid;
  canonical_company_oid oid := 'public.canonical_company'::regclass;
  exact_count integer;
  rebind_materialization_outcome boolean := false;
  rebind_mapping_canonical boolean := false;
  rebind_mapping_source boolean := false;
  rebind_identifier boolean := false;
  rebind_conflict_party boolean := false;
  rebind_decision boolean := false;
BEGIN
  SELECT constraint_row.conindid
    INTO main_index_oid
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row
      ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_row.relnamespace
    JOIN pg_index AS index_row
      ON index_row.indexrelid = constraint_row.conindid
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE table_namespace.nspname = 'public'
     AND table_row.relname = 'canonical_company'
     AND constraint_row.conname = 'canonical_company_workspace_id_id_key'
     AND constraint_row.contype = 'u'
     AND constraint_row.conkey = ARRAY[
       (SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
         WHERE attribute_row.attrelid = canonical_company_oid
           AND attribute_row.attname = 'workspace_id'
           AND NOT attribute_row.attisdropped),
       (SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
         WHERE attribute_row.attrelid = canonical_company_oid
           AND attribute_row.attname = 'id'
           AND NOT attribute_row.attisdropped)
     ]::smallint[]
     AND constraint_row.convalidated
     AND NOT constraint_row.condeferrable
     AND NOT constraint_row.condeferred
     AND index_namespace.nspname = 'public'
     AND index_relation.relname = 'canonical_company_workspace_id_id_key'
     AND index_relation.relkind = 'i'
     AND access_method.amname = 'btree'
     AND index_row.indrelid = canonical_company_oid
     AND index_row.indisunique
     AND NOT index_row.indisprimary
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indislive
     AND index_row.indpred IS NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 2
     AND index_row.indnatts = 2
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY['workspace_id', 'id']::name[];

  IF main_index_oid IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_MAINLINE_CONSTRAINT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT relation_row.oid
    INTO temporary_index_oid
    FROM pg_class AS relation_row
    JOIN pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation_row.relnamespace
   WHERE relation_namespace.nspname = 'public'
     AND relation_row.relname =
       'canonical_company_workspace_id_id_artifact_a_key';

  IF temporary_index_oid IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_index AS index_row
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
     WHERE index_row.indexrelid = temporary_index_oid
       AND index_relation.relkind = 'i'
       AND access_method.amname = 'btree'
       AND index_row.indrelid = canonical_company_oid
       AND index_row.indisunique
       AND NOT index_row.indisprimary
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND index_row.indpred IS NULL
       AND index_row.indexprs IS NULL
       AND index_row.indnkeyatts = 2
       AND index_row.indnatts = 2
       AND NOT EXISTS (
         SELECT 1
           FROM pg_constraint AS owner_constraint
          WHERE owner_constraint.conindid = temporary_index_oid
            AND owner_constraint.contype IN ('p', 'u', 'x')
       )
       AND (
         SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
           FROM unnest(index_row.indkey)
                WITH ORDINALITY AS key_row(attnum, ordinality)
           JOIN pg_attribute AS attribute_row
             ON attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attnum = key_row.attnum
          WHERE key_row.ordinality <= index_row.indnkeyatts
       ) = ARRAY['workspace_id', 'id']::name[]
  ) THEN
    RAISE EXCEPTION 'IDENTITY_ARTIFACT_A_TEMP_INDEX_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  WITH expected_fk(constraint_name, table_name, definition) AS (
    VALUES
      (
        'discovery_company_materialization_outcome_company_fkey'::name,
        'discovery_company_materialization_outcome'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'::text
      ),
      (
        'organization_canonical_mapping_canonical_scope_fkey'::name,
        'organization_canonical_mapping'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_canonical_mapping_source_scope_fkey'::name,
        'organization_canonical_mapping'::name,
        'FOREIGN KEY (workspace_id, source_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identifier_company_scope_fkey'::name,
        'organization_identifier'::name,
        'FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identity_conflict_party_company_scope_fkey'::name,
        'organization_identity_conflict_party'::name,
        'FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identity_decision_company_scope_fkey'::name,
        'organization_identity_decision'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      )
  )
  SELECT count(*)
    INTO exact_count
    FROM expected_fk
    JOIN pg_namespace AS table_namespace
      ON table_namespace.nspname = 'public'
    JOIN pg_class AS table_row
      ON table_row.relnamespace = table_namespace.oid
     AND table_row.relname = expected_fk.table_name
    JOIN pg_constraint AS constraint_row
      ON constraint_row.conrelid = table_row.oid
     AND constraint_row.conname = expected_fk.constraint_name
   WHERE constraint_row.contype = 'f'
     AND constraint_row.confrelid = canonical_company_oid
     AND constraint_row.convalidated
     AND NOT constraint_row.condeferrable
     AND NOT constraint_row.condeferred
     AND pg_get_constraintdef(constraint_row.oid, true) =
       expected_fk.definition
     AND constraint_row.conindid IN (main_index_oid, temporary_index_oid);

  IF exact_count <> 6 THEN
    RAISE EXCEPTION 'IDENTITY_ARTIFACT_A_FK_INVENTORY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF temporary_index_oid IS NOT NULL THEN
    WITH allowed_fk(constraint_name, table_name) AS (
      VALUES
        (
          'discovery_company_materialization_outcome_company_fkey'::name,
          'discovery_company_materialization_outcome'::name
        ),
        (
          'organization_canonical_mapping_canonical_scope_fkey'::name,
          'organization_canonical_mapping'::name
        ),
        (
          'organization_canonical_mapping_source_scope_fkey'::name,
          'organization_canonical_mapping'::name
        ),
        (
          'organization_identifier_company_scope_fkey'::name,
          'organization_identifier'::name
        ),
        (
          'organization_identity_conflict_party_company_scope_fkey'::name,
          'organization_identity_conflict_party'::name
        ),
        (
          'organization_identity_decision_company_scope_fkey'::name,
          'organization_identity_decision'::name
        )
    )
    SELECT count(*)
      INTO exact_count
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row
        ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_row.relnamespace
     WHERE constraint_row.contype = 'f'
       AND constraint_row.conindid = temporary_index_oid
       AND NOT EXISTS (
         SELECT 1
           FROM allowed_fk
          WHERE allowed_fk.constraint_name = constraint_row.conname
            AND allowed_fk.table_name = table_row.relname
            AND table_namespace.nspname = 'public'
       );

    IF exact_count <> 0 THEN
      RAISE EXCEPTION 'IDENTITY_ARTIFACT_A_TEMP_INDEX_DEPENDENCY_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO exact_count
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
   WHERE index_row.indrelid = canonical_company_oid
     AND index_row.indisunique
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indpred IS NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 2
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY['workspace_id', 'id']::name[]
     AND index_namespace.nspname = 'public';

  IF exact_count <>
     (CASE WHEN temporary_index_oid IS NULL THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'IDENTITY_CANONICAL_UNIQUE_INVENTORY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF temporary_index_oid IS NOT NULL THEN
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_materialization_outcome
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
       'public.discovery_company_materialization_outcome'::regclass
       AND constraint_row.conname =
         'discovery_company_materialization_outcome_company_fkey';
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_mapping_canonical
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
       'public.organization_canonical_mapping'::regclass
       AND constraint_row.conname =
         'organization_canonical_mapping_canonical_scope_fkey';
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_mapping_source
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
       'public.organization_canonical_mapping'::regclass
       AND constraint_row.conname =
         'organization_canonical_mapping_source_scope_fkey';
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_identifier
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.organization_identifier'::regclass
       AND constraint_row.conname =
         'organization_identifier_company_scope_fkey';
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_conflict_party
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
       'public.organization_identity_conflict_party'::regclass
       AND constraint_row.conname =
         'organization_identity_conflict_party_company_scope_fkey';
    SELECT constraint_row.conindid = temporary_index_oid
      INTO rebind_decision
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
       'public.organization_identity_decision'::regclass
       AND constraint_row.conname =
         'organization_identity_decision_company_scope_fkey';

    IF rebind_materialization_outcome THEN
      EXECUTE 'ALTER TABLE public.discovery_company_materialization_outcome DROP CONSTRAINT discovery_company_materialization_outcome_company_fkey';
    END IF;
    IF rebind_decision THEN
      EXECUTE 'ALTER TABLE public.organization_identity_decision DROP CONSTRAINT organization_identity_decision_company_scope_fkey';
    END IF;
    IF rebind_identifier THEN
      EXECUTE 'ALTER TABLE public.organization_identifier DROP CONSTRAINT organization_identifier_company_scope_fkey';
    END IF;
    IF rebind_mapping_source THEN
      EXECUTE 'ALTER TABLE public.organization_canonical_mapping DROP CONSTRAINT organization_canonical_mapping_source_scope_fkey';
    END IF;
    IF rebind_mapping_canonical THEN
      EXECUTE 'ALTER TABLE public.organization_canonical_mapping DROP CONSTRAINT organization_canonical_mapping_canonical_scope_fkey';
    END IF;
    IF rebind_conflict_party THEN
      EXECUTE 'ALTER TABLE public.organization_identity_conflict_party DROP CONSTRAINT organization_identity_conflict_party_company_scope_fkey';
    END IF;

    EXECUTE 'DROP INDEX public.canonical_company_workspace_id_id_artifact_a_key';

    IF rebind_materialization_outcome THEN
      EXECUTE 'ALTER TABLE public.discovery_company_materialization_outcome ADD CONSTRAINT discovery_company_materialization_outcome_company_fkey FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES public.canonical_company(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT';
    END IF;
    IF rebind_decision THEN
      EXECUTE 'ALTER TABLE public.organization_identity_decision ADD CONSTRAINT organization_identity_decision_company_scope_fkey FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION';
    END IF;
    IF rebind_identifier THEN
      EXECUTE 'ALTER TABLE public.organization_identifier ADD CONSTRAINT organization_identifier_company_scope_fkey FOREIGN KEY (workspace_id, company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION';
    END IF;
    IF rebind_mapping_source THEN
      EXECUTE 'ALTER TABLE public.organization_canonical_mapping ADD CONSTRAINT organization_canonical_mapping_source_scope_fkey FOREIGN KEY (workspace_id, source_company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION';
    END IF;
    IF rebind_mapping_canonical THEN
      EXECUTE 'ALTER TABLE public.organization_canonical_mapping ADD CONSTRAINT organization_canonical_mapping_canonical_scope_fkey FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION';
    END IF;
    IF rebind_conflict_party THEN
      EXECUTE 'ALTER TABLE public.organization_identity_conflict_party ADD CONSTRAINT organization_identity_conflict_party_company_scope_fkey FOREIGN KEY (workspace_id, company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION';
    END IF;
  END IF;
END $inventory$;

DO $postcondition$
DECLARE
  main_index_oid oid;
  canonical_company_oid oid := 'public.canonical_company'::regclass;
  exact_count integer;
BEGIN
  SELECT constraint_row.conindid
    INTO main_index_oid
    FROM pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = canonical_company_oid
     AND constraint_row.conname = 'canonical_company_workspace_id_id_key'
     AND constraint_row.contype = 'u'
     AND constraint_row.convalidated
     AND NOT constraint_row.condeferrable
     AND NOT constraint_row.condeferred;

  IF main_index_oid IS NULL OR
     to_regclass('public.canonical_company_workspace_id_id_artifact_a_key')
       IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MAINLINE_CONSTRAINT_ADOPTION_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  WITH expected_fk(constraint_name, table_name, definition) AS (
    VALUES
      (
        'discovery_company_materialization_outcome_company_fkey'::name,
        'discovery_company_materialization_outcome'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT'::text
      ),
      (
        'organization_canonical_mapping_canonical_scope_fkey'::name,
        'organization_canonical_mapping'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_canonical_mapping_source_scope_fkey'::name,
        'organization_canonical_mapping'::name,
        'FOREIGN KEY (workspace_id, source_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identifier_company_scope_fkey'::name,
        'organization_identifier'::name,
        'FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identity_conflict_party_company_scope_fkey'::name,
        'organization_identity_conflict_party'::name,
        'FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      ),
      (
        'organization_identity_decision_company_scope_fkey'::name,
        'organization_identity_decision'::name,
        'FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT'::text
      )
  )
  SELECT count(*)
    INTO exact_count
    FROM expected_fk
    JOIN pg_namespace AS table_namespace
      ON table_namespace.nspname = 'public'
    JOIN pg_class AS table_row
      ON table_row.relnamespace = table_namespace.oid
     AND table_row.relname = expected_fk.table_name
    JOIN pg_constraint AS constraint_row
      ON constraint_row.conrelid = table_row.oid
     AND constraint_row.conname = expected_fk.constraint_name
   WHERE constraint_row.contype = 'f'
     AND constraint_row.confrelid = canonical_company_oid
     AND constraint_row.convalidated
     AND NOT constraint_row.condeferrable
     AND NOT constraint_row.condeferred
     AND constraint_row.conindid = main_index_oid
     AND pg_get_constraintdef(constraint_row.oid, true) =
       expected_fk.definition;

  IF exact_count <> 6 THEN
    RAISE EXCEPTION 'IDENTITY_MAINLINE_FK_ADOPTION_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO exact_count
    FROM pg_index AS index_row
   WHERE index_row.indrelid = canonical_company_oid
     AND index_row.indisunique
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indpred IS NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 2
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY['workspace_id', 'id']::name[];

  IF exact_count <> 1 THEN
    RAISE EXCEPTION 'IDENTITY_MAINLINE_UNIQUE_ADOPTION_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END $postcondition$;

COMMIT;
