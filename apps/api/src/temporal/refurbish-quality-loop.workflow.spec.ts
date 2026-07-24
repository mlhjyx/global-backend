import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  type DesignEvaluationV2,
  type QualityArtifactSetV1,
} from "@global/contracts";

vi.mock(
  "@temporalio/workflow",
  () => import("./testing/temporal-workflow.mock"),
);

import {
  acts,
  resetActivities,
  setPatched,
} from "./testing/temporal-workflow.mock";
import { refurbishWorkflow } from "./refurbish.workflow";

const INPUT = { workspaceId: "ws-1", siteId: "site-1", buildRunId: "run-1" };
const BRIEF_DIGEST = "b".repeat(64);

function artifactSet(
  round: 0 | 1 | 2 | 3,
  candidateSpecDigest = "a".repeat(64),
): QualityArtifactSetV1 {
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest,
    designBriefDigest: BRIEF_DIGEST,
    round,
    expectedTargets: [{ locale: "en", pageId: "home" }],
    artifacts: ([375, 768, 1440] as const).map((breakpoint) => ({
      artifactId: `screenshot-${breakpoint}`,
      objectKey: `sites/site-1/quality-candidates/run-1/quality/round-${round}/screenshot-${breakpoint}.png`,
      sha256: String(breakpoint).padStart(64, "0"),
      sizeBytes: 10,
      mimeType: "image/png" as const,
      kind: "screenshot" as const,
      target: { locale: "en", pageId: "home", breakpoint },
    })),
  };
  return {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
}

function evaluation(
  round: 0 | 1 | 2 | 3,
  passed: boolean,
  candidateSpecDigest = "a".repeat(64),
): {
  evaluation: DesignEvaluationV2;
  artifactSet: QualityArtifactSetV1;
  designEvaluationDigest: string;
} {
  const artifacts = artifactSet(round, candidateSpecDigest);
  const failure = {
    source: "deterministic" as const,
    severity: "blocker" as const,
    ruleCode: "HORIZONTAL_OVERFLOW" as const,
    target: { locale: "en", pageId: "home", breakpoint: 375 as const },
    evidenceRef: { artifactId: "screenshot-375" },
  };
  return {
    artifactSet: artifacts,
    designEvaluationDigest: "f".repeat(64),
    evaluation: {
      schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
      candidateSpecDigest,
      designBriefDigest: BRIEF_DIGEST,
      artifactSetDigest: artifacts.artifactSetDigest,
      round,
      evaluatorVersion: "site-builder-deterministic-quality@1.0.0",
      deterministic: {
        status: passed ? "passed" : "failed",
        hardFailures: passed ? [] : [failure],
        findings: [],
      },
      aesthetic: {
        status: "unavailable",
        overallScore: null,
        dimensions: null,
        unavailableReason: "timeout",
        findings: [],
      },
    },
  };
}

function candidate(specDigest = "a".repeat(64), round = 0) {
  return {
    previewSlug: "acme-abc123",
    versionId: "ver-1",
    designBrief: { digest: BRIEF_DIGEST },
    candidate: {
      workspaceId: "ws-1",
      siteId: "site-1",
      siteVersionId: "ver-1",
      buildRunId: "run-1",
      specDigest,
      designBriefDigest: BRIEF_DIGEST,
      rendererOutputDigest: String(round + 1)
        .repeat(64)
        .slice(0, 64),
      basePath: "/preview/acme-abc123/",
      siteOrigin: "http://localhost:3000",
      root: "/tmp/quality-candidate",
    },
  };
}

type CandidateSummary = ReturnType<typeof candidate>;
type EvaluationActivityInput = {
  round: 0 | 1 | 2 | 3;
  qualityCandidate: CandidateSummary;
};
type RepairActivityInput = {
  qualityCandidate: CandidateSummary;
  qualityEvaluation: ReturnType<typeof evaluation>;
};

function artifactRefs() {
  return {
    schemaVersion: "site-builder-step-artifact-refs/v1",
    collectionDigest: "c".repeat(64),
    artifacts: [
      {
        artifactId: "screenshot-375",
        objectKey: "sites/site-1/releases/release-1/quality/screenshot.png",
        sha256: "d".repeat(64),
        sizeBytes: 10,
        mimeType: "image/png",
        kind: "screenshot",
      },
    ],
  };
}

function primeQualityPath(): void {
  setPatched(() => true);
  acts.beginRefurbishRun.mockResolvedValue(undefined);
  acts.ingestPendingKb.mockResolvedValue({ processed: 0, failed: 0 });
  acts.buildBrandProfile.mockResolvedValue({
    version: 1,
    factCount: 1,
    gapsCount: 0,
    researchDegraded: false,
    model: "gpt-5.6-terra",
  });
  acts.listImages.mockResolvedValue({ assetIds: [], truncated: false });
  acts.generateDesignBrief.mockResolvedValue({
    source: "generated",
    designBrief: { digest: BRIEF_DIGEST },
    taskAttemptId: "attempt-design",
  });
  acts.generateCopyBundles.mockResolvedValue({
    snapshotId: "snapshot-1",
    set: {
      schemaVersion: "site-builder-copy-bundle-set/v1",
      sourceLocale: "en",
      bundles: {},
    },
    degradedLocales: [],
    taskAttemptIds: {},
  });
  acts.assembleQualityCandidate.mockResolvedValue(candidate());
  acts.materializeApprovedRelease.mockResolvedValue({
    build: {
      previewSlug: "acme-abc123",
      versionId: "ver-1",
      designBrief: { digest: BRIEF_DIGEST },
    },
    artifactRefs: artifactRefs(),
  });
  acts.finalizeRefurbish.mockResolvedValue({
    previewSlug: "acme-abc123",
  });
  acts.compensateRefurbish.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetActivities();
  primeQualityPath();
});

describe("refurbishWorkflow M1-f patch", () => {
  it("round 0 通过后才 materialize v3，并显式记录 aesthetic unavailable", async () => {
    const round0 = evaluation(0, true);
    acts.evaluateQualityCandidate.mockResolvedValue({
      ...candidate(),
      ...round0,
      passed: true,
      artifactRefs: artifactRefs(),
    });

    await expect(refurbishWorkflow(INPUT)).resolves.toEqual({
      previewSlug: "acme-abc123",
    });

    expect(acts.assembleAndBuild).not.toHaveBeenCalled();
    expect(acts.assembleQualityCandidate).toHaveBeenCalledTimes(1);
    expect(acts.evaluateQualityCandidate).toHaveBeenCalledTimes(1);
    expect(acts.applyQualityRepair).not.toHaveBeenCalled();
    expect(acts.materializeApprovedRelease).toHaveBeenCalledTimes(1);
    expect(
      acts.assembleQualityCandidate.mock.invocationCallOrder[0],
    ).toBeLessThan(acts.evaluateQualityCandidate.mock.invocationCallOrder[0]);
    expect(
      acts.evaluateQualityCandidate.mock.invocationCallOrder[0],
    ).toBeLessThan(acts.materializeApprovedRelease.mock.invocationCallOrder[0]);
    expect(acts.finalizeRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityV1: true,
        designBrief: expect.objectContaining({
          designBrief: { digest: BRIEF_DIGEST },
        }),
      }),
    );
    expect(acts.recordRefurbishProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "quality_loop",
        itemKey: "round-0",
        attempt: 1,
        status: "degraded",
        phase: "P4_quality",
        errorCode: "AESTHETIC_MODEL_UNAVAILABLE",
        artifactRefs: artifactRefs(),
      }),
    );
  });

  it("最多三次封闭修复，round 3 通过后 provenance 完整", async () => {
    acts.evaluateQualityCandidate.mockImplementation(
      async ({ round, qualityCandidate }: EvaluationActivityInput) => ({
        ...qualityCandidate,
        ...evaluation(
          round,
          round === 3,
          qualityCandidate.candidate.specDigest,
        ),
        passed: round === 3,
        artifactRefs: artifactRefs(),
      }),
    );
    acts.applyQualityRepair.mockImplementation(
      async ({ qualityCandidate, qualityEvaluation }: RepairActivityInput) => {
        const nextRound = qualityEvaluation.evaluation.round + 1;
        return {
          ...candidate(
            String(nextRound + 1)
              .repeat(64)
              .slice(0, 64),
            nextRound,
          ),
          previewSlug: qualityCandidate.previewSlug,
          versionId: qualityCandidate.versionId,
          repairCatalogDigest: String(nextRound).padStart(64, "e"),
          selectedRepairOptionId: `blueprint:home:safe-${nextRound}`,
          repairSelectionMode: "deterministic_fallback",
        };
      },
    );

    await refurbishWorkflow(INPUT);

    expect(acts.evaluateQualityCandidate).toHaveBeenCalledTimes(4);
    expect(acts.applyQualityRepair).toHaveBeenCalledTimes(3);
    const materializeInput = acts.materializeApprovedRelease.mock.calls[0][0];
    expect(materializeInput.rounds).toHaveLength(4);
    expect(materializeInput.rounds.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 0,
          repairSelectionMode: "deterministic_fallback",
        }),
        expect.objectContaining({
          round: 1,
          repairSelectionMode: "deterministic_fallback",
        }),
        expect.objectContaining({
          round: 2,
          repairSelectionMode: "deterministic_fallback",
        }),
      ]),
    );
    expect(materializeInput.rounds[3]).toMatchObject({
      round: 3,
      repairCatalogDigest: null,
      selectedRepairOptionId: null,
      repairSelectionMode: null,
    });
  });

  it("round 3 仍失败时不创建 Release、不 finalize，旧站由补偿保留", async () => {
    acts.evaluateQualityCandidate.mockImplementation(
      async ({ round, qualityCandidate }: EvaluationActivityInput) => ({
        ...qualityCandidate,
        ...evaluation(round, false, qualityCandidate.candidate.specDigest),
        passed: false,
        artifactRefs: artifactRefs(),
      }),
    );
    acts.applyQualityRepair.mockImplementation(
      async ({ qualityCandidate, qualityEvaluation }: RepairActivityInput) => {
        const nextRound = qualityEvaluation.evaluation.round + 1;
        return {
          ...candidate(
            String(nextRound + 1)
              .repeat(64)
              .slice(0, 64),
            nextRound,
          ),
          previewSlug: qualityCandidate.previewSlug,
          versionId: qualityCandidate.versionId,
          repairCatalogDigest: String(nextRound).padStart(64, "e"),
          selectedRepairOptionId: `blueprint:home:safe-${nextRound}`,
          repairSelectionMode: "deterministic_fallback",
        };
      },
    );

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow(
      "QUALITY_GATE_FAILED",
    );

    expect(acts.materializeApprovedRelease).not.toHaveBeenCalled();
    expect(acts.finalizeRefurbish).not.toHaveBeenCalled();
    expect(acts.compensateRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: "failed",
        qualityV1: true,
      }),
    );
  });

  it("materialize ACK/错误未知不会退回确定性发布", async () => {
    const round0 = evaluation(0, true);
    acts.evaluateQualityCandidate.mockResolvedValue({
      ...candidate(),
      ...round0,
      passed: true,
      artifactRefs: artifactRefs(),
    });
    acts.materializeApprovedRelease.mockRejectedValue(
      new Error("settlement unknown"),
    );

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow(
      "settlement unknown",
    );

    expect(acts.finalizeRefurbish).not.toHaveBeenCalled();
    expect(acts.compensateRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({ qualityV1: true }),
    );
  });
});
