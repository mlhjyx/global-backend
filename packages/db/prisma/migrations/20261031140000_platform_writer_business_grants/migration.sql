-- L4-G23：平台写入者（execution_budget_platform_writer）补齐四个「带回执」写入分支
-- （采集 / 网站巡检 / 专利缓存刷新 / 制裁刷新）需要的业务表权限。
--
-- 权限面按代码推导（2026-10-10 设计 §1.2，2026-10-31 复核）：
--   monitored_source / source_fetch / sanctions_source / patent_lookup_request /
--   patent_cache_refresh_audit            → SELECT, UPDATE
--   source_entity / sanctions_entity      → SELECT, INSERT, UPDATE
--   source_entity_change                  → INSERT
--   patent_inventor_cache                 → SELECT, INSERT, UPDATE, DELETE
--   patent_inventor_tombstone             → SELECT
-- 这些表都没有 RLS，平台写入者是 NOBYPASSRLS；外键检查以表属主身份执行。
--
-- 写法沿用本仓既有的「先全收再精确授予 + 迁移内自检」：任何多余或缺失的权限
-- 都会让迁移失败（fail closed），清单在 docs/governance/platform-writer-table-privileges.json。

REVOKE ALL ON TABLE
  "monitored_source",
  "source_fetch",
  "source_entity",
  "source_entity_change",
  "sanctions_source",
  "sanctions_entity",
  "patent_lookup_request",
  "patent_cache_refresh_audit",
  "patent_inventor_cache",
  "patent_inventor_tombstone"
FROM PUBLIC;
REVOKE ALL ON TABLE
  "monitored_source",
  "source_fetch",
  "source_entity",
  "source_entity_change",
  "sanctions_source",
  "sanctions_entity",
  "patent_lookup_request",
  "patent_cache_refresh_audit",
  "patent_inventor_cache",
  "patent_inventor_tombstone"
FROM execution_budget_platform_writer;

GRANT SELECT, UPDATE ON TABLE
  "monitored_source",
  "source_fetch",
  "sanctions_source",
  "patent_lookup_request",
  "patent_cache_refresh_audit"
TO execution_budget_platform_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE
  "source_entity",
  "sanctions_entity"
TO execution_budget_platform_writer;
GRANT INSERT ON TABLE "source_entity_change"
TO execution_budget_platform_writer;
GRANT SELECT ON TABLE "patent_inventor_tombstone"
TO execution_budget_platform_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "patent_inventor_cache"
TO execution_budget_platform_writer;

-- 自检：逐表比对七种表级权限，与上面的授予逐字一致（多一项少一项都失败）。
DO $$
DECLARE
  spec RECORD;
  actual TEXT[];
  expected TEXT[];
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('monitored_source', ARRAY['SELECT','UPDATE']),
      ('source_fetch', ARRAY['SELECT','UPDATE']),
      ('source_entity', ARRAY['INSERT','SELECT','UPDATE']),
      ('source_entity_change', ARRAY['INSERT']),
      ('sanctions_source', ARRAY['SELECT','UPDATE']),
      ('sanctions_entity', ARRAY['INSERT','SELECT','UPDATE']),
      ('patent_lookup_request', ARRAY['SELECT','UPDATE']),
      ('patent_cache_refresh_audit', ARRAY['SELECT','UPDATE']),
      ('patent_inventor_cache', ARRAY['DELETE','INSERT','SELECT','UPDATE']),
      ('patent_inventor_tombstone', ARRAY['SELECT'])
    ) AS t(table_name TEXT, privileges TEXT[])
  LOOP
    SELECT array_agg(privilege ORDER BY privilege) INTO actual
    FROM unnest(ARRAY['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) AS privilege
    WHERE has_table_privilege('execution_budget_platform_writer', format('public.%I', spec.table_name), privilege);
    SELECT array_agg(privilege ORDER BY privilege) INTO expected
    FROM unnest(spec.privileges) AS privilege;
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'PLATFORM_WRITER_PRIVILEGE_DRIFT: % (expected %, actual %)', spec.table_name, expected, actual
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END $$;
