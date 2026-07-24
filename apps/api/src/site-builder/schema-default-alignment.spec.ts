import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../../..");
const schema = readFileSync(
  path.join(repo, "packages/db/prisma/schema.prisma"),
  "utf8",
);

function model(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`missing Prisma model ${name}`);
  return match[1]!;
}

describe("Prisma schema matches database-owned defaults and relations", () => {
  it.each([
    "SiteRelease",
    "SitePublishableClaimSnapshot",
    "SitePublishableClaimSnapshotItem",
    "SiteCopyBundle",
  ])("keeps the migration-owned UUID default for %s", (modelName) => {
    expect(model(modelName)).toMatch(
      /id\s+String\s+@id @default\(dbgenerated\("gen_random_uuid\(\)"\)\) @db\.Uuid/,
    );
  });

  it.each(["SiteRelease", "SiteBuildBudget", "SiteBuildTaskAttempt"])(
    "keeps the migration-owned updated_at default for %s",
    (modelName) => {
      expect(model(modelName)).toMatch(
        /updatedAt\s+DateTime\s+@default\(now\(\)\) @updatedAt @map\("updated_at"\)/,
      );
    },
  );

  it("does not invent indexes or foreign keys absent from the migration history", () => {
    expect(model("SiteCopyBundle")).not.toContain(
      "site_copy_bundle_id_workspace_site_key",
    );
    expect(model("CompanyProfile")).not.toContain(
      "publishableClaimSnapshotItems",
    );
    expect(model("SitePublishableClaimSnapshotItem")).not.toMatch(
      /companyProfile\s+CompanyProfile\s+@relation/,
    );
  });
});
