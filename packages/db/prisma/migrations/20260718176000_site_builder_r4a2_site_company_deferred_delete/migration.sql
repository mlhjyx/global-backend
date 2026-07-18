-- The same-workspace Site -> CompanyProfile guard must not break deletion of
-- an entire Workspace, where both rows are removed by independent CASCADE
-- paths. Deferral preserves the guard for standalone CompanyProfile deletes
-- while allowing the workspace transaction to reach a consistent end state.

SET LOCAL lock_timeout = '5s';

LOCK TABLE "company_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "site"
  DROP CONSTRAINT "site_company_profile_workspace_fkey",
  ADD CONSTRAINT "site_company_profile_workspace_fkey"
    FOREIGN KEY ("company_profile_id", "workspace_id")
    REFERENCES "company_profile"("id", "workspace_id")
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;
