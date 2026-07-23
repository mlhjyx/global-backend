import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateSiteSpecV1_1 } from "@global/contracts";
import { describe, expect, it } from "vitest";
import { STATIC_DESIGN_CATALOG_V2 } from "./catalog";
import { buildM1ebGoldenFixtures } from "./m1eb-golden";

describe("M1-e-B approved Golden matrix", () => {
  it("builds exactly six sparse/rich pairs through controlled assembly", async () => {
    const repositoryRoot = new URL("../../../../../", import.meta.url).pathname;
    const fixtures = await buildM1ebGoldenFixtures(repositoryRoot);
    expect(fixtures).toHaveLength(12);
    expect(new Set(fixtures.map((fixture) => fixture.id))).toHaveLength(12);
    expect(
      fixtures.filter((fixture) => fixture.mode === "sparse"),
    ).toHaveLength(6);
    expect(fixtures.filter((fixture) => fixture.mode === "rich")).toHaveLength(
      6,
    );
    expect(
      new Set(fixtures.map((fixture) => fixture.spec.site.familyId)),
    ).toEqual(new Set(STATIC_DESIGN_CATALOG_V2.families.map(({ id }) => id)));
    for (const fixture of fixtures) {
      expect(validateSiteSpecV1_1(fixture.spec)).toEqual(fixture.spec);
      expect(fixture.spec.componentLibraryVersion).toBe(
        fixture.designBrief.componentLibraryVersion,
      );
      expect(fixture.spec.rendererVersion).toBe(
        fixture.designBrief.rendererVersion,
      );
    }

    const directory = path.join(
      repositoryRoot,
      "apps/site-renderer/fixtures/m1-e-b-golden",
    );
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "manifest.json"), "utf8"),
    ) as {
      fixtures: Array<{
        id: string;
        designBriefDigest: string;
        specSha256: string;
      }>;
    };
    expect(readdirSync(directory).sort()).toEqual(
      [...fixtures.map(({ id }) => `${id}-spec.json`), "manifest.json"].sort(),
    );
    for (const fixture of fixtures) {
      const bytes = readFileSync(
        path.join(directory, `${fixture.id}-spec.json`),
      );
      expect(JSON.parse(bytes.toString())).toEqual(fixture.spec);
      expect(
        manifest.fixtures.find(({ id }) => id === fixture.id),
      ).toMatchObject({
        designBriefDigest: fixture.designBrief.digest,
        specSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  });
});
