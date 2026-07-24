import { describe, expect, it } from "vitest";
import {
  BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION,
  buildStepArtifactRefsDigest,
  validateBuildStepArtifactRefs,
  type BuildStepArtifactRefV1,
} from "./build-step-artifact-refs";

function screenshot(
  overrides: Partial<BuildStepArtifactRefV1> = {},
): BuildStepArtifactRefV1 {
  return {
    artifactId: "home-en-375",
    objectKey: "private/quality/run-1/round-0/home-en-375.png",
    sha256: "a".repeat(64),
    sizeBytes: 512_000,
    mimeType: "image/png",
    kind: "screenshot",
    ...overrides,
  };
}

function artifactRefs(artifacts: BuildStepArtifactRefV1[] = [screenshot()]) {
  return {
    schemaVersion: BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION,
    collectionDigest: buildStepArtifactRefsDigest(artifacts),
    artifacts,
  };
}

describe("M1-f bounded SiteBuildStep artifact refs", () => {
  it("accepts digest-bound private object metadata without object contents", () => {
    expect(validateBuildStepArtifactRefs(artifactRefs())).toEqual(
      artifactRefs(),
    );
  });

  it("rejects remote URLs, digest tampering and duplicate object keys", () => {
    expect(() =>
      validateBuildStepArtifactRefs(
        artifactRefs([screenshot({ objectKey: "https://example.com/a.png" })]),
      ),
    ).toThrowError("QUALITY_ARTIFACT_INVALID");
    expect(() =>
      validateBuildStepArtifactRefs({
        ...artifactRefs(),
        collectionDigest: "b".repeat(64),
      }),
    ).toThrowError("QUALITY_ARTIFACT_INVALID");
    expect(() =>
      validateBuildStepArtifactRefs(
        artifactRefs([screenshot(), screenshot({ artifactId: "home-en-768" })]),
      ),
    ).toThrowError("QUALITY_ARTIFACT_INVALID");
  });

  it("enforces screenshot and total evidence size bounds", () => {
    expect(() =>
      validateBuildStepArtifactRefs(
        artifactRefs([screenshot({ sizeBytes: 2 * 1024 * 1024 + 1 })]),
      ),
    ).toThrowError("QUALITY_ARTIFACT_INVALID");
  });
});
