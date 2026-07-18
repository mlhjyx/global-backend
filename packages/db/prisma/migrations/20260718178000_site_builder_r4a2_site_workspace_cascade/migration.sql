-- Site historically carries workspace_id + FORCE RLS without a physical
-- Workspace FK; two development rows confirm that legacy shape. Do not invent
-- tenant anchors or make the Site write path newly depend on them. Instead,
-- delete tenant Sites before Workspace cascades reach CompanyProfile so the
-- deferred same-workspace Site -> CompanyProfile guard is satisfied at commit.

SET LOCAL lock_timeout = '5s';

LOCK TABLE "workspace" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION cascade_workspace_sites()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "site" WHERE "workspace_id" = OLD."id";
  RETURN OLD;
END
$$;

CREATE TRIGGER workspace_sites_cascade
  BEFORE DELETE ON "workspace"
  FOR EACH ROW EXECUTE FUNCTION cascade_workspace_sites();
