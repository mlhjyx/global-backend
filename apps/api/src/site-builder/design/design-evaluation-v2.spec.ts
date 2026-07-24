import {
  DESIGN_EVALUATION_SCHEMA_VERSION,
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  REPAIR_OPTION_CATALOG_SCHEMA_VERSION,
  hasDesignEvaluationHardFailures,
  qualityArtifactSetDigest,
  repairOptionCatalogDigest,
  validateDesignEvaluation,
  validateDesignEvaluationEnvelope,
  validateDesignEvaluationV2,
  validateQualityArtifactSet,
  validateRepairOptionCatalog,
  validateRepairOptionSelection,
  type DesignEvaluationV2,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
  type RepairOptionCatalogV1,
} from "@global/contracts";
import { describe, expect, it } from "vitest";

const SPEC_DIGEST = "1".repeat(64);
const BRIEF_DIGEST = "2".repeat(64);
const DESIGN_CATALOG_DIGEST = "3".repeat(64);

function dimensions(score = 90) {
  return {
    hierarchy: score,
    consistency: score,
    spacing: score,
    contrast: score,
    imagery: score,
    mobileComposition: score,
    ctaClarity: score,
    credibility: score,
    originality: score,
  };
}

function screenshot(breakpoint: 375 | 768 | 1440): QualityArtifactRefV1 {
  return {
    artifactId: `home-en-${breakpoint}`,
    objectKey: `private/quality/run-1/round-0/home-en-${breakpoint}.png`,
    sha256: String(breakpoint % 10).repeat(64),
    sizeBytes: 512_000,
    mimeType: "image/png",
    kind: "screenshot",
    target: { locale: "en", pageId: "home", breakpoint },
  };
}

function artifactSet(
  overrides: Partial<Omit<QualityArtifactSetV1, "artifactSetDigest">> = {},
): QualityArtifactSetV1 {
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: SPEC_DIGEST,
    designBriefDigest: BRIEF_DIGEST,
    round: 0 as const,
    artifacts: [screenshot(375), screenshot(768), screenshot(1440)],
    ...overrides,
  };
  return {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
}

function unavailableEvaluation(
  artifacts: QualityArtifactSetV1,
): DesignEvaluationV2 {
  return {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: SPEC_DIGEST,
    designBriefDigest: BRIEF_DIGEST,
    artifactSetDigest: artifacts.artifactSetDigest,
    round: 0,
    evaluatorVersion: "p4-deterministic@1.0.0",
    deterministic: {
      status: "passed",
      hardFailures: [],
      findings: [],
    },
    aesthetic: {
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason: "rate_limited",
      findings: [],
    },
  };
}

function repairCatalog(): RepairOptionCatalogV1 {
  const draft = {
    schemaVersion: REPAIR_OPTION_CATALOG_SCHEMA_VERSION,
    candidateSpecDigest: SPEC_DIGEST,
    designBriefDigest: BRIEF_DIGEST,
    designCatalogDigest: DESIGN_CATALOG_DIGEST,
    familyId: "industrial-authority",
    round: 0 as const,
    options: [
      {
        optionId: "repair-hero-variant",
        rank: 1,
        addresses: ["AESTHETIC_HIERARCHY"] as const,
        resultSpecDigest: "4".repeat(64),
        change: {
          kind: "approved_variant" as const,
          pageId: "home",
          sectionId: "hero",
          componentType: "HeroSplit",
          variantId: "media-right",
        },
      },
      {
        optionId: "repair-card-count",
        rank: 2,
        addresses: ["GENERICNESS_CARD_DENSITY"] as const,
        resultSpecDigest: "5".repeat(64),
        change: {
          kind: "bounded_item_count" as const,
          pageId: "home",
          sectionId: "products",
          itemCount: 4,
        },
      },
    ],
  };
  return {
    ...draft,
    options: draft.options.map((option) => ({
      ...option,
      addresses: [...option.addresses],
    })),
    catalogDigest: repairOptionCatalogDigest({
      ...draft,
      options: draft.options.map((option) => ({
        ...option,
        addresses: [...option.addresses],
      })),
    }),
  };
}

describe("M1-f DesignEvaluation v2 contracts", () => {
  it("keeps the v1 validator and union reader compatible", () => {
    const value = {
      schemaVersion: DESIGN_EVALUATION_SCHEMA_VERSION,
      overallScore: 91,
      dimensions: dimensions(91),
      hardFailures: [],
      findings: [],
    };
    expect(validateDesignEvaluation(value)).toEqual(value);
    expect(validateDesignEvaluationEnvelope(value)).toEqual(value);
  });

  it("accepts explicit aesthetic unavailability without inventing a score", () => {
    const artifacts = validateQualityArtifactSet(artifactSet());
    const evaluation = validateDesignEvaluationV2(
      unavailableEvaluation(artifacts),
      artifacts,
    );
    expect(evaluation.aesthetic).toMatchObject({
      status: "unavailable",
      overallScore: null,
      unavailableReason: "rate_limited",
    });
    expect(hasDesignEvaluationHardFailures(evaluation)).toBe(false);
    expect(validateDesignEvaluationEnvelope(evaluation)).toEqual(evaluation);
  });

  it("accepts a scored aesthetic pass only at the quality threshold", () => {
    const artifacts = artifactSet();
    const evaluation: DesignEvaluationV2 = {
      ...unavailableEvaluation(artifacts),
      aesthetic: {
        status: "passed",
        overallScore: 85,
        dimensions: dimensions(85),
        unavailableReason: null,
        findings: [],
      },
    };
    expect(validateDesignEvaluationV2(evaluation, artifacts)).toEqual(
      evaluation,
    );
    expect(() =>
      validateDesignEvaluationV2({
        ...evaluation,
        aesthetic: { ...evaluation.aesthetic, overallScore: 84 },
      }),
    ).toThrowError("DESIGN_EVALUATION_V2_INVALID");
  });

  it("accepts a deterministic hard failure only when it is blocker evidence", () => {
    const artifacts = artifactSet({
      artifacts: [
        screenshot(375),
        screenshot(768),
        screenshot(1440),
        {
          artifactId: "axe-home",
          objectKey: "private/quality/run-1/round-0/axe-home.json",
          sha256: "6".repeat(64),
          sizeBytes: 1024,
          mimeType: "application/json",
          kind: "axe_report",
          target: { locale: "en", pageId: "home", breakpoint: 375 },
        },
      ],
    });
    const evaluation: DesignEvaluationV2 = {
      ...unavailableEvaluation(artifacts),
      deterministic: {
        status: "failed",
        hardFailures: [
          {
            source: "deterministic",
            severity: "blocker",
            ruleCode: "AXE_CRITICAL",
            target: { pageId: "home", breakpoint: 375 },
            evidenceRef: { artifactId: "axe-home" },
          },
        ],
        findings: [],
      },
    };
    expect(
      hasDesignEvaluationHardFailures(
        validateDesignEvaluationV2(evaluation, artifacts),
      ),
    ).toBe(true);
  });

  it.each([
    ["suggestedPatch", { op: "replace" }],
    ["props", { headline: "model-authored" }],
    ["css", ".hero { display:none }"],
    ["html", "<script>alert(1)</script>"],
    ["astro", "---"],
    ["path", "/pages/0/puck/content/0"],
  ])("rejects forbidden evaluation finding field %s", (key, forbidden) => {
    const artifacts = artifactSet({
      artifacts: [
        screenshot(375),
        screenshot(768),
        screenshot(1440),
        {
          artifactId: "axe-home",
          objectKey: "private/quality/run-1/round-0/axe-home.json",
          sha256: "6".repeat(64),
          sizeBytes: 1024,
          mimeType: "application/json",
          kind: "axe_report",
          target: { locale: "en", pageId: "home", breakpoint: 375 },
        },
      ],
    });
    const evaluation = unavailableEvaluation(artifacts);
    const finding = {
      source: "deterministic",
      severity: "blocker",
      ruleCode: "AXE_CRITICAL",
      target: { pageId: "home", breakpoint: 375 },
      evidenceRef: { artifactId: "axe-home" },
      [key]: forbidden,
    };
    expect(() =>
      validateDesignEvaluationV2({
        ...evaluation,
        deterministic: {
          status: "failed",
          hardFailures: [finding],
          findings: [],
        },
      }),
    ).toThrowError("DESIGN_EVALUATION_V2_INVALID");
  });

  it("rejects free-text targets, unknown rule codes and dangling evidence", () => {
    const artifacts = artifactSet();
    const evaluation = unavailableEvaluation(artifacts);
    const finding = {
      source: "deterministic",
      severity: "blocker",
      ruleCode: "MODEL_MADE_THIS_UP",
      target: "the ugly bit near the top",
      evidenceRef: { artifactId: "missing" },
    };
    expect(() =>
      validateDesignEvaluationV2({
        ...evaluation,
        deterministic: {
          status: "failed",
          hardFailures: [finding],
          findings: [],
        },
      }),
    ).toThrowError("DESIGN_EVALUATION_V2_INVALID");

    expect(() =>
      validateDesignEvaluationV2({
        ...evaluation,
        deterministic: {
          status: "failed",
          hardFailures: [
            {
              source: "deterministic",
              severity: "blocker",
              ruleCode: "AESTHETIC_HIERARCHY",
              target: { pageId: "home", breakpoint: 375 },
              evidenceRef: { artifactId: "home-en-375" },
            },
          ],
          findings: [],
        },
      }),
    ).toThrowError("DESIGN_EVALUATION_V2_INVALID");

    const validFinding = {
      source: "deterministic",
      severity: "blocker",
      ruleCode: "AXE_CRITICAL",
      target: { pageId: "home", breakpoint: 375 },
      evidenceRef: { artifactId: "missing" },
    };
    expect(() =>
      validateDesignEvaluationV2(
        {
          ...evaluation,
          deterministic: {
            status: "failed",
            hardFailures: [validFinding],
            findings: [],
          },
        },
        artifacts,
      ),
    ).toThrowError("DESIGN_EVALUATION_V2_EVIDENCE_MISMATCH");
  });
});

describe("M1-f bounded quality artifacts", () => {
  it("requires exactly the three approved screenshots for every locale-page", () => {
    expect(validateQualityArtifactSet(artifactSet())).toEqual(artifactSet());
    expect(() =>
      validateQualityArtifactSet(
        artifactSet({ artifacts: [screenshot(375), screenshot(768)] }),
      ),
    ).toThrowError("QUALITY_ARTIFACT_SET");
  });

  it("rejects remote object URLs and screenshots above 2 MiB", () => {
    const remote = screenshot(375);
    remote.objectKey = "https://example.com/screenshot.png";
    expect(() =>
      validateQualityArtifactSet(
        artifactSet({
          artifacts: [remote, screenshot(768), screenshot(1440)],
        }),
      ),
    ).toThrowError("QUALITY_ARTIFACT_SET_INVALID");

    const oversized = screenshot(375);
    oversized.sizeBytes = 2 * 1024 * 1024 + 1;
    expect(() =>
      validateQualityArtifactSet(
        artifactSet({
          artifacts: [oversized, screenshot(768), screenshot(1440)],
        }),
      ),
    ).toThrowError("QUALITY_ARTIFACT_SET_INVALID");
  });
});

describe("M1-f closed repair selection", () => {
  it("accepts only an option id from a digest-bound server catalog", () => {
    const catalog = validateRepairOptionCatalog(repairCatalog());
    expect(
      validateRepairOptionSelection(
        { optionId: "repair-hero-variant" },
        catalog,
      ),
    ).toEqual({ optionId: "repair-hero-variant" });
    expect(() =>
      validateRepairOptionSelection({ optionId: "not-in-catalog" }, catalog),
    ).toThrowError("REPAIR_OPTION_SELECTION_INVALID");
  });

  it.each([
    ["suggestedPatch", [{ op: "replace", path: "/site" }]],
    ["props", { variant: "anything" }],
    ["css", ".hero{}"],
    ["html", "<main />"],
    ["astro", "---"],
    ["path", "/pages/0"],
    ["familyId", "model-selected-family"],
  ])("rejects model selection field %s", (key, forbidden) => {
    const catalog = repairCatalog();
    expect(() =>
      validateRepairOptionSelection(
        { optionId: "repair-hero-variant", [key]: forbidden },
        catalog,
      ),
    ).toThrowError("REPAIR_OPTION_SELECTION_INVALID");
  });

  it.each(["props", "css", "html", "astro", "path", "jsonPatch"])(
    "rejects server catalog change field %s",
    (key) => {
      const catalog = repairCatalog();
      const changed = structuredClone(catalog);
      (changed.options[0].change as unknown as Record<string, unknown>)[key] =
        "forbidden";
      expect(() => validateRepairOptionCatalog(changed)).toThrowError(
        "REPAIR_OPTION_CATALOG_INVALID",
      );
    },
  );

  it("rejects catalog digest tampering and non-contiguous fallback rank", () => {
    const catalog = repairCatalog();
    expect(() =>
      validateRepairOptionCatalog({
        ...catalog,
        candidateSpecDigest: "9".repeat(64),
      }),
    ).toThrowError("REPAIR_OPTION_CATALOG_INVALID");
    expect(() =>
      validateRepairOptionCatalog({
        ...catalog,
        options: catalog.options.map((option, index) => ({
          ...option,
          rank: index + 2,
        })),
      }),
    ).toThrowError("REPAIR_OPTION_CATALOG_INVALID");
  });
});
