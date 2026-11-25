import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIRECTORY_FALLBACK_BLOCKED_DOMAINS,
  DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN,
  PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
} from "./source-policy-scope";

const MIGRATION_PATH = fileURLToPath(
  new URL(
    "../../../../packages/db/prisma/migrations/20261125110000_model_web_search_optional_query_and_directory_listing_policy/migration.sql",
    import.meta.url,
  ),
);

describe("Batch 1.5-B raw-source migration contract parity", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("wraps both function replacements in a bounded transaction and revokes PUBLIC/app_user execute", () => {
    expect(sql).toMatch(/^BEGIN;/mu);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.raw_source_provider_payload_valid_v2_legacy(TEXT,JSONB) FROM PUBLIC, app_user;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.raw_source_policy_binding_v3(TEXT,TEXT,TEXT,JSONB,UUID,INTEGER) FROM PUBLIC, app_user;",
    );
    expect(sql.trimEnd()).toMatch(/COMMIT;$/u);
  });

  it("makes model_web_search.attributes.searchQuery optional in SQL to match TS normalizer", () => {
    const match = sql.match(
      /WHEN 'model_web_search' THEN\s+IF NOT public\.raw_source_json_keys_within_v2\(\s*attributes,\s*ARRAY\[([^\]]+)\],\s*ARRAY\[([^\]]+)\]/su,
    );
    expect(match).not.toBeNull();
    const allowed = [...match![1]!.matchAll(/'([^']+)'/gu)].map((m) => m[1]);
    const required = [...match![2]!.matchAll(/'([^']+)'/gu)].map((m) => m[1]);
    expect(allowed).toEqual([
      "discoveredBy",
      "evidenceUrls",
      "searchExecutor",
      "searchQuery",
    ]);
    expect(required).toEqual([
      "discoveredBy",
      "evidenceUrls",
      "searchExecutor",
    ]);
  });

  it("keeps SQL directory fallback policy key and blocked deny-list 1:1 with TypeScript", () => {
    expect(sql).toContain(
      `WHERE candidate."domain" NOT IN ('${PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN}', '${DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN}')`,
    );
    expect(sql).toContain(
      `ELSIF bound_policy.domain='${DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN}' THEN`,
    );
    const blockedMatch = sql.match(/FROM unnest\(ARRAY\[([^\]]+)\]\)\s+AS blocked\(domain\)/su);
    expect(blockedMatch).not.toBeNull();
    const sqlBlocked = [...blockedMatch![1]!.matchAll(/'([^']+)'/gu)].map((m) => m[1]);
    expect(sqlBlocked).toEqual([...DIRECTORY_FALLBACK_BLOCKED_DOMAINS]);
  });
});
