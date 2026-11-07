-- S1-3：Pack Studio 以 app_user 发布版本，需 INSERT；不可变性仍由
-- REVOKE UPDATE/DELETE/TRUNCATE 保证（发布后不可改不可删）。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

GRANT INSERT ON TABLE "pack_version" TO app_user;

COMMIT;
