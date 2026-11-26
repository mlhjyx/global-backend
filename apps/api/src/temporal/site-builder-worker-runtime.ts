import type { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../infra-clients/storage.service";
import type { RouterModelGateway } from "../model-gateway/router-model-gateway";
import type { ExecutionBroker } from "../tools/tool-contract";
import type { RuntimeTelemetry } from "../model-runtime";
import type { SiteBuildCostLedger } from "../site-builder/site-build-cost-ledger";
import type { SiteBuildCostReconciliationResolver } from "../site-builder/site-build-cost-reconciliation-resolver";

export interface SiteBuilderWorkerRuntimeDeps {
  prisma: PrismaService;
  workerOpsDb: PrismaClient;
  costLedger: SiteBuildCostLedger;
  costReconciliationResolver?: SiteBuildCostReconciliationResolver;
  gateway: RouterModelGateway;
  runtimeTelemetry: RuntimeTelemetry;
  broker: ExecutionBroker;
  siteBuilderStorage: StorageService;
  rendererBuildIdentity: string;
}

/**
 * Lazily loads all Site Builder Temporal activities and heavy runtime services
 * (`site-builder.activities.ts`, image pipeline, quality/repair, release
 * maintenance, asset cleanup, KB) only when `SITE_BUILDER_ENABLED=true`.
 *
 * Keeping all dynamic imports in this dedicated loader ensures that when
 * `SITE_BUILDER_ENABLED=false`, the acquisition worker never evaluates
 * `site-builder.activities.ts` (4400+ lines) or image/renderer dependencies.
 */
export async function loadSiteBuilderWorkerActivities(
  deps: SiteBuilderWorkerRuntimeDeps,
): Promise<Record<string, unknown>> {
  const {
    prisma,
    workerOpsDb,
    costLedger,
    costReconciliationResolver,
    gateway,
    runtimeTelemetry,
    broker,
    siteBuilderStorage,
    rendererBuildIdentity,
  } = deps;
  const [
    { createSiteBuilderActivities },
    { createAssetCleanupActivities },
    { createSiteReleaseMaintenanceActivities },
    { DoclingClient },
    { EmbeddingsClient },
    { KbService },
    { ImagePipelineService },
    { IsolatedImagePipelineRunner },
    { SiteReleaseService },
    { StorageQualityArtifactSink },
    { DeterministicQualityService },
    { ClosedRepairService },
    { QualityCandidateService },
    { QualityNarrativeService },
  ] = await Promise.all([
    import("./site-builder.activities"),
    import("./asset-cleanup.activities"),
    import("./site-release-maintenance.activities"),
    import("../infra-clients/docling.client"),
    import("../infra-clients/embeddings.client"),
    import("../site-builder/kb.service"),
    import("../site-builder/image-pipeline.service"),
    import("../site-builder/image-pipeline-runner"),
    import("../site-builder/site-release.service"),
    import("../site-builder/quality/quality-artifact-sink"),
    import("../site-builder/quality/deterministic-quality.service"),
    import("../site-builder/quality/closed-repair.service"),
    import("../site-builder/quality/quality-candidate.service"),
    import("../site-builder/quality/quality-narrative.service"),
  ]);

  const releaseService = new SiteReleaseService(prisma, siteBuilderStorage, {
    buildIdentity: rendererBuildIdentity,
  });
  const closedRepairService = new ClosedRepairService();
  const qualityCandidateService = new QualityCandidateService(
    prisma,
    new DeterministicQualityService(
      new StorageQualityArtifactSink(siteBuilderStorage),
    ),
    closedRepairService,
    releaseService,
  );
  const qualityNarrativeService = new QualityNarrativeService(
    siteBuilderStorage,
  );
  const imagePipeline = new ImagePipelineService(
    prisma,
    siteBuilderStorage,
    new IsolatedImagePipelineRunner(),
  );

  return {
    ...createSiteBuilderActivities({
      prisma,
      costLedger,
      costReconciliationResolver,
      ownerDb: workerOpsDb,
      gateway,
      runtimeTelemetry,
      broker,
      imagePipeline,
      releaseService,
      qualityCandidateService,
      qualityNarrativeService,
      closedRepairService,
      storage: siteBuilderStorage,
      rendererBuildIdentity,
      kb: new KbService(
        prisma,
        new EmbeddingsClient(),
        new DoclingClient(),
        siteBuilderStorage,
      ),
    }),
    ...createAssetCleanupActivities({
      prisma,
      storage: siteBuilderStorage,
    }),
    ...createSiteReleaseMaintenanceActivities({
      ownerDb: workerOpsDb,
      storage: siteBuilderStorage,
    }),
  };
}
