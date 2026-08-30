import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const migrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260830090000_organization_identity_v2_resolver_command/migration.sql",
);
const schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");
const resolverPath = resolve(
  repositoryRoot,
  "apps/api/src/discovery/organization-identity-resolver.ts",
);
const lockPath = resolve(
  repositoryRoot,
  "apps/api/src/discovery/organization-identity-lock.ts",
);

function source(path: string): string {
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutDollarQuotedBodies(sql: string): string {
  return sql.replace(
    /\$function\$[\s\S]*?\$function\$/gu,
    "$function$$function$",
  );
}

describe("organization identity resolver command migration", () => {
  it("adds only the reviewed command migration and preserves the Prisma datamodel", () => {
    const sql = source(migrationPath);
    expect(
      sha256(source(schemaPath)),
      "Task 6B.2c must not change schema.prisma",
    ).toBe("0858f0d36634246e20a4dfd5fdae3ab6910d945af1e45e0c44ad489a13a0fca4");
    const topLevel = withoutDollarQuotedBodies(sql);
    expect(topLevel.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(topLevel.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(topLevel).not.toMatch(
      /^\s*(?:ALTER|CREATE|DROP)\s+(?:TABLE|TYPE|INDEX|POLICY)\b/gimu,
    );
    expect(topLevel).not.toMatch(
      /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY)\b/gimu,
    );
    expect(sql).not.toMatch(/ALTER\s+TABLE[\s\S]*GRANT/giu);
  });

  it("rejects the JSON command and requires the two-ID public resolver with private helpers", () => {
    const sql = source(migrationPath);
    const command =
      "public.resolve_organization_identity_for_raw_v1(p_workspace_id text, p_raw_record_id text)";

    expect(sql).toContain(`CREATE FUNCTION ${command}`);
    expect(sql).not.toContain("apply_organization_identity_resolution_v1");
    expect(sql).toContain("SET lock_timeout = '5s'");
    expect(sql).toContain("SET statement_timeout = '60s'");
    expect(sql).toMatch(
      /LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*pg_catalog,\s*public/iu,
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.resolve_organization_identity_for_raw_v1(text, text) FROM PUBLIC",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.resolve_organization_identity_for_raw_v1(text, text) TO app_user",
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_organization_identity_for_raw_v1\(text, text\) TO (?!app_user\b)/iu,
    );
    expect(sql).not.toMatch(
      /ALTER FUNCTION public\.[a-z0-9_]+\([^)]*\) OWNER TO (?!global\b)/iu,
    );
    for (const match of sql.matchAll(
      /CREATE FUNCTION public\.([a-z0-9_]+)\([^)]*\)/gu,
    )) {
      if (match[1] === "resolve_organization_identity_for_raw_v1") continue;
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${match[1]}\\([^;]+ FROM PUBLIC, app_user`,
          "u",
        ),
      );
    }
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)[\s\S]*ON\s+(?:TABLE\s+)?(?:public\.)?(?:identity_link|organization_)/iu,
    );
  });

  it("takes suppression before identity and never contains the reverse order", () => {
    const sql = source(migrationPath);
    const suppression = sql.indexOf("acquisition-suppression-policy:");
    const identity = sql.indexOf("organization-identity:");
    expect(suppression).toBeGreaterThan(0);
    expect(identity).toBeGreaterThan(suppression);
    expect(sql.match(/acquisition-suppression-policy:/gu)).toHaveLength(1);
    expect(sql.match(/organization-identity:/gu)).toHaveLength(1);
  });

  it("keeps resolver and lock source isolated from product callers and SEC", () => {
    const resolver = source(resolverPath);
    const lock = source(lockPath);
    const combined = `${resolver}\n${lock}`;
    expect(combined).not.toMatch(
      /sec-edgar|temporal|discovery\.activities|tenant-projection|new\s+PrismaClient/iu,
    );
    expect(lock).not.toMatch(
      /export\s+(?:async\s+)?function\s+(?:lockWorkspaceOrganizationIdentity|lockIdentityOnly)/u,
    );
    expect(lock).not.toContain("alreadyIdentityLocked");
  });
});
