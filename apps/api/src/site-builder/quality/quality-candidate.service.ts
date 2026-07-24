import { Prisma } from "@prisma/client";
import {
  validateDesignBriefV2,
  validateSiteSpecV1_1,
  type DesignBriefV2,
  type RepairOptionSelectionV1,
  type SiteSpecV1_1,
} from "@global/contracts";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  releaseSpecDigest,
  type BuildReleaseQualityInputV3,
} from "../release-artifact";
import {
  assertRendererOutputMatches,
  type RendererOutputManifestV1,
} from "../renderer-build";
import {
  type MaterializeSiteReleaseInput,
  type MaterializedSiteRelease,
  type SiteReleaseCandidateFence,
  type SiteReleaseMaterializationIdentity,
  type SiteReleaseService,
} from "../site-release.service";
import {
  ClosedRepairService,
  type ClosedRepairContext,
} from "./closed-repair.service";
import {
  DeterministicQualityService,
  type RunDeterministicQualityInput,
} from "./deterministic-quality.service";
import type { DeterministicQualityResult } from "./deterministic-quality";

export interface QualityCandidateIdentity extends SiteReleaseCandidateFence {
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  designBriefDigest: string;
  root: string;
}

export interface PreparedQualityRepair {
  root: string;
  manifest: RendererOutputManifestV1;
  /** Atomically replaces the run-scoped canonical staging directory. */
  promote(): Promise<void>;
  cleanup(): Promise<void>;
}

type QualityEvaluationInput = Omit<
  RunDeterministicQualityInput,
  | "spec"
  | "buildRoot"
  | "basePath"
  | "siteOrigin"
  | "rendererOutputDigest"
  | "candidateSpecDigest"
  | "designBriefDigest"
>;

/**
 * M1-f service boundary. Temporal may replay calls to these methods, but it
 * never receives a mutable SiteSpec surface: candidate changes are selected
 * from ClosedRepairService and committed under the release build fence.
 */
export class QualityCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deterministicQuality: DeterministicQualityService,
    private readonly repairs: ClosedRepairService,
    private readonly releases: Pick<
      SiteReleaseService,
      "reserveMaterialization" | "materialize"
    >,
  ) {}

  private async loadPersistedCandidate(
    input: Pick<
      QualityCandidateIdentity,
      "workspaceId" | "siteId" | "siteVersionId" | "buildRunId"
    >,
    options: { allowReadyReplay?: boolean } = {},
  ): Promise<{
    spec: SiteSpecV1_1;
    specDigest: string;
    specVersion: string;
    readyReplay: boolean;
  }> {
    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-build-${input.buildRunId}`}))`;
      const [run, version, release] = await Promise.all([
        tx.siteBuildRun.findUnique({
          where: { id: input.buildRunId },
          select: { status: true },
        }),
        tx.siteVersion.findUnique({
          where: { id: input.siteVersionId },
          select: {
            workspaceId: true,
            siteId: true,
            buildRunId: true,
            buildStatus: true,
            spec: true,
            specVersion: true,
          },
        }),
        options.allowReadyReplay
          ? tx.siteRelease.findUnique({
              where: { buildRunId: input.buildRunId },
              select: { status: true },
            })
          : Promise.resolve(null),
      ]);
      const readyReplay =
        options.allowReadyReplay === true &&
        version?.buildStatus === "succeeded" &&
        release?.status === "ready";
      if (
        run?.status !== "running" ||
        !version ||
        version.workspaceId !== input.workspaceId ||
        version.siteId !== input.siteId ||
        version.buildRunId !== input.buildRunId ||
        (version.buildStatus !== "building" && !readyReplay) ||
        version.specVersion !== "1.1.0"
      ) {
        throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
      }
      const spec = validateSiteSpecV1_1(version.spec);
      return {
        spec,
        specDigest: releaseSpecDigest(spec),
        specVersion: version.specVersion,
        readyReplay,
      };
    });
  }

  async assembleQualityCandidate(input: {
    identity: QualityCandidateIdentity;
    designBrief: DesignBriefV2;
  }): Promise<SiteSpecV1_1> {
    const brief = validateDesignBriefV2(input.designBrief);
    const persisted = await this.loadPersistedCandidate(input.identity);
    if (
      persisted.specDigest !== input.identity.specDigest ||
      brief.digest !== input.identity.designBriefDigest
    ) {
      throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
    }
    await assertRendererOutputMatches({
      root: input.identity.root,
      candidateSpecDigest: input.identity.specDigest,
      basePath: input.identity.basePath,
      siteOrigin: input.identity.siteOrigin,
      treeDigest: input.identity.rendererOutputDigest,
    });
    return persisted.spec;
  }

  async evaluateQualityCandidate(input: {
    identity: QualityCandidateIdentity;
    designBrief: DesignBriefV2;
    quality: QualityEvaluationInput;
  }): Promise<DeterministicQualityResult> {
    const spec = await this.assembleQualityCandidate(input);
    const result = await this.deterministicQuality.evaluate({
      ...input.quality,
      spec,
      buildRoot: input.identity.root,
      basePath: input.identity.basePath,
      siteOrigin: input.identity.siteOrigin,
      rendererOutputDigest: input.identity.rendererOutputDigest,
      candidateSpecDigest: input.identity.specDigest,
      designBriefDigest: input.identity.designBriefDigest,
    });
    // Evaluation may take minutes. Re-read the database and tree so a stale
    // result can never be consumed by repair or materialization.
    await this.assembleQualityCandidate(input);
    return result;
  }

  async applyQualityRepair(input: {
    identity: QualityCandidateIdentity;
    context: ClosedRepairContext;
    evaluation: Parameters<
      ClosedRepairService["generateCatalog"]
    >[0]["evaluation"];
    artifactSet: Parameters<
      ClosedRepairService["generateCatalog"]
    >[0]["artifactSet"];
    selection: RepairOptionSelectionV1;
    render(candidate: {
      spec: SiteSpecV1_1;
      designBrief: DesignBriefV2;
      replayingCommittedResult: boolean;
    }): Promise<PreparedQualityRepair>;
  }): Promise<{
    identity: QualityCandidateIdentity;
    designBrief: DesignBriefV2;
    spec: SiteSpecV1_1;
    catalogDigest: string;
    selectedOptionId: string;
  }> {
    if (
      releaseSpecDigest(input.context.spec) !== input.identity.specDigest ||
      input.context.brief.digest !== input.identity.designBriefDigest
    ) {
      throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
    }
    const persisted = await this.loadPersistedCandidate(input.identity);
    const replayingCommittedResult =
      persisted.specDigest !== input.identity.specDigest;
    if (!replayingCommittedResult) {
      await assertRendererOutputMatches({
        root: input.identity.root,
        candidateSpecDigest: input.identity.specDigest,
        basePath: input.identity.basePath,
        siteOrigin: input.identity.siteOrigin,
        treeDigest: input.identity.rendererOutputDigest,
      });
    }
    const generated = this.repairs.generateCatalog({
      context: input.context,
      evaluation: input.evaluation,
      artifactSet: input.artifactSet,
    });
    const candidate = this.repairs.applySelection({
      generated,
      selection: input.selection,
      expectedArtifactSetDigest: input.artifactSet.artifactSetDigest,
    });
    const resultDigest = releaseSpecDigest(candidate.spec);
    if (
      replayingCommittedResult &&
      persisted.specDigest !== resultDigest
    ) {
      throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
    }
    const prepared = await input.render({
      spec: candidate.spec,
      designBrief: candidate.designBrief,
      replayingCommittedResult,
    });
    try {
      await assertRendererOutputMatches({
        root: prepared.root,
        candidateSpecDigest: resultDigest,
        basePath: input.identity.basePath,
        siteOrigin: input.identity.siteOrigin,
        treeDigest: prepared.manifest.treeDigest,
      });
      await this.prisma.withWorkspace(
        input.identity.workspaceId,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-build-${input.identity.buildRunId}`}))`;
          const [run, version, release] = await Promise.all([
            tx.siteBuildRun.findUnique({
              where: { id: input.identity.buildRunId },
              select: { status: true },
            }),
            tx.siteVersion.findUnique({
              where: { id: input.identity.siteVersionId },
              select: {
                workspaceId: true,
                siteId: true,
                buildRunId: true,
                buildStatus: true,
                spec: true,
              },
            }),
            tx.siteRelease.findUnique({
              where: { buildRunId: input.identity.buildRunId },
              select: { id: true },
            }),
          ]);
          if (
            run?.status !== "running" ||
            release ||
            !version ||
            version.workspaceId !== input.identity.workspaceId ||
            version.siteId !== input.identity.siteId ||
            version.buildRunId !== input.identity.buildRunId ||
            version.buildStatus !== "building"
          ) {
            throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
          }
          const currentDigest = releaseSpecDigest(version.spec);
          if (
            currentDigest !== input.identity.specDigest &&
            currentDigest !== resultDigest
          ) {
            throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
          }
          if (currentDigest !== resultDigest) {
            const updated = await tx.siteVersion.updateMany({
              where: {
                id: input.identity.siteVersionId,
                buildRunId: input.identity.buildRunId,
                buildStatus: "building",
              },
              data: {
                spec: candidate.spec as unknown as Prisma.InputJsonValue,
              },
            });
            if (updated.count !== 1) {
              throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
            }
          }
        },
      );
      // A failed promotion is replayable: the database already contains the
      // selected digest, and a retry may re-render and promote the same option.
      await prepared.promote();
      await assertRendererOutputMatches({
        root: input.identity.root,
        candidateSpecDigest: resultDigest,
        basePath: input.identity.basePath,
        siteOrigin: input.identity.siteOrigin,
        treeDigest: prepared.manifest.treeDigest,
      });
      return {
        identity: {
          ...input.identity,
          specDigest: resultDigest,
          rendererOutputDigest: prepared.manifest.treeDigest,
          designBriefDigest: candidate.designBrief.digest,
        },
        designBrief: candidate.designBrief,
        spec: candidate.spec,
        catalogDigest: generated.catalog.catalogDigest,
        selectedOptionId: input.selection.optionId,
      };
    } finally {
      await prepared.cleanup();
    }
  }

  async materializeApprovedRelease(
    input: Omit<
      MaterializeSiteReleaseInput,
      "releaseIdentity" | "quality" | "candidateFence"
    > & {
      candidate: QualityCandidateIdentity;
      prepareQuality(
        identity: SiteReleaseMaterializationIdentity,
      ): Promise<BuildReleaseQualityInputV3>;
    },
  ): Promise<MaterializedSiteRelease> {
    const { candidate, prepareQuality, ...materializeInput } = input;
    const brief = validateDesignBriefV2(materializeInput.designBrief);
    const persisted = await this.loadPersistedCandidate(candidate, {
      allowReadyReplay: true,
    });
    if (
      persisted.specDigest !== candidate.specDigest ||
      brief.digest !== candidate.designBriefDigest
    ) {
      throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
    }
    if (!persisted.readyReplay) {
      await assertRendererOutputMatches({
        root: candidate.root,
        candidateSpecDigest: candidate.specDigest,
        basePath: candidate.basePath,
        siteOrigin: candidate.siteOrigin,
        treeDigest: candidate.rendererOutputDigest,
      });
    }
    const spec = persisted.spec;
    if (releaseSpecDigest(materializeInput.spec) !== releaseSpecDigest(spec)) {
      throw new Error("QUALITY_CANDIDATE_FENCE_LOST");
    }
    const releaseIdentity = await this.releases.reserveMaterialization({
      ...materializeInput,
      expectedSpecDigest: candidate.specDigest,
    });
    const quality = await prepareQuality(releaseIdentity);
    return this.releases.materialize({
      ...materializeInput,
      spec,
      quality,
      releaseIdentity,
      candidateFence: candidate,
      expectedSpecDigest: candidate.specDigest,
    });
  }
}
