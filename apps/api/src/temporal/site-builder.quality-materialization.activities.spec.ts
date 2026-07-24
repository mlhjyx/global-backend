import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  designEvaluationV2Digest,
  qualityArtifactSetDigest,
  type DesignEvaluationV2,
  type QualityArtifactSetV1,
} from "@global/contracts";
import type { PrismaService } from "../prisma/prisma.service";
import { buildM1ebGoldenFixtures } from "../site-builder/design/m1eb-golden";
import { releaseSpecDigest } from "../site-builder/release-artifact";
import type { StorageService } from "../site-builder/storage.service";
import {
  createSiteBuilderActivities,
  qualitySettlementIsPublishable,
} from "./site-builder.activities";

let fixture: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number];

beforeAll(async () => {
  fixture = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../", import.meta.url).pathname,
    )
  )[0]!;
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("M1-f approved quality materialization Activity", () => {
  it("accepts only a clean terminal settlement owned by successful finalization", () => {
    const summary = {
      totals: { unknownOperations: 0 },
      budget: {
        paidCallsEnabled: false,
        disabledReason: "run_succeeded",
      },
    } as never;
    const budget = {
      paidCallsEnabled: false,
      disabledReason: "run_succeeded",
    };

    expect(qualitySettlementIsPublishable(summary, budget)).toBe(true);
    expect(
      qualitySettlementIsPublishable(
        {
          ...summary,
          totals: { unknownOperations: 1 },
        },
        budget,
      ),
    ).toBe(false);
    expect(
      qualitySettlementIsPublishable(summary, {
        paidCallsEnabled: false,
        disabledReason: "manual_kill_switch",
      }),
    ).toBe(false);
  });

  it("replays a closed repair after the SiteVersion mutation committed but its Activity acknowledgement was lost", async () => {
    const originalSpec = fixture.spec;
    const repairedSpec = structuredClone(fixture.spec);
    const repairableBlock = repairedSpec.pages
      .flatMap((page) => page.puck.content)
      .find((block) =>
        Object.values(block.props).some(
          (value) => Array.isArray(value) && value.length > 1,
        ),
      );
    const repairableEntry = repairableBlock
      ? Object.entries(repairableBlock.props).find(
          ([, value]) => Array.isArray(value) && value.length > 1,
        )
      : undefined;
    if (!repairableBlock || !repairableEntry) {
      throw new Error("golden fixture has no closed item-count repair");
    }
    repairableBlock.props = {
      ...repairableBlock.props,
      [repairableEntry[0]]: (repairableEntry[1] as unknown[]).slice(0, -1),
    };
    const originalDigest = releaseSpecDigest(originalSpec);
    const repairedDigest = releaseSpecDigest(repairedSpec);
    expect(repairedDigest).not.toBe(originalDigest);

    const applyQualityRepair = vi.fn(
      async (input: {
        identity: { specDigest: string };
        context: { spec: typeof originalSpec };
      }) => {
        expect(input.identity.specDigest).toBe(originalDigest);
        expect(releaseSpecDigest(input.context.spec)).toBe(originalDigest);
        return {
          identity: {
            ...input.identity,
            specDigest: repairedDigest,
            rendererOutputDigest: "e".repeat(64),
          },
          designBrief: fixture.designBrief,
          spec: repairedSpec,
          catalogDigest: "f".repeat(64),
          selectedOptionId: "items:home:section:2",
        };
      },
    );
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
      siteBuildBudget: {
        findUnique: vi.fn(async () => ({ paidCallsEnabled: true })),
      },
      siteBuildSpend: { count: vi.fn(async () => 0) },
      site: {
        findFirst: vi.fn(async () => ({ name: "Acme", slug: "acme" })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: repairedSpec,
          specVersion: "1.1.0",
          buildStatus: "building",
        })),
      },
      sitePublishableClaimSnapshot: {
        findFirst: vi.fn(async () => ({
          workspaceId: "ws-1",
          siteId: "site-1",
          companyProfileId: "company-1",
          buildRunId: "run-1",
          schemaVersion: "site-builder-publishable-claim-snapshot/v1",
          capturedAt: new Date("2026-07-24T00:00:00.000Z"),
          snapshotDigest: "c".repeat(64),
          items: [],
        })),
      },
      asset: { findMany: vi.fn(async () => []) },
    };
    const activities = createSiteBuilderActivities({
      prisma: {
        withWorkspace: vi.fn(
          async (
            _workspaceId: string,
            callback: (transaction: typeof tx) => Promise<unknown>,
          ) => callback(tx),
        ),
      } as unknown as PrismaService,
      qualityCandidateService: { applyQualityRepair } as never,
      closedRepairService: {
        generateCatalog: vi.fn(() => ({
          catalog: {
            options: [{ optionId: "items:home:section:2", rank: 1 }],
          },
        })),
      } as never,
    });
    const candidate = {
      workspaceId: "ws-1",
      siteId: "site-1",
      siteVersionId: "version-1",
      buildRunId: "run-1",
      designBriefDigest: fixture.designBrief.digest,
      specDigest: originalDigest,
      rendererOutputDigest: "d".repeat(64),
      basePath: "/preview/acme",
      siteOrigin: "https://preview.example.test",
      root: "/private/candidate",
    };

    const result = await activities.applyQualityRepair({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      copy: {
        snapshotId: "snapshot-1",
        set: { bundles: {} },
        degradedLocales: [],
        taskAttemptIds: {},
      } as never,
      qualityCandidate: {
        previewSlug: "acme",
        versionId: "version-1",
        designBrief: fixture.designBrief,
        candidateSpec: originalSpec,
        candidate,
      },
      qualityEvaluation: {
        evaluation: { round: 0 },
        artifactSet: { artifactSetDigest: "a".repeat(64) },
      } as never,
    });

    expect(applyQualityRepair).toHaveBeenCalledOnce();
    expect(result.candidate.specDigest).toBe(repairedDigest);
    expect(releaseSpecDigest(result.candidateSpec)).toBe(repairedDigest);
  });

  it("copies only final evidence into the private Release prefix and rebinds v3 digests", async () => {
    const candidateSpecDigest = releaseSpecDigest(fixture.spec);
    const sourceObjects = new Map<string, Buffer>();
    const artifacts = ([375, 768, 1440] as const).map((breakpoint) => {
      const bytes = Buffer.from(`private screenshot ${breakpoint}`);
      const objectKey = `sites/site-1/quality-candidates/run-1/quality/round-0/home-${breakpoint}.png`;
      sourceObjects.set(objectKey, bytes);
      return {
        artifactId: `home-${breakpoint}`,
        objectKey,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        mimeType: "image/png" as const,
        kind: "screenshot" as const,
        target: { locale: "en", pageId: "home", breakpoint },
      };
    });
    const artifactSetDraft = {
      schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
      candidateSpecDigest,
      designBriefDigest: fixture.designBrief.digest,
      round: 0 as const,
      expectedTargets: [{ locale: "en", pageId: "home" }],
      artifacts,
    };
    const artifactSet: QualityArtifactSetV1 = {
      ...artifactSetDraft,
      artifactSetDigest: qualityArtifactSetDigest(artifactSetDraft),
    };
    const evaluation: DesignEvaluationV2 = {
      schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
      candidateSpecDigest,
      designBriefDigest: fixture.designBrief.digest,
      artifactSetDigest: artifactSet.artifactSetDigest,
      round: 0,
      evaluatorVersion: "site-builder-deterministic-quality@1.0.0",
      deterministic: {
        status: "passed",
        hardFailures: [],
        findings: [],
      },
      aesthetic: {
        status: "unavailable",
        overallScore: null,
        dimensions: null,
        unavailableReason: "timeout",
        findings: [],
      },
    };
    const originalEvaluationDigest = designEvaluationV2Digest(
      evaluation,
      artifactSet,
    );
    const releaseObjects = new Map<string, Buffer>();
    const storage = {
      getBufferBounded: vi.fn(async (objectKey: string) => {
        const bytes = sourceObjects.get(objectKey);
        if (!bytes) throw new Error(`missing source ${objectKey}`);
        return bytes;
      }),
      putBufferImmutable: vi.fn(
        async (
          objectKey: string,
          bytes: Buffer,
          _mimeType: string,
          expectedSha256: string,
        ) => {
          expect(sha256(bytes)).toBe(expectedSha256);
          releaseObjects.set(objectKey, Buffer.from(bytes));
          return "created";
        },
      ),
      hashObject: vi.fn(async (objectKey: string) => {
        const bytes = releaseObjects.get(objectKey);
        if (!bytes) throw new Error(`missing release object ${objectKey}`);
        return { sha256: sha256(bytes), size: bytes.length };
      }),
    } as unknown as StorageService;
    let preparedQuality: Awaited<
      ReturnType<
        Parameters<
          Parameters<
            NonNullable<
              Parameters<
                typeof createSiteBuilderActivities
              >[0]["qualityCandidateService"]
            >["materializeApprovedRelease"]
          >[0]["prepareQuality"]
        >
      >
    >;
    const materializeApprovedRelease = vi.fn(
      async (input: {
        prepareQuality: (identity: {
          artifactPrefix: string;
          producerToken: string;
        }) => Promise<unknown>;
      }) => {
        preparedQuality = (await input.prepareQuality({
          artifactPrefix: "sites/site-1/releases/release-1",
          producerToken: "producer-1",
        })) as typeof preparedQuality;
      },
    );
    const prisma = {
      withWorkspace: vi.fn(
        async (
          _workspaceId: string,
          callback: (tx: {
            siteVersion: {
              findUnique: () => Promise<{ spec: typeof fixture.spec }>;
            };
          }) => Promise<unknown>,
        ) =>
          callback({
            siteBuildRun: {
              findUnique: vi.fn(async () => ({ status: "running" })),
            },
            siteBuildBudget: {
              findUnique: vi.fn(async () => ({ paidCallsEnabled: true })),
            },
            siteBuildSpend: {
              count: vi.fn(async () => 0),
            },
            siteVersion: {
              findUnique: vi.fn(async () => ({ spec: fixture.spec })),
            },
          } as never),
      ),
    } as unknown as PrismaService;
    const activities = createSiteBuilderActivities({
      prisma,
      storage,
      qualityCandidateService: {
        materializeApprovedRelease,
      } as never,
    });

    const result = await activities.materializeApprovedRelease({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      qualityCandidate: {
        previewSlug: "acme",
        versionId: "version-1",
        designBrief: fixture.designBrief,
        candidateSpec: fixture.spec,
        candidate: {
          workspaceId: "ws-1",
          siteId: "site-1",
          siteVersionId: "version-1",
          buildRunId: "run-1",
          designBriefDigest: fixture.designBrief.digest,
          specDigest: candidateSpecDigest,
          rendererOutputDigest: "d".repeat(64),
          basePath: "/preview/acme",
          siteOrigin: "https://preview.example.test",
          root: "/private/candidate",
        },
      },
      qualityEvaluation: {
        candidate: {
          workspaceId: "ws-1",
          siteId: "site-1",
          siteVersionId: "version-1",
          buildRunId: "run-1",
          designBriefDigest: fixture.designBrief.digest,
          specDigest: candidateSpecDigest,
          rendererOutputDigest: "d".repeat(64),
          basePath: "/preview/acme",
          siteOrigin: "https://preview.example.test",
          root: "/private/candidate",
        },
        designBrief: fixture.designBrief,
        evaluation,
        designEvaluationDigest: originalEvaluationDigest,
        artifactSet,
        passed: true,
        artifactRefs: {
          schemaVersion: "site-builder-build-step-artifact-refs/v1",
          collectionDigest: "e".repeat(64),
          artifacts: [],
        },
      },
      rounds: [
        {
          round: 0,
          candidateSpecDigest,
          artifactSetDigest: artifactSet.artifactSetDigest,
          designEvaluationDigest: originalEvaluationDigest,
          repairCatalogDigest: null,
          selectedRepairOptionId: null,
          repairSelectionMode: null,
        },
      ],
    });

    expect(materializeApprovedRelease).toHaveBeenCalledOnce();
    expect(preparedQuality).toBeDefined();
    expect(preparedQuality!.manifest.schemaVersion).toBe(
      "site-builder-release-quality/v1",
    );
    expect(preparedQuality!.manifest.status).toBe(
      "passed_deterministic_aesthetic_unavailable",
    );
    expect(preparedQuality!.manifest.artifactSet.artifacts).toHaveLength(4);
    expect(preparedQuality!.manifest.artifactSet.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "aesthetic-unavailable",
          kind: "aesthetic_response",
        }),
      ]),
    );
    expect(preparedQuality!.manifest.artifactSet.artifacts).toSatisfy(
      (refs: Array<{ objectKey: string }>) =>
        refs.every(({ objectKey }) =>
          objectKey.startsWith(
            "sites/site-1/releases/release-1/attempts/producer-1/quality/round-0/",
          ),
        ),
    );
    expect(preparedQuality!.manifest.artifactSet.artifactSetDigest).not.toBe(
      artifactSet.artifactSetDigest,
    );
    expect(preparedQuality!.manifest.designEvaluationDigest).not.toBe(
      originalEvaluationDigest,
    );
    expect(preparedQuality!.manifest.rounds[0]).toMatchObject({
      artifactSetDigest:
        preparedQuality!.manifest.artifactSet.artifactSetDigest,
      designEvaluationDigest: preparedQuality!.manifest.designEvaluationDigest,
    });
    expect(result.artifactRefs.artifacts).toHaveLength(4);
    expect(
      result.artifactRefs.artifacts.every((ref) =>
        ref.objectKey.includes("/releases/release-1/"),
      ),
    ).toBe(true);
    expect([...releaseObjects.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("aesthetic-unavailable-"),
        expect.stringContaining("design-evaluation-"),
      ]),
    );
    expect(
      [...releaseObjects.keys()].some((key) =>
        key.includes("/quality-candidates/"),
      ),
    ).toBe(false);
  });

  it.each([
    {
      condition: "durable budget kill switch closes",
      paidCallsEnabled: false,
      unresolvedSpends: 0,
    },
    {
      condition: "a paid settlement remains unknown",
      paidCallsEnabled: true,
      unresolvedSpends: 1,
    },
  ])(
    "blocks deterministic fallback publication when $condition",
    async ({ paidCallsEnabled, unresolvedSpends }) => {
      const materializeApprovedRelease = vi.fn();
      const prisma = {
        withWorkspace: vi.fn(
          async (
            _workspaceId: string,
            callback: (tx: unknown) => Promise<unknown>,
          ) =>
            callback({
              siteBuildRun: {
                findUnique: vi.fn(async () => ({ status: "running" })),
              },
              siteBuildBudget: {
                findUnique: vi.fn(async () => ({ paidCallsEnabled })),
              },
              siteBuildSpend: {
                count: vi.fn(async () => unresolvedSpends),
              },
            }),
        ),
      } as unknown as PrismaService;
      const activities = createSiteBuilderActivities({
        prisma,
        storage: {} as StorageService,
        qualityCandidateService: {
          materializeApprovedRelease,
        } as never,
      });

      await expect(
        activities.materializeApprovedRelease({
          workspaceId: "ws-1",
          siteId: "site-1",
          buildRunId: "run-1",
          qualityEvaluation: { passed: true },
        } as never),
      ).rejects.toThrow("QUALITY_GATE_FAILED: paid execution gate is closed");
      expect(materializeApprovedRelease).not.toHaveBeenCalled();
    },
  );
});
