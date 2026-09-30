import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateSiteSpecV1_1 } from "@global/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlledAssemblyService } from "../assembly/controlled-assembly.service";
import { STATIC_DESIGN_CATALOG_V2 } from "./catalog";
import { buildM1ebGoldenFixtures, type M1ebGoldenFixture } from "./m1eb-golden";

const repositoryRoot = new URL("../../../../../", import.meta.url).pathname;
const directory = path.join(
  repositoryRoot,
  "apps/site-renderer/fixtures/m1-e-b-golden",
);

function expectApprovedGoldenFixture(fixture: M1ebGoldenFixture): void {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf8"),
  ) as {
    fixtures: Array<{
      id: string;
      designBriefDigest: string;
      specSha256: string;
    }>;
  };
  const bytes = readFileSync(path.join(directory, `${fixture.id}-spec.json`));
  expect(JSON.parse(bytes.toString())).toEqual(fixture.spec);
  expect(manifest.fixtures.find(({ id }) => id === fixture.id)).toMatchObject({
    designBriefDigest: fixture.designBrief.digest,
    specSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

describe("M1-e-B approved Golden matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Tests that assemble fixtures get 60 s: every assembly re-validates the
  // whole design catalog, and the full matrix took about 2.5 s alone at load
  // ~20 and about 10 s at load ~45 on a 4-core host, past the 5 s default.
  it("builds exactly six sparse/rich pairs through controlled assembly", async () => {
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

    expect(readdirSync(directory).sort()).toEqual(
      [...fixtures.map(({ id }) => `${id}-spec.json`), "manifest.json"].sort(),
    );
    for (const fixture of fixtures) {
      expectApprovedGoldenFixture(fixture);
    }
  }, 60_000);

  it("assembles only the requested fixtures, identical to their approved entries", async () => {
    const assemble = vi.spyOn(ControlledAssemblyService.prototype, "assemble");

    const fixtures = await buildM1ebGoldenFixtures(repositoryRoot, {
      ids: ["oem-capability-sparse", "natural-origin-rich"],
    });

    expect(assemble).toHaveBeenCalledTimes(2);
    expect(fixtures.map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: "natural-origin-rich", mode: "rich" },
      { id: "oem-capability-sparse", mode: "sparse" },
    ]);
    for (const fixture of fixtures) {
      expectApprovedGoldenFixture(fixture);
    }
  }, 60_000);

  it("rejects an unknown fixture id before assembling anything", async () => {
    const assemble = vi.spyOn(ControlledAssemblyService.prototype, "assemble");

    await expect(
      buildM1ebGoldenFixtures(repositoryRoot, {
        ids: ["natural-origin-rich", "missing-fixture"],
      }),
    ).rejects.toThrow("M1_E_B_GOLDEN_FIXTURE_UNKNOWN: missing-fixture");
    expect(assemble).not.toHaveBeenCalled();
  });
});
