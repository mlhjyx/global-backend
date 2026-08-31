BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.identity_link IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.discovery_company_materialization_outcome
  IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  identity_link_oid oid := to_regclass('public.identity_link');
  outcome_oid oid :=
    to_regclass('public.discovery_company_materialization_outcome');
  company_raw_index_oid oid;
  party_tuple_index_oid oid;
  dependency_count integer;
  allowed_dependency_count integer;
BEGIN
  IF identity_link_oid IS NULL OR outcome_oid IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_LINK_MATERIALIZATION_CATALOG_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.identity_link AS link_row
     WHERE link_row.canonical_type = 'company'
       AND link_row.status = 'ACTIVE'
     GROUP BY link_row.workspace_id, link_row.raw_record_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'IDENTITY_LINK_ACTIVE_DUPLICATE_INVENTORY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.discovery_company_materialization_outcome AS outcome_row
     WHERE outcome_row.outcome = 'CANONICALIZED'
       AND NOT EXISTS (
         SELECT 1
           FROM public.identity_link AS link_row
          WHERE link_row.workspace_id = outcome_row.workspace_id
            AND link_row.id = outcome_row.identity_link_id
            AND link_row.canonical_type =
              outcome_row.identity_canonical_type
            AND link_row.canonical_id = outcome_row.canonical_company_id
            AND link_row.raw_record_id = outcome_row.raw_record_id
            AND link_row.status = 'ACTIVE'
            AND link_row.conflict_id IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT index_row.indexrelid
    INTO company_raw_index_oid
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE index_namespace.nspname = 'public'
     AND index_relation.relname = 'identity_link_company_raw_unique'
     AND index_relation.relkind = 'i'
     AND access_method.amname = 'btree'
     AND index_row.indrelid = identity_link_oid
     AND index_row.indisunique
     AND NOT index_row.indisprimary
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indislive
     AND index_row.indpred IS NOT NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 2
     AND index_row.indnatts = 2
     AND pg_get_expr(index_row.indpred, index_row.indrelid, true) =
       'canonical_type = ''company''::text'
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY['workspace_id', 'raw_record_id']::name[];

  IF company_raw_index_oid IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_LINK_COMPANY_RAW_INDEX_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO dependency_count
    FROM pg_depend AS dependency_row
   WHERE dependency_row.classid = 'pg_class'::regclass
     AND dependency_row.objid = company_raw_index_oid;

  SELECT count(*)
    INTO allowed_dependency_count
    FROM pg_depend AS dependency_row
    JOIN pg_attribute AS attribute_row
      ON dependency_row.refclassid = 'pg_class'::regclass
     AND dependency_row.refobjid = identity_link_oid
     AND dependency_row.refobjsubid = attribute_row.attnum
     AND attribute_row.attrelid = identity_link_oid
   WHERE dependency_row.classid = 'pg_class'::regclass
     AND dependency_row.objid = company_raw_index_oid
     AND dependency_row.objsubid = 0
     AND dependency_row.deptype = 'a'
     AND attribute_row.attname IN (
       'workspace_id', 'canonical_type', 'raw_record_id'
     )
     AND NOT attribute_row.attisdropped;

  IF dependency_count <> 3 OR allowed_dependency_count <> 3 THEN
    RAISE EXCEPTION 'IDENTITY_LINK_COMPANY_RAW_INDEX_DEPENDENCY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT index_row.indexrelid
    INTO party_tuple_index_oid
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE index_namespace.nspname = 'public'
     AND index_relation.relname =
       'identity_link_workspace_canonical_raw_key'
     AND index_relation.relkind = 'i'
     AND access_method.amname = 'btree'
     AND index_row.indrelid = identity_link_oid
     AND index_row.indisunique
     AND NOT index_row.indisprimary
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indislive
     AND index_row.indpred IS NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 4
     AND index_row.indnatts = 4
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY[
       'workspace_id', 'canonical_type', 'canonical_id', 'raw_record_id'
     ]::name[];

  IF party_tuple_index_oid IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_LINK_PARTY_TUPLE_INDEX_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF to_regprocedure(
       'public.validate_discovery_company_materialization_identity_link_v1()'
     ) IS NOT NULL OR EXISTS (
       SELECT 1
         FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = outcome_oid
          AND trigger_row.tgname =
            'discovery_company_materialization_outcome_identity_link'
          AND NOT trigger_row.tgisinternal
     ) THEN
    RAISE EXCEPTION 'IDENTITY_LINK_MATERIALIZATION_CATALOG_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END $preflight$;

DROP INDEX public.identity_link_company_raw_unique;

CREATE UNIQUE INDEX identity_link_company_raw_unique
  ON public.identity_link(workspace_id, raw_record_id)
  WHERE canonical_type = 'company' AND status = 'ACTIVE';

CREATE FUNCTION public.validate_discovery_company_materialization_identity_link_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.outcome <> 'CANONICALIZED' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.identity_link AS link_row
     WHERE link_row.workspace_id = NEW.workspace_id
       AND link_row.id = NEW.identity_link_id
       AND link_row.canonical_type = NEW.identity_canonical_type
       AND link_row.canonical_id = NEW.canonical_company_id
       AND link_row.raw_record_id = NEW.raw_record_id
       AND link_row.status = 'ACTIVE'
       AND link_row.conflict_id IS NULL
  ) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $function$;

ALTER FUNCTION
  public.validate_discovery_company_materialization_identity_link_v1()
  OWNER TO global;
REVOKE ALL ON FUNCTION
  public.validate_discovery_company_materialization_identity_link_v1()
  FROM PUBLIC, app_user;

CREATE TRIGGER discovery_company_materialization_outcome_identity_link
BEFORE INSERT OR UPDATE
ON public.discovery_company_materialization_outcome
FOR EACH ROW
EXECUTE FUNCTION
  public.validate_discovery_company_materialization_identity_link_v1();

DO $postcondition$
DECLARE
  identity_link_oid oid := 'public.identity_link'::regclass;
  outcome_oid oid :=
    'public.discovery_company_materialization_outcome'::regclass;
  company_raw_index_oid oid;
  dependency_count integer;
  allowed_dependency_count integer;
  validator_oid oid;
BEGIN
  SELECT index_row.indexrelid
    INTO company_raw_index_oid
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE index_namespace.nspname = 'public'
     AND index_relation.relname = 'identity_link_company_raw_unique'
     AND index_relation.relkind = 'i'
     AND access_method.amname = 'btree'
     AND index_row.indrelid = identity_link_oid
     AND index_row.indisunique
     AND NOT index_row.indisprimary
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indislive
     AND index_row.indpred IS NOT NULL
     AND index_row.indexprs IS NULL
     AND index_row.indnkeyatts = 2
     AND index_row.indnatts = 2
     AND pg_get_expr(index_row.indpred, index_row.indrelid, true) =
       'canonical_type = ''company''::text AND status = ''ACTIVE''::identity_link_status'
     AND (
       SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
         FROM unnest(index_row.indkey)
              WITH ORDINALITY AS key_row(attnum, ordinality)
         JOIN pg_attribute AS attribute_row
           ON attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = key_row.attnum
        WHERE key_row.ordinality <= index_row.indnkeyatts
     ) = ARRAY['workspace_id', 'raw_record_id']::name[];

  IF company_raw_index_oid IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_LINK_COMPANY_RAW_INDEX_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO dependency_count
    FROM pg_depend AS dependency_row
   WHERE dependency_row.classid = 'pg_class'::regclass
     AND dependency_row.objid = company_raw_index_oid;

  SELECT count(*)
    INTO allowed_dependency_count
    FROM pg_depend AS dependency_row
   WHERE dependency_row.classid = 'pg_class'::regclass
     AND dependency_row.objid = company_raw_index_oid
     AND dependency_row.objsubid = 0
     AND (
       (
         dependency_row.refclassid = 'pg_class'::regclass
         AND dependency_row.refobjid = identity_link_oid
         AND dependency_row.deptype = 'a'
         AND EXISTS (
           SELECT 1
             FROM pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = identity_link_oid
              AND attribute_row.attnum = dependency_row.refobjsubid
              AND attribute_row.attname IN (
                'workspace_id', 'canonical_type', 'raw_record_id', 'status'
              )
              AND NOT attribute_row.attisdropped
         )
       ) OR (
         dependency_row.refclassid = 'pg_type'::regclass
         AND dependency_row.refobjid =
           'public.identity_link_status'::regtype
         AND dependency_row.refobjsubid = 0
         AND dependency_row.deptype = 'n'
       )
     );

  IF dependency_count <> 5 OR allowed_dependency_count <> 5 THEN
    RAISE EXCEPTION 'IDENTITY_LINK_COMPANY_RAW_INDEX_DEPENDENCY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT procedure_row.oid
    INTO validator_oid
    FROM pg_proc AS procedure_row
    JOIN pg_namespace AS procedure_namespace
      ON procedure_namespace.oid = procedure_row.pronamespace
    JOIN pg_language AS language_row
      ON language_row.oid = procedure_row.prolang
   WHERE procedure_namespace.nspname = 'public'
     AND procedure_row.proname =
       'validate_discovery_company_materialization_identity_link_v1'
     AND pg_get_function_identity_arguments(procedure_row.oid) = ''
     AND procedure_row.prorettype = 'trigger'::regtype
     AND language_row.lanname = 'plpgsql'
     AND pg_get_userbyid(procedure_row.proowner) = 'global'
     AND NOT procedure_row.prosecdef
     AND procedure_row.provolatile = 'v'
     AND procedure_row.proparallel = 'u'
     AND NOT procedure_row.proleakproof
     AND NOT procedure_row.proisstrict
     AND procedure_row.prokind = 'f'
     AND procedure_row.proconfig =
       ARRAY['search_path=pg_catalog, public']::text[]
     AND NOT EXISTS (
       SELECT 1
         FROM aclexplode(
           coalesce(
             procedure_row.proacl,
             acldefault('f', procedure_row.proowner)
           )
         ) AS acl_row
        WHERE acl_row.grantee = 0
          AND acl_row.privilege_type = 'EXECUTE'
     )
     AND NOT has_function_privilege(
       'app_user', procedure_row.oid, 'EXECUTE'
     );

  IF validator_oid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = outcome_oid
       AND trigger_row.tgname =
         'discovery_company_materialization_outcome_identity_link'
       AND trigger_row.tgfoid = validator_oid
       AND trigger_row.tgenabled = 'O'
       AND NOT trigger_row.tgisinternal
       AND pg_get_triggerdef(trigger_row.oid, true) =
         'CREATE TRIGGER discovery_company_materialization_outcome_identity_link BEFORE INSERT OR UPDATE ON discovery_company_materialization_outcome FOR EACH ROW EXECUTE FUNCTION validate_discovery_company_materialization_identity_link_v1()'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_LINK_MATERIALIZATION_CATALOG_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END $postcondition$;

COMMIT;
