-- Workspace deletion cannot safely own object-store cleanup yet. The previous
-- trigger physically removed Sites and let relational cascades erase Asset and
-- release provenance without scheduling canonical object cleanup. Fail closed
-- until an explicit tenant-deletion workflow has drained those resources.

SET LOCAL lock_timeout = '5s';

LOCK TABLE "workspace" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site" IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS workspace_sites_cascade ON "workspace";
DROP FUNCTION IF EXISTS cascade_workspace_sites();

CREATE FUNCTION guard_workspace_delete_without_sites()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "site"
    WHERE "workspace_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION
      'Workspace deletion requires explicit Site/object cleanup before physical deletion'
      USING ERRCODE = '23503';
  END IF;

  RETURN OLD;
END
$$;

CREATE TRIGGER workspace_delete_without_sites_guard
  BEFORE DELETE ON "workspace"
  FOR EACH ROW EXECUTE FUNCTION guard_workspace_delete_without_sites();
