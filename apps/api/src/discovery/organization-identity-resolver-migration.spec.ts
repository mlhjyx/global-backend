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
  return sql.replace(/(\$[a-z0-9_]*\$)[\s\S]*?\1/giu, "$1$1");
}

type PublicFunctionDefinition = Readonly<{
  name: string;
  parameterDeclaration: string;
  parameterTypes: string;
  header: string;
  definition: string;
}>;

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function sqlWithoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/gu, "");
}

function parameterTypes(parameters: string): string {
  return parameters
    .split(",")
    .map((parameter) =>
      normalizeSql(parameter)
        .replace(/^(?:in|out|inout|variadic)\s+/u, "")
        .replace(/^[a-z_][a-z0-9_]*\s+/u, ""),
    )
    .join(", ");
}

function publicFunctionDefinitions(sql: string): PublicFunctionDefinition[] {
  const definitions: PublicFunctionDefinition[] = [];
  const functionPattern =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\b[\s\S]*?AS\s+(?:(?<dollar>\$[a-z0-9_]*\$)[\s\S]*?\k<dollar>|'(?:''|[^'])*')\s*;/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(functionPattern)) {
    const definition = match[0];
    const header = definition.slice(
      0,
      definition.search(/\s+AS\s+(?:\$[a-z0-9_]*\$|')/iu),
    );
    definitions.push({
      name: match[1].toLowerCase(),
      parameterDeclaration: normalizeSql(match[2]),
      parameterTypes: parameterTypes(match[2]),
      header: normalizeSql(header),
      definition,
    });
  }
  return definitions;
}

function functionGrantees(
  sql: string,
  definition: PublicFunctionDefinition,
): string[][] {
  const grants: string[][] = [];
  const grantPattern =
    /^\s*GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+TO\s+([^;]+);/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(grantPattern)) {
    if (
      match[1].toLowerCase() === definition.name &&
      parameterTypes(match[2]) === definition.parameterTypes
    ) {
      grants.push(match[3].split(",").map(normalizeSql));
    }
  }
  return grants;
}

function functionRevokes(
  sql: string,
  definition: PublicFunctionDefinition,
): string[][] {
  const revokes: string[][] = [];
  const revokePattern =
    /^\s*REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+FROM\s+([^;]+);/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(revokePattern)) {
    if (
      match[1].toLowerCase() === definition.name &&
      parameterTypes(match[2]) === definition.parameterTypes
    ) {
      revokes.push(match[3].split(",").map(normalizeSql));
    }
  }
  return revokes;
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
    const definitions = publicFunctionDefinitions(sql);
    const commands = definitions.filter(
      (definition) =>
        definition.name === "resolve_organization_identity_for_raw_v1" &&
        definition.parameterTypes === "text, text",
    );

    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command.parameterDeclaration).toBe(
      "p_workspace_id text, p_raw_record_id text",
    );
    expect(command.header).toContain("language plpgsql security definer");
    expect(command.header).toContain("set search_path = pg_catalog, public");
    expect(command.header).toContain("set row_security = off");
    expect(command.header).not.toContain("set lock_timeout");
    expect(command.header).not.toContain("set statement_timeout");
    expect(sql).toMatch(/current_setting\(\s*'lock_timeout',\s*true\s*\)/u);
    expect(sql).toMatch(
      /current_setting\(\s*'statement_timeout',\s*true\s*\)/u,
    );
    expect(sql).toMatch(/lock_timeout_seconds\s+NOT BETWEEN 0\.001 AND 5/u);
    expect(sql).toMatch(
      /statement_timeout_seconds\s+NOT BETWEEN 0\.001 AND 60/u,
    );
    expect(sql).toMatch(/EXCEPTION WHEN query_canceled THEN/u);
    expect(sql).toMatch(/WHEN assert_failure THEN/u);
    expect(
      sql.match(/clock_timestamp\(\)\s*>=\s*statement_deadline/gu),
    ).toHaveLength(1);
    expect(sql).toMatch(
      /EXCEPTION WHEN query_canceled THEN[\s\S]*clock_timestamp\(\)\s*>=\s*statement_deadline/u,
    );
    expect(functionRevokes(sql, command)).toEqual([["public"]]);
    expect(functionGrantees(sql, command)).toEqual([["app_user"]]);
    expect(command.definition).not.toMatch(
      /public\.(?:raw_source_record|raw_source_governance_disposition|canonical_company|organization_identifier|organization_canonical_mapping|suppression_record|identity_link|organization_identity_conflict|organization_identity_conflict_party)\b/iu,
    );
    expect(command.definition).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\./iu,
    );
    expect(
      command.definition.match(
        /organization_identity_resolve_for_raw_worker_v1/gu,
      ),
    ).toHaveLength(1);
    expect(command.definition).toMatch(
      /EXECUTE[\s\S]*USING[\s\S]*v_workspace_id/u,
    );
    const workers = definitions.filter(
      (definition) =>
        definition.name === "organization_identity_resolve_for_raw_worker_v1" &&
        definition.parameterTypes === "text, text",
    );
    expect(workers).toHaveLength(1);
    const [worker] = workers;
    expect(worker.header).toContain("language plpgsql security invoker");
    expect(worker.header).toContain("set search_path = pg_catalog, public");
    expect(worker.header).toContain("set row_security = off");
    expect(worker.header).not.toContain("set lock_timeout");
    expect(worker.header).not.toContain("set statement_timeout");
    expect(functionRevokes(sql, worker)).toEqual([["public", "app_user"]]);
    expect(functionGrantees(sql, worker)).toEqual([]);
    expect(sql).not.toMatch(
      /ALTER FUNCTION public\.[a-z0-9_]+\([^)]*\) OWNER TO (?!global\b)/iu,
    );
    for (const definition of definitions) {
      if (definition === command) continue;
      expect(functionRevokes(sql, definition)).toEqual([
        ["public", "app_user"],
      ]);
      expect(functionGrantees(sql, definition)).toEqual([]);
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
