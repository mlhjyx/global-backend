import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  type DesignEvaluationV2,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
} from "@global/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM1ebGoldenFixtures } from "./design/m1eb-golden";
import {
  RELEASE_MANIFEST_V2_SCHEMA_VERSION,
  RELEASE_MANIFEST_V3_SCHEMA_VERSION,
  RELEASE_QUALITY_SCHEMA_VERSION,
  buildReleaseArtifact,
  releaseScreenshotSetDigest,
  releaseSpecDigest,
  uploadReleaseArtifact,
  validateReleaseManifest,
  type ReleaseManifestQualityV3,
} from "./release-artifact";

let golden: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number];
let root: string;

const identity = {
  releaseId: "50000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000001",
  siteId: "20000000-0000-4000-8000-000000000001",
  siteVersionId: "40000000-0000-4000-8000-000000000001",
  buildRunId: "30000000-0000-4000-8000-000000000001",
  producerToken: "60000000-0000-4000-8000-000000000001",
  artifactPrefix:
    "sites/20000000-0000-4000-8000-000000000001/releases/50000000-0000-4000-8000-000000000001",
  releaseCreatedAt: new Date("2026-07-24T00:00:00.000Z"),
  buildIdentity: "site-renderer@1.1.0+test",
};

beforeAll(async () => {
  golden = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../", import.meta.url).pathname,
    )
  )[0]!;
  root = await mkdtemp(path.join(tmpdir(), "m1f-release-v3-"));
  await writeFile(path.join(root, "index.html"), "<html></html>");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function screenshot(
  locale: string,
  pageId: string,
  breakpoint: 375 | 768 | 1440,
): QualityArtifactRefV1 {
  return {
    artifactId: `${pageId}-${locale}-${breakpoint}`,
    objectKey: `${identity.artifactPrefix}/attempts/${identity.producerToken}/quality/round-0/${pageId}-${locale}-${breakpoint}.png`,
    sha256: releaseSpecDigest({ locale, pageId, breakpoint }),
    sizeBytes: 512_000,
    mimeType: "image/png",
    kind: "screenshot",
    target: { locale, pageId, breakpoint },
  };
}

function artifactSet(): QualityArtifactSetV1 {
  const expectedTargets = golden.spec.site.locales.flatMap((locale) =>
    golden.spec.pages.map((page) => ({ locale, pageId: page.id })),
  );
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: releaseSpecDigest(golden.spec),
    designBriefDigest: golden.designBrief.digest,
    round: 0 as const,
    expectedTargets,
    artifacts: expectedTargets.flatMap((target) =>
      ([375, 768, 1440] as const).map((breakpoint) =>
        screenshot(target.locale, target.pageId, breakpoint),
      ),
    ),
  };
  return {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
}

function designEvaluation(
  artifacts: QualityArtifactSetV1,
  aestheticStatus: "passed" | "unavailable",
): DesignEvaluationV2 {
  return {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: artifacts.candidateSpecDigest,
    designBriefDigest: artifacts.designBriefDigest,
    artifactSetDigest: artifacts.artifactSetDigest,
    round: artifacts.round,
    evaluatorVersion: "p4-deterministic@1.0.0",
    deterministic: {
      status: "passed",
      hardFailures: [],
      findings: [],
    },
    aesthetic:
      aestheticStatus === "passed"
        ? {
            status: "passed",
            overallScore: 90,
            dimensions: {
              hierarchy: 90,
              consistency: 90,
              spacing: 90,
              contrast: 90,
              imagery: 90,
              mobileComposition: 90,
              ctaClarity: 90,
              credibility: 90,
              originality: 90,
            },
            unavailableReason: null,
            findings: [],
          }
        : {
            status: "unavailable",
            overallScore: null,
            dimensions: null,
            unavailableReason: "rate_limited",
            findings: [],
          },
  };
}

function quality(
  aestheticStatus: "passed" | "unavailable" = "unavailable",
  overrides: Partial<ReleaseManifestQualityV3> = {},
): ReleaseManifestQualityV3 {
  const artifacts = artifactSet();
  const evaluation = designEvaluation(artifacts, aestheticStatus);
  const evaluationRef = {
    objectKey: `${identity.artifactPrefix}/attempts/${identity.producerToken}/quality/round-0/design-evaluation.json`,
    sha256: releaseSpecDigest(evaluation),
    sizeBytes: 2048,
    mimeType: "application/json" as const,
    kind: "design_evaluation" as const,
  };
  return {
    schemaVersion: RELEASE_QUALITY_SCHEMA_VERSION,
    status:
      aestheticStatus === "passed"
        ? "passed"
        : "passed_deterministic_aesthetic_unavailable",
    deterministicEvaluatorVersion: "p4-deterministic@1.0.0",
    finalRound: 0,
    artifactSet: artifacts,
    screenshotSetDigest: releaseScreenshotSetDigest(artifacts),
    designEvaluationDigest: evaluationRef.sha256,
    designEvaluationRef: evaluationRef,
    rounds: [
      {
        round: 0,
        candidateSpecDigest: releaseSpecDigest(golden.spec),
        artifactSetDigest: artifacts.artifactSetDigest,
        designEvaluationDigest: evaluationRef.sha256,
        repairCatalogDigest: null,
        selectedRepairOptionId: null,
        repairSelectionMode: null,
      },
    ],
    aesthetic:
      aestheticStatus === "passed"
        ? {
            status: "passed",
            requestedModel: "gemini-3.5-flash",
            reportedModel: "gemini-3.5-flash",
            resolvedModel: "gemini-3.5-flash",
            transport: "openai.responses",
            routePolicyVersion: "site-builder-aesthetic@target",
            errorClassification: null,
          }
        : {
            status: "unavailable",
            requestedModel: "gemini-3.5-flash",
            reportedModel: null,
            resolvedModel: null,
            transport: "openai.responses",
            routePolicyVersion: "site-builder-aesthetic@target",
            errorClassification: "rate_limited",
          },
    ...overrides,
  };
}

async function build(
  qualitySnapshot?: ReleaseManifestQualityV3,
  evaluationOverride?: DesignEvaluationV2,
) {
  return buildReleaseArtifact({
    root,
    spec: golden.spec,
    storedSpecVersion: golden.spec.specVersion,
    ...identity,
    designBrief: golden.designBrief,
    quality: qualitySnapshot
      ? {
          manifest: qualitySnapshot,
          designEvaluation:
            evaluationOverride ??
            designEvaluation(
              qualitySnapshot.artifactSet,
              qualitySnapshot.aesthetic.status,
            ),
        }
      : undefined,
  });
}

describe("M1-f ReleaseManifest v3 expand/write seam", () => {
  it("keeps the existing writer on v2 when quality is omitted", async () => {
    const release = await build();
    expect(release.manifest.schemaVersion).toBe(
      RELEASE_MANIFEST_V2_SCHEMA_VERSION,
    );
    expect(validateReleaseManifest(release.manifest)).toEqual(release.manifest);
  });

  it("writes and reads v3 only when complete private quality provenance is supplied", async () => {
    const release = await build(quality());
    expect(release.manifest.schemaVersion).toBe(
      RELEASE_MANIFEST_V3_SCHEMA_VERSION,
    );
    expect(validateReleaseManifest(release.manifest)).toEqual(release.manifest);
  });

  it("accepts an evidence-bound passed aesthetic review with exact model provenance", async () => {
    const release = await build(quality("passed"));
    expect(release.manifest.schemaVersion).toBe(
      RELEASE_MANIFEST_V3_SCHEMA_VERSION,
    );
    if (release.manifest.schemaVersion !== RELEASE_MANIFEST_V3_SCHEMA_VERSION) {
      throw new Error("expected v3 fixture");
    }
    expect(release.manifest.quality.status).toBe("passed");
    expect(release.manifest.quality.aesthetic).toMatchObject({
      status: "passed",
      requestedModel: "gemini-3.5-flash",
      reportedModel: "gemini-3.5-flash",
      resolvedModel: "gemini-3.5-flash",
      errorClassification: null,
    });
  });

  it("rejects evidence outside the fenced Release private prefix", async () => {
    const invalid = quality();
    invalid.artifactSet = {
      ...invalid.artifactSet,
      artifacts: invalid.artifactSet.artifacts.map((artifact, index) =>
        index === 0
          ? { ...artifact, objectKey: "private/quality/other-run/a.png" }
          : artifact,
      ),
    };
    invalid.artifactSet.artifactSetDigest = qualityArtifactSetDigest({
      schemaVersion: invalid.artifactSet.schemaVersion,
      candidateSpecDigest: invalid.artifactSet.candidateSpecDigest,
      designBriefDigest: invalid.artifactSet.designBriefDigest,
      round: invalid.artifactSet.round,
      expectedTargets: invalid.artifactSet.expectedTargets,
      artifacts: invalid.artifactSet.artifacts,
    });
    invalid.screenshotSetDigest = releaseScreenshotSetDigest(
      invalid.artifactSet,
    );
    invalid.rounds[0]!.artifactSetDigest =
      invalid.artifactSet.artifactSetDigest;
    await expect(build(invalid)).rejects.toThrow(
      "SITE_RELEASE_QUALITY_INVALID",
    );
  });

  it("does not call an unavailable or mismatched model a passed aesthetic review", async () => {
    const invalid = quality("passed", {
      status: "passed",
      aesthetic: {
        status: "passed",
        requestedModel: "gemini-3.5-flash",
        reportedModel: "stub-fallback",
        resolvedModel: "gemini-3.5-flash",
        transport: "openai.responses",
        routePolicyVersion: "site-builder-aesthetic@target",
        errorClassification: null,
      },
    });
    await expect(build(invalid)).rejects.toThrow(
      "SITE_RELEASE_QUALITY_INVALID",
    );
  });

  it("rejects a DesignEvaluation that is not bound to the final quality artifact set", async () => {
    const snapshot = quality();
    const evaluation = designEvaluation(snapshot.artifactSet, "unavailable");
    evaluation.artifactSetDigest = "f".repeat(64);
    await expect(build(snapshot, evaluation)).rejects.toThrow(
      "SITE_RELEASE_QUALITY_GATE_NOT_PASSED",
    );
  });

  it("forbids repair selection fields on the final passing round", async () => {
    const invalid = quality();
    invalid.rounds[0] = {
      ...invalid.rounds[0]!,
      repairCatalogDigest: "a".repeat(64),
      selectedRepairOptionId: "safe-option",
      repairSelectionMode: "deterministic_fallback",
    };
    await expect(build(invalid)).rejects.toThrow(
      "SITE_RELEASE_QUALITY_INVALID",
    );
  });

  it("verifies every private quality object before the v3 manifest can persist", async () => {
    const release = await build(quality());
    if (release.manifest.schemaVersion !== RELEASE_MANIFEST_V3_SCHEMA_VERSION) {
      throw new Error("expected v3 fixture");
    }
    const stored = new Map<string, Buffer>();
    const privateObjects = new Map(
      [
        ...release.manifest.quality.artifactSet.artifacts.map((artifact) => ({
          objectKey: artifact.objectKey,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        })),
        release.manifest.quality.designEvaluationRef,
      ].map((reference) => [reference.objectKey, reference]),
    );
    const storage = {
      putBufferImmutable: async (key: string, data: Buffer) => {
        stored.set(key, Buffer.from(data));
        return "created" as const;
      },
      hashObject: async (key: string) => {
        const reference = privateObjects.get(key);
        if (reference) {
          return {
            sha256: reference.sha256,
            size: reference.sizeBytes,
            head: Buffer.alloc(0),
          };
        }
        const data = stored.get(key);
        if (!data) throw new Error(`missing ${key}`);
        return {
          sha256: createHash("sha256").update(data).digest("hex"),
          size: data.length,
          head: data.subarray(0, 16),
        };
      },
    };
    await expect(uploadReleaseArtifact(release, storage)).resolves.toBe(
      undefined,
    );

    const firstPrivateKey = privateObjects.keys().next().value as string;
    privateObjects.delete(firstPrivateKey);
    await expect(uploadReleaseArtifact(release, storage)).rejects.toThrow(
      `QUALITY_ARTIFACT_INVALID: ${firstPrivateKey}`,
    );
  });
});
