import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  type DesignEvaluationV2,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
} from "@global/contracts";
import { createHash } from "node:crypto";

const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export function qualityNarrativeFixture(): {
  artifactSet: QualityArtifactSetV1;
  evaluation: DesignEvaluationV2;
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();
  const target = { locale: "en", pageId: "home" };
  const artifacts: QualityArtifactRefV1[] = [375, 768, 1440].map(
    (breakpoint) => {
      const bytes = Buffer.from(`png-${breakpoint}`);
      const objectKey = `private/quality/screenshot-${breakpoint}.png`;
      objects.set(objectKey, bytes);
      return {
        artifactId: `screenshot-${breakpoint}`,
        objectKey,
        sha256: sha(bytes),
        sizeBytes: bytes.length,
        mimeType: "image/png",
        kind: "screenshot",
        target: {
          ...target,
          breakpoint: breakpoint as 375 | 768 | 1440,
        },
      };
    },
  );
  const seoBytes = Buffer.from(
    JSON.stringify({
      target,
      h1Count: 2,
      canonical: null,
      hreflangs: [],
      robots: "index, follow",
      robotsTxtOk: false,
      sitemapOk: false,
      jsonLdValid: false,
      jsonLdUnsupportedFacts: true,
    }),
  );
  const seoKey = "private/quality/seo-home.json";
  objects.set(seoKey, seoBytes);
  artifacts.push({
    artifactId: "seo-home",
    objectKey: seoKey,
    sha256: sha(seoBytes),
    sizeBytes: seoBytes.length,
    mimeType: "application/json",
    kind: "seo_report",
    target,
  });
  const deterministicBytes = Buffer.from(
    JSON.stringify({ externalRequests: ["https://outside.invalid"] }),
  );
  const deterministicKey = "private/quality/deterministic-home.json";
  objects.set(deterministicKey, deterministicBytes);
  artifacts.push({
    artifactId: "deterministic-home",
    objectKey: deterministicKey,
    sha256: sha(deterministicBytes),
    sizeBytes: deterministicBytes.length,
    mimeType: "application/json",
    kind: "deterministic_evaluation",
    target,
  });
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: "a".repeat(64),
    designBriefDigest: "b".repeat(64),
    round: 0 as const,
    expectedTargets: [target],
    artifacts,
  };
  const artifactSet: QualityArtifactSetV1 = {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
  const evaluation: DesignEvaluationV2 = {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: draft.candidateSpecDigest,
    designBriefDigest: draft.designBriefDigest,
    artifactSetDigest: artifactSet.artifactSetDigest,
    round: 0,
    evaluatorVersion: "quality-narrative-test@1",
    deterministic: {
      status: "failed",
      hardFailures: [
        {
          source: "deterministic",
          severity: "blocker",
          ruleCode: "H1_COUNT_INVALID",
          target,
          evidenceRef: { artifactId: "seo-home" },
        },
        {
          source: "deterministic",
          severity: "blocker",
          ruleCode: "OUTBOUND_REQUEST_FORBIDDEN",
          target,
          evidenceRef: { artifactId: "deterministic-home" },
        },
      ],
      findings: [],
    },
    aesthetic: {
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason: "model_not_listed",
      findings: [],
    },
  };
  return { artifactSet, evaluation, objects };
}
