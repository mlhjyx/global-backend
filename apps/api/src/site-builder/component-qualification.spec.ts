import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
  M1_E_A_COMPONENT_QUALIFICATIONS,
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
  assertReleaseQualificationRegistryIntegrity,
  getComponentReleaseReadiness,
  validateComponentQualification,
  type ComponentQualificationArtifact,
  type ComponentQualificationEvidence,
} from "@global/contracts";

const completeEvidence: ComponentQualificationEvidence = {
  schema: { artifactId: "hero-schema" },
  variants: { artifactId: "hero-variants" },
  contentBudget: { artifactId: "hero-content-budget" },
  accessibility: { artifactId: "hero-accessibility" },
  reducedMotion: { artifactId: "hero-reduced-motion" },
  fixtures: { artifactId: "hero-fixtures" },
  visualRegression: { artifactId: "hero-visual-regression" },
};

const sha256 = "a".repeat(64);
const fixtureFile = {
  fixtureId: "technical-baseline",
  repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json",
  sha256,
};
const visualOutputs = [
  {
    breakpoint: 375 as const,
    repositoryPath:
      "apps/site-renderer/visual-tests/__screenshots__/mobile-375/HeroBanner.png",
    sha256,
  },
  {
    breakpoint: 768 as const,
    repositoryPath:
      "apps/site-renderer/visual-tests/__screenshots__/tablet-768/HeroBanner.png",
    sha256,
  },
  {
    breakpoint: 1440 as const,
    repositoryPath:
      "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/HeroBanner.png",
    sha256,
  },
] as const;
const artifact = (
  artifactId: string,
  part: ComponentQualificationArtifact["part"],
  detail: Partial<ComponentQualificationArtifact> = {},
): ComponentQualificationArtifact =>
  ({
    artifactId,
    componentType: "HeroBanner",
    part,
    repositoryPath: `docs/evidence/site-builder/component-qualification/HeroBanner/${artifactId}.json`,
    sha256,
    ...detail,
  }) as ComponentQualificationArtifact;

const completeArtifacts: Readonly<
  Record<string, ComponentQualificationArtifact>
> = {
  "hero-schema": artifact("hero-schema", "schema"),
  "hero-variants": artifact("hero-variants", "variants", {
    variantValues: ["default", "technical-grid"],
  }),
  "hero-content-budget": artifact("hero-content-budget", "contentBudget"),
  "hero-accessibility": artifact("hero-accessibility", "accessibility"),
  "hero-reduced-motion": artifact("hero-reduced-motion", "reducedMotion"),
  "hero-fixtures": artifact("hero-fixtures", "fixtures", {
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [fixtureFile],
  }),
  "hero-visual-regression": artifact(
    "hero-visual-regression",
    "visualRegression",
    { breakpoints: [375, 768, 1440], outputs: visualOutputs },
  ),
};

describe("M1-e-A component qualification gate", () => {
  it("classifies the original ten release components as transitional debt", () => {
    expect(SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES).toHaveLength(10);
    expect(
      Object.isFrozen(SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES),
    ).toBe(true);
    expect(new Set(SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES)).toEqual(
      new Set(SITE_SPEC_RELEASE_COMPONENT_TYPES),
    );
    expect(getComponentReleaseReadiness("AboutBlock")).toEqual({
      status: "transitional_release",
    });
  });

  it("registers the three technical-baseline components and keeps the rest gallery-only", () => {
    expect(SITE_SPEC_COMPONENT_TYPES).toHaveLength(55);
    expect(getComponentReleaseReadiness("StatementBlock")).toEqual({
      status: "gallery_only",
    });
    expect(Object.keys(M1_E_A_COMPONENT_QUALIFICATIONS).sort()).toEqual([
      "CtaBanner",
      "HeroBanner",
      "StatsBand",
    ]);
    expect(Object.keys(M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS)).toHaveLength(
      21,
    );
    for (const componentType of [
      "CtaBanner",
      "HeroBanner",
      "StatsBand",
    ] as const) {
      expect(getComponentReleaseReadiness(componentType)).toMatchObject({
        status: "m1_e_a_qualified",
      });
    }
  });

  it("accepts evidence only when all seven contract parts are present", () => {
    expect(
      validateComponentQualification(
        "HeroBanner",
        completeEvidence,
        completeArtifacts,
      ),
    ).toEqual(completeEvidence);
  });

  it.each([
    "schema",
    "variants",
    "contentBudget",
    "accessibility",
    "reducedMotion",
    "fixtures",
    "visualRegression",
  ] as const)("rejects qualification missing %s evidence", (part) => {
    const incomplete = { ...completeEvidence } as Record<string, unknown>;
    delete incomplete[part];
    expect(() =>
      validateComponentQualification(
        "HeroBanner",
        incomplete as ComponentQualificationEvidence,
        completeArtifacts,
      ),
    ).toThrow(`COMPONENT_QUALIFICATION_INVALID: HeroBanner`);
  });

  it("requires every qualification reference to resolve to an artifact", () => {
    expect(() =>
      validateComponentQualification("HeroBanner", completeEvidence, {
        ...completeArtifacts,
        "hero-schema": undefined as unknown as ComponentQualificationArtifact,
      }),
    ).toThrow("COMPONENT_QUALIFICATION_INVALID: HeroBanner");
  });

  it("rejects an artifact registered for another component or contract part", () => {
    expect(() =>
      validateComponentQualification("HeroBanner", completeEvidence, {
        ...completeArtifacts,
        "hero-schema": artifact("hero-schema", "accessibility"),
      }),
    ).toThrow("COMPONENT_QUALIFICATION_INVALID: HeroBanner");
  });

  it("requires the exact 375/768/1440 visual regression output", () => {
    expect(() =>
      validateComponentQualification("HeroBanner", completeEvidence, {
        ...completeArtifacts,
        "hero-visual-regression": artifact(
          "hero-visual-regression",
          "visualRegression",
          {
            breakpoints: [390, 768, 1440] as unknown as [375, 768, 1440],
            outputs: visualOutputs,
          },
        ),
      }),
    ).toThrow("COMPONENT_QUALIFICATION_INVALID: HeroBanner");
  });

  it("rejects manually extending the release list without qualification", () => {
    expect(() =>
      assertReleaseQualificationRegistryIntegrity({
        releaseTypes: [...SITE_SPEC_RELEASE_COMPONENT_TYPES, "StatementBlock"],
        qualifications: M1_E_A_COMPONENT_QUALIFICATIONS,
        artifacts: M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
      }),
    ).toThrow("COMPONENT_RELEASE_REGISTRY_INVALID: StatementBlock");
  });

  it("rejects placeholder qualification ids without resolved artifacts", () => {
    expect(() =>
      assertReleaseQualificationRegistryIntegrity({
        releaseTypes: [...SITE_SPEC_RELEASE_COMPONENT_TYPES, "StatementBlock"],
        qualifications: { StatementBlock: completeEvidence },
        artifacts: {},
      }),
    ).toThrow("COMPONENT_QUALIFICATION_INVALID: StatementBlock");
  });

  it("verifies every registered qualification artifact against checked-in bytes", () => {
    const repositoryRoot = resolve(process.cwd(), "../..");
    for (const registered of Object.values(
      M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
    )) {
      const bytes = readFileSync(
        resolve(repositoryRoot, registered.repositoryPath),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        registered.sha256,
      );

      if (registered.part === "fixtures") {
        expect(
          registered.fixtureFiles.map(({ fixtureId }) => fixtureId),
        ).toEqual(registered.fixtureIds);
        for (const fixture of registered.fixtureFiles) {
          const fixtureBytes = readFileSync(
            resolve(repositoryRoot, fixture.repositoryPath),
          );
          expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
            fixture.sha256,
          );
        }
      }

      if (registered.part === "visualRegression") {
        expect(registered.outputs.map(({ breakpoint }) => breakpoint)).toEqual(
          registered.breakpoints,
        );
        for (const output of registered.outputs) {
          const outputBytes = readFileSync(
            resolve(repositoryRoot, output.repositoryPath),
          );
          expect(createHash("sha256").update(outputBytes).digest("hex")).toBe(
            output.sha256,
          );
        }
      }
    }
  });
});
