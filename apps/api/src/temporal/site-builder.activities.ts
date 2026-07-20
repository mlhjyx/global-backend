import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Context as ActivityContext } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import {
  buildDemoSpec,
  collectTextKeys,
  DEMO_SPEC_VERSION,
  DemoCopyPolish,
  sanitizePolish,
} from '../site-builder/demo-spec';
import type { IntakeInput } from '../site-builder/intake.service';
import type { KbService } from '../site-builder/kb.service';
import type { BuildScopeInput } from '../site-builder/refurbish-launcher';
import type {
  ImagePipelineService,
  SiteImagePipelineSummary,
} from '../site-builder/image-pipeline.service';
import { allocateNextSiteVersion } from '../site-builder/version-alloc';
import {
  runAiTask,
  type AiTaskRunResult,
} from '../site-builder/agents/ai-task';
import {
  BRAND_PROFILE_TASK,
  BrandProfileOutput,
  enforceEvidenceGateV2,
  GapItem,
  PromptEvidenceSource,
  sanitizeBrandProfilePersistenceOutput,
  sanitizeProfileForPrompt,
} from '../site-builder/agents/brand-profile';
import {
  researchBrand,
  ResearchSource,
} from '../site-builder/agents/brand-research';
import { prepareBrandEvidenceSources } from '../site-builder/agents/brand-evidence';
import {
  evidenceSourceDedupeKey,
  type FrozenEvidenceSource,
} from '../site-builder/agents/evidence-ref';
import { buildSiteSpecWithTemporaryFile } from '../site-builder/renderer-build';
import {
  preparePreviewPromotion,
  type PreviewPromotion,
} from '../site-builder/preview-promotion';
import { lockSiteSpecAssetsForActivation } from '../site-builder/asset-reference-gate';
import { applyBuildScope } from '../site-builder/build-scope';
import {
  copyBundleToLegacyStrings,
  type CopyBundleSetV1,
  type CopySlotType,
  type SiteSpec,
} from '@global/contracts';
import {
  BuildProgressEvent,
  recordBuildProgress,
  terminalizeBuildProgress,
} from '../site-builder/build-progress';
import type { NormalizedBuildRequest } from '../site-builder/build-request-contract';
import type { ExecutionBroker } from '../tools/tool-contract';
import { budgetLedger, siteBuildBudgetCents } from '../tools/budget';
import {
  claimEvidenceOriginKey,
  claimOriginIdentity,
  ClaimEvidenceBridgeService,
} from '../site-builder/claim-evidence-bridge.service';
import {
  claimTypeForBrandFact,
  PrismaClaimEvidenceBridgeRepository,
} from '../site-builder/claim-evidence-bridge.prisma';
import { compareClaimProjectionOrder } from '../site-builder/claim-projection-order';
import { gateCertificationFactsForPersistence } from '../site-builder/claim-evidence-persistence-gate';
import {
  PaidOperationUnknownError,
  SiteBuildCostLedger,
} from '../site-builder/site-build-cost-ledger';
import {
  CopyBundleService,
  neutralCopySlotContent,
  type CopySlotDefinition,
  type CopySlotGenerator,
} from '../site-builder/copy-bundle.service';
import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from '../site-builder/agents/copy';
import { PublishableClaimSnapshotService } from '../site-builder/publishable-claim-snapshot.service';
import { PrismaPublishableClaimSnapshotRepository } from '../site-builder/publishable-claim-snapshot.prisma';
import { assertReleaseContract } from '../site-builder/release-artifact';
import type { SiteReleaseService } from '../site-builder/site-release.service';

/** refurbish 六步键序（begin/finalize 写 steps 的权威顺序；compensate 回填复用）。 */
const REFURBISH_STEP_KEYS = [
  'kb_ingest',
  'brand_profile',
  'image_pipeline',
  'copy',
  'assemble_build',
  'quality_loop',
] as const;

/**
 * 补偿路径 steps 回填（改动 3，观测性）：run 转 failed 时给出「哪些步骤跑过/中止」。
 * 只报**DB 可核验的完成位**——没有活动在 run 中途把 done/degraded 写进 siteBuildRun.steps
 * （begin 全写 pending、只有 finalize 写终态），故不再臆测「原样保留」不存在的完成态。
 * - brand_profile：由 compensate 按 brandProfile 行探测传入 done/aborted（无 buildRunId 列，
 *   靠 createdAt>=startedAt 归属）；
 * - assemble_build：由 compensate 按 siteVersion(buildRunId, succeeded) 行探测传入 done/aborted
 *   （buildRunId 唯一定位本 run 的成功版本，无需 startedAt）；
 * - 其余步骤：DB 无从核验完成，一律 aborted；
 * - 键序恒为 REFURBISH_STEP_KEYS（与 begin/finalize 一致）。
 */
export function buildCompensatedSteps(
  brandProfileDone: boolean,
  assembleBuildDone: boolean,
): { key: string; status: string }[] {
  return REFURBISH_STEP_KEYS.map((key) => {
    if (key === 'brand_profile')
      return { key, status: brandProfileDone ? 'done' : 'aborted' };
    if (key === 'assemble_build')
      return { key, status: assembleBuildDone ? 'done' : 'aborted' };
    return { key, status: 'aborted' };
  });
}

const POLISH_TIMEOUT_MS = 2_000; // R0-5：硬超时压到 2s 内不破 Demo 10s P95；超时即 abort 底层 fetch，不烧钱

/**
 * BrandProfile append and Claim projection share one transaction. PostgreSQL
 * may abort it on a unique race (P2002) or deadlock (P2034); both are safe to
 * replay because the aborted transaction has no durable writes.
 */
export async function runBrandProfilePersistenceWithRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034');
      if (!retryable || attempt === maxAttempts - 1) throw error;
    }
  }
  throw new Error('unreachable BrandProfile persistence retry state');
}

export interface DemoV0ActivityInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
}

export interface SiteBuilderActivityDeps {
  prisma: PrismaService;
  /** R4-B durable budget, spend and task-attempt ledger. */
  costLedger?: SiteBuildCostLedger;
  gateway?: ModelGateway;
  /** KB 服务（intake 资料入库 + queued 文档消化 + digest 取材）；worker 装配 KbService，测试可注 stub。 */
  kb?: {
    ingestText: KbService['ingestText'];
    processQueued: KbService['processQueued'];
    processAsset: KbService['processAsset'];
    digestSources?: KbService['digestSources'];
  };
  /** KB recovery 只读跨租户枚举；实际读写仍由 KbService.withWorkspace 执行。 */
  ownerDb?: PrismaClient;
  /** 品牌 web 研究的唯一出网闸门（缺省=研究降级 researchDegraded，不裸出网）。 */
  broker?: ExecutionBroker;
  /** M1-c deterministic Sharp writer; absent in narrow unit tests means an honest degraded step. */
  imagePipeline?: Pick<
    ImagePipelineService,
    'listSiteImageIds' | 'processSiteImages'
  >;
  /** Renderer seam for deterministic cancellation-race tests; production uses the real Astro build. */
  renderSiteSpec?: typeof buildSiteSpecWithTemporaryFile;
  /** Preview pointer seam for deterministic post-commit reconciliation tests. */
  promotePreview?: typeof preparePreviewPromotion;
  /** R1 durable object Release commit protocol; required by every new progressV1 build. */
  releaseService?: Pick<SiteReleaseService, 'materialize'>;
}

export interface RefurbishActivityInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  scope?: BuildScopeInput;
  /** Patch-gated wire flag; absent on pre-R3-B2 histories. */
  progressV1?: boolean;
  /** M1-c internal bounded-batch cursor; absent on all pre-M1-c histories. */
  imageCursor?: string | null;
  imageUpperBound?: string | null;
  /** M1-c workset batches are explicit immutable IDs; absent on legacy cursor histories. */
  imageAssetIds?: string[];
  imageBatchLimit?: number;
  /** Patch-gated M1-d immutable copy result passed from generation to assembly. */
  copy?: CopyGenerationSummary;
}

export interface CopyGenerationSummary {
  snapshotId: string;
  set: CopyBundleSetV1;
  degradedLocales: string[];
  taskAttemptIds: Record<string, string>;
}

export interface RefurbishCompensationInput extends RefurbishActivityInput {
  terminalStatus?: 'failed' | 'cancelled';
  progressV1?: boolean;
}

export interface RefurbishProgressInput
  extends RefurbishActivityInput, BuildProgressEvent {}

export interface KbRecoveryCandidate {
  workspaceId: string;
  siteId: string;
  assetId: string;
}

/** buildBrandProfile 活动的返回（workflow 汇总进 finalize steps）。 */
export interface BrandProfileSummary {
  version: number;
  factCount: number;
  gapsCount: number;
  researchDegraded: boolean;
  model: string;
}

export interface RefurbishFinalizeInput extends RefurbishActivityInput {
  kb: { processed: number; failed: number; degraded: boolean };
  /** P1 brandProfile 步骤汇总（failed=任务整体失败但构建继续的 fail-safe 语义）。 */
  profile: { status: 'done' | 'degraded' | 'failed'; gaps: number };
  /** Optional only at the Activity wire boundary so pre-M1-c scheduled payloads remain replayable. */
  images?: Pick<
    SiteImagePipelineSummary,
    'status' | 'processed' | 'failed' | 'variants'
  >;
  build: { previewSlug: string; versionId: string };
  progressV1?: boolean;
}

/** 本地预览产物根目录（M0 雏形；M1 迁对象存储 + 边缘节点，05 §1）。 */
export function previewRoot(): string {
  return (
    process.env.PREVIEW_DIR ?? path.join(process.cwd(), '.preview', 'sites')
  );
}

function previewStagingDir(buildRunId: string): string {
  return path.join(previewRoot(), '.staging', buildRunId);
}

function previewVersionDir(buildRunId: string): string {
  return path.join(previewRoot(), '.versions', buildRunId);
}

function previewLiveDir(slug: string): string {
  return path.join(previewRoot(), slug);
}

/** 构建 base 路径=预览 URL 的 pathname（两者必须一致，否则资产 404）。子域模式自然得 '/'。 */
export function previewBasePath(slug: string): string {
  const pattern =
    process.env.PREVIEW_URL_PATTERN ?? 'http://localhost:3000/preview/{slug}/';
  try {
    return new URL(pattern.replace('{slug}', slug)).pathname;
  } catch {
    return `/preview/${slug}/`;
  }
}

function copySlotType(key: string): CopySlotType {
  if (/^seo\..*\.title$/.test(key)) return 'seo_title';
  if (/^seo\./.test(key)) return 'seo_description';
  if (/(?:\.cta|\.submit)$/.test(key)) return 'cta_label';
  if (/^inquiry\.field\./.test(key)) return 'form_label';
  return 'plain_text';
}

function copySlotBudget(key: string, type: CopySlotType): number {
  if (type === 'seo_title') return 60;
  if (type === 'seo_description') return 160;
  if (type === 'cta_label' || type === 'form_label') return 32;
  if (/(?:\.body|\.subhead|\.desc|\.blurb|\.a\d+)$/.test(key)) return 420;
  return 90;
}

function copySlotCatalog(
  site: { name: string; intake: Prisma.JsonValue; stylePreset: string | null },
): CopySlotDefinition[] {
  const template = buildDemoSpec({
    siteName: site.name,
    intake: site.intake as unknown as IntakeInput,
    stylePreset: site.stylePreset,
  });
  return collectTextKeys(template)
    .sort()
    .map((key) => {
      const type = copySlotType(key);
      return {
        key,
        type,
        maxGraphemes: copySlotBudget(key, type),
        factual: false,
      };
    });
}

export function neutralCopyOutput(
  slots: readonly CopySlotDefinition[],
  locale: string,
): CopyTaskOutput {
  return {
    slots: Object.fromEntries(
      slots.map((slot) => [
        slot.key,
        { content: neutralCopySlotContent(slot.key, locale), claimRefs: [] },
      ]),
    ),
  };
}

export function createSiteBuilderActivities(deps: SiteBuilderActivityDeps) {
  const {
    prisma,
    costLedger,
    gateway,
    kb,
    broker,
    ownerDb,
    imagePipeline,
    releaseService,
    renderSiteSpec = buildSiteSpecWithTemporaryFile,
    promotePreview = preparePreviewPromotion,
  } = deps;
  const log = new Logger('SiteBuilderActivities');

  // FIX B（Codex P2 · worker 重启鲁棒）：每个耗费活动入口幂等 open（open 取较大 cap + 引用计数，
  // 重复无害）。budgetLedger 是进程内单例、无 GC——若只在 beginRefurbishRun 开账，换 worker 或
  // 重启后（Temporal 把 begin 当已完成缓存、不重放）后续活动会发现无账户 → reserve 返回不限额 →
  // 预算门被绕过。故镜像 discovery.activities 的 ensureRunBudget，在每个耗费活动入口重新立账。
  // finalize/compensate 的 close(force) 无视引用计数，仍能完全关账。
  const ensureRunBudget = (runId: string): void =>
    budgetLedger.open(runId, siteBuildBudgetCents());

  const terminalCostSummary = async (
    workspaceId: string,
    siteId: string,
    buildRunId: string,
    reason: 'run_succeeded' | 'run_failed' | 'run_cancelled',
  ) => {
    if (!costLedger) return undefined;
    await costLedger.ensureBudget({
      workspaceId,
      siteId,
      buildRunId,
      capMicrousd: siteBuildBudgetCents() * 10_000,
    });
    return costLedger.closeAndSummarize({
      workspaceId,
      siteId,
      buildRunId,
      reason,
    });
  };

  async function polishCopy(
    workspaceId: string,
    intake: IntakeInput,
    runId?: string,
    siteId?: string,
    paidScopeKey?: string,
  ): Promise<DemoCopyPolish | undefined> {
    if (!gateway) return undefined;
    try {
      // R0-5：真 AbortSignal 硬超时取代 setTimeout race——超时即 abort 底层 fetch（不留后台弃单继续
      // 烧钱），signal 由网关合并进 AbortSignal.any 透传到 fetch。失败/超时/abort 一律回退确定性模板。
      const result = await gateway.generateStructured<DemoCopyPolish>(
        {
          task: 'site_builder.demo_copy',
          prompt: [
            'Write concise English website copy for a B2B supplier landing page.',
            `Company: ${intake.company.nameEn ?? intake.company.nameZh}`,
            `Products: ${intake.products.join(', ')}`,
            `Target markets (ISO country codes): ${intake.targetMarkets.join(', ')}`,
            'Return headline (<=70 chars), subhead (<=160 chars), aboutBody (<=420 chars).',
            'Rules: use ONLY the facts above; describe the company only as a supplier of the listed products; do NOT call it a manufacturer or claim an engineering team, quality control or export operations; never invent years in business, certificates, factory size or client names.',
          ].join('\n'),
          schema: {
            type: 'object',
            properties: {
              headline: { type: 'string' },
              subhead: { type: 'string' },
              aboutBody: { type: 'string' },
            },
            additionalProperties: false,
          },
          maxTokens: 400,
          // R0-5：真 abort 硬超时——超时即断底层 fetch（不留后台弃单烧钱），压在 Demo 10s P95 内
          signal: AbortSignal.timeout(POLISH_TIMEOUT_MS),
        },
        // FIX A（Codex P2）：带 runId 归账——refurbish 路径 assembleAndBuild→polishCopy 的
        // demo_copy 调用必须计入 buildRunId 上限（gateway 按 ctx.runId ?? ctx.workspaceId 归账）；
        // demo_v0 路径未开账户，gateway 命中未开账户=不限额，行为不变。
        {
          workspaceId,
          runId,
          ...(costLedger && runId && siteId && paidScopeKey
            ? {
                paidCost: {
                  siteId,
                  scopeKey: paidScopeKey,
                  durableReplayResult: (providerResult) => ({
                    ...providerResult,
                    data: sanitizePolish(
                      providerResult.data &&
                        typeof providerResult.data === 'object' &&
                        !Array.isArray(providerResult.data)
                        ? (providerResult.data as DemoCopyPolish)
                        : undefined,
                    ),
                  }),
                },
              }
            : {}),
        },
      );
      // 确定性防造假闸（Codex P2）：模型若无视提示编造年限/认证，弃字段回退模板
      return sanitizePolish(result.data ?? undefined);
    } catch (error) {
      if (error instanceof PaidOperationUnknownError) throw error;
      return undefined; // 超时/失败=模板默认文案（fail-safe，不阻塞 demo）
    }
  }

  /** 消化该站全部 queued KB 文档（refurbish P1 与 kbIngestWorkflow 共用）。 */
  async function processQueuedForSite(
    workspaceId: string,
    siteId: string,
  ): Promise<{ processed: number; failed: number }> {
    if (!kb?.processQueued) return { processed: 0, failed: 0 };
    let activity: ActivityContext | undefined;
    try {
      activity = ActivityContext.current();
    } catch {
      activity = undefined;
    }
    let stage = 'list-queued';
    activity?.heartbeat({ siteId, stage });
    const heartbeatTimer = activity
      ? setInterval(() => activity?.heartbeat({ siteId, stage }), 5_000)
      : undefined;
    heartbeatTimer?.unref();
    try {
      return await kb.processQueued(
        { userId: 'system', workspaceId, roles: [] },
        siteId,
        {
          signal: activity?.cancellationSignal,
          heartbeat: (nextStage) => {
            stage = nextStage;
            activity?.heartbeat({ siteId, stage });
          },
        },
      );
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  return {
    /** demo v0：模板选择 → 轻文案（可选）→ SiteSpec → Astro 构建 → 预览就绪。 */
    async generateDemoV0(
      input: DemoV0ActivityInput,
    ): Promise<{ previewSlug: string }> {
      const { workspaceId, siteId, buildRunId } = input;
      const claimed = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
        const [run, site, existing] = await Promise.all([
          tx.siteBuildRun.findUnique({ where: { id: buildRunId } }),
          tx.site.findUnique({ where: { id: siteId } }),
          tx.siteVersion.findFirst({ where: { buildRunId } }),
        ]);
        if (
          !run ||
          !site ||
          (run.siteId !== undefined && run.siteId !== siteId)
        ) {
          throw new Error(`demo run ${buildRunId} state is missing`);
        }
        if (
          existing &&
          (existing.workspaceId !== workspaceId ||
            existing.siteId !== siteId ||
            existing.source !== 'demo_v0')
        ) {
          throw new Error('SITE_RELEASE_VERSION_SCOPE_MISMATCH');
        }
        if (run.status === 'succeeded') {
          if (
            existing?.buildStatus === 'succeeded' &&
            existing.artifactKey?.startsWith('release:') &&
            site.activeVersionId === existing.id
          ) {
            return {
              completed: true as const,
              site,
              existing,
              publicationBaseVersionId: site.activeVersionId,
            };
          }
          throw new Error('SITE_RELEASE_DEMO_TERMINAL_STATE_MISMATCH');
        }
        if (!['queued', 'running'].includes(run.status)) {
          throw new Error(`demo run ${buildRunId} is not claimable`);
        }
        const storedScope =
          run.scope &&
          typeof run.scope === 'object' &&
          !Array.isArray(run.scope)
            ? run.scope
            : {};
        const hasPublicationBase = Object.prototype.hasOwnProperty.call(
          storedScope,
          'publicationBaseVersionId',
        );
        const storedBase = (
          storedScope as Record<string, Prisma.JsonValue>
        ).publicationBaseVersionId;
        if (
          hasPublicationBase &&
          storedBase !== null &&
          typeof storedBase !== 'string'
        ) {
          throw new Error(`demo run ${buildRunId} has corrupt publication base`);
        }
        const publicationBaseVersionId = hasPublicationBase
          ? (storedBase as string | null)
          : site.activeVersionId;
        const claimedRun = await tx.siteBuildRun.updateMany({
          where: { id: buildRunId, status: run.status },
          data: {
            ...(run.status === 'queued'
              ? { status: 'running', startedAt: new Date() }
              : {}),
            phase: 'demo_v0',
            progress: 0.1,
            ...(!hasPublicationBase
              ? {
                  scope: {
                    ...storedScope,
                    publicationBaseVersionId,
                  } as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
        if (claimedRun.count !== 1) {
          throw new Error(`demo run ${buildRunId} claim was fenced`);
        }
        return {
          completed: false as const,
          site,
          existing,
          publicationBaseVersionId,
        };
      });
      if (claimed.completed) return { previewSlug: claimed.site.slug };

      const intake = claimed.site.intake as unknown as IntakeInput;
      let version = claimed.existing;
      let doc: SiteSpec;
      if (version) {
        doc = version.spec as unknown as SiteSpec;
      } else {
        const polish = await polishCopy(workspaceId, intake, buildRunId);
        const candidate = buildDemoSpec({
          siteName: claimed.site.name,
          intake,
          stylePreset: claimed.site.stylePreset,
          polish,
        });
        const persisted = await prisma.withWorkspace(
          workspaceId,
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
            const run = await tx.siteBuildRun.findUnique({
              where: { id: buildRunId },
              select: { status: true },
            });
            if (run?.status !== 'running') {
              throw new Error(`demo run ${buildRunId} no longer running`);
            }
            const raced = await tx.siteVersion.findFirst({
              where: { buildRunId },
            });
            if (raced) return raced;
            const nextVersion = await allocateNextSiteVersion(tx, siteId);
            return tx.siteVersion.create({
              data: {
                workspaceId,
                siteId,
                version: nextVersion,
                source: 'demo_v0',
                spec: candidate as unknown as Prisma.InputJsonValue,
                specVersion: DEMO_SPEC_VERSION,
                buildStatus: 'building',
                buildRunId,
              },
            });
          },
        );
        version = persisted;
        doc = persisted.spec as unknown as SiteSpec;
      }
      if (
        !version ||
        version.workspaceId !== workspaceId ||
        version.siteId !== siteId ||
        version.source !== 'demo_v0' ||
        !['building', 'succeeded'].includes(version.buildStatus)
      ) {
        throw new Error('SITE_RELEASE_VERSION_NOT_BUILDABLE');
      }
      assertReleaseContract(doc, version.specVersion);

      const outDir = previewStagingDir(buildRunId);
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      await renderSiteSpec(doc, {
        outDir,
        basePath: previewBasePath(claimed.site.slug),
      });

      const accepted = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
        const run = await tx.siteBuildRun.findUnique({
          where: { id: buildRunId },
          select: { status: true },
        });
        if (run?.status === 'running') return true;
        await tx.siteVersion.updateMany({
          where: { id: version.id, buildStatus: 'building' },
          data: { buildStatus: 'failed' },
        });
        return false;
      });
      if (!accepted) {
        await rm(outDir, { recursive: true, force: true });
        throw new Error(
          `run ${buildRunId} no longer running — rendered candidate discarded`,
        );
      }
      if (!releaseService) throw new Error('SITE_RELEASE_SERVICE_UNAVAILABLE');
      const release = await releaseService.materialize({
        workspaceId,
        siteId,
        siteVersionId: version.id,
        buildRunId,
        root: outDir,
        spec: doc,
        storedSpecVersion: version.specVersion,
        createdBy: 'system',
      });

      await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-pointer-${siteId}`}))`;
        const run = await tx.siteBuildRun.findUnique({
          where: { id: buildRunId },
          select: { status: true },
        });
        if (run?.status !== 'running') {
          throw new Error(`demo run ${buildRunId} publication was fenced`);
        }
        await lockSiteSpecAssetsForActivation(tx, {
          workspaceId,
          siteId,
          spec: doc,
        });
        const activatedRelease = await tx.siteRelease.updateMany({
          where: { id: release.releaseId, status: 'ready' },
          data: { lastActivatedAt: new Date() },
        });
        if (activatedRelease.count !== 1) {
          throw new Error('SITE_RELEASE_NOT_READY');
        }
        const activatedSite = await tx.site.updateMany({
          where: {
            id: siteId,
            OR: [
              { activeVersionId: claimed.publicationBaseVersionId },
              { activeVersionId: version.id },
            ],
          },
          data: { activeVersionId: version.id, status: 'ready' },
        });
        if (activatedSite.count !== 1) {
          throw new Error('SITE_RELEASE_POINTER_CAS_FAILED');
        }
        const completed = await tx.siteBuildRun.updateMany({
          where: { id: buildRunId, status: 'running' },
          data: {
            status: 'succeeded',
            progress: 1,
            finishedAt: new Date(),
          },
        });
        if (completed.count !== 1) {
          throw new Error(`demo run ${buildRunId} completion was fenced`);
        }
      });

      // 注册资料入知识库（01 §2）：best-effort，失败不影响 demo 就绪
      if (kb) {
        try {
          await kb.ingestText(
            { userId: 'system', workspaceId, roles: [] },
            {
              siteId,
              source: 'intake',
              title: `注册引导资料 — ${claimed.site.name}`,
              text: intakeToMarkdown(intake),
            },
          );
        } catch (err) {
          log.warn(
            `intake kb ingest failed for site ${siteId}: ${String(err)}`,
          );
        }
      }

      return { previewSlug: claimed.site.slug };
    },

    /**
     * 终态失败补偿（demoV0Workflow catch 调用）——R0-6：**不再删站**。旧版删除半成品 site 会把用户
     * 已接受的 intake 静默丢弃（201 后站点凭空消失、无法原地重试）。改为置 `setup_failed` 保留 Site +
     * 全部 intake；「每 workspace 限 1 站」的 409 由 intake 对 setup_failed 站放行（原地重试）解决。
     */
    async cleanupFailedDemo(input: DemoV0ActivityInput): Promise<void> {
      try {
        const applied = await prisma.withWorkspace(
          input.workspaceId,
          async (tx) => {
            // Codex P1：条件守卫——仅当本 run 仍是该站**最新** demo_v0 run 时才置 setup_failed。
            // 否则若 Temporal 丢失本 cleanup 的完成 ack 触发迟到重试，而用户此间已 re-intake（复用
            // setup_failed 站、新 run 已跑到 ready），无条件 update 会 clobber 掉那个成功的站。
            const latest = await tx.siteBuildRun.findFirst({
              where: { siteId: input.siteId, kind: 'demo_v0' },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (latest?.id !== input.buildRunId) return false; // 更新的 run 已接管，本次 cleanup 作废
            // Codex P2：清本 run 残留的 building 版本（旧版靠删站 cascade 带走；保留站后须显式收尾，
            // 否则终态失败留下永久 in-progress 版本行——下次 re-intake 用新 runId 只清自己那批）。
            await tx.siteVersion.updateMany({
              where: { buildRunId: input.buildRunId, buildStatus: 'building' },
              data: { buildStatus: 'failed' },
            });
            await tx.siteBuildRun.updateMany({
              where: { id: input.buildRunId, status: 'running' },
              data: {
                status: 'failed',
                error: 'demo v0 workflow failed after retries',
                finishedAt: new Date(),
              },
            });
            await tx.site.update({
              where: { id: input.siteId },
              data: { status: 'setup_failed' },
            });
            return true;
          },
        );
        log.warn(
          applied
            ? `demo v0 terminally failed — site ${input.siteId} kept as setup_failed, retryable via re-intake`
            : `demo v0 cleanup skipped — site ${input.siteId} already taken over by a newer run`,
        );
      } catch (err) {
        log.error(
          `cleanupFailedDemo failed for site ${input.siteId}: ${String(err)}`,
        );
      }
    },

    // ── M1-a 精装修骨架（09 §2.3）──────────────────────────────────────────

    /** P1 起步：run→running + 站点进 building（refurbish 不新建站，只动状态）。 */
    async beginRefurbishRun(input: RefurbishActivityInput): Promise<void> {
      const { workspaceId, siteId, buildRunId } = input;
      await prisma.withWorkspace(workspaceId, async (tx) => {
        const site = await tx.site.findUnique({ where: { id: siteId } });
        if (!site) throw new Error(`site ${siteId} not found`);
        // 状态守卫（复审 C2）：cancelled/failed 终态不可被覆写成 running；
        // 'running' 也可再认领=Temporal 结果丢失重试的幂等位。count=0 即进补偿路径。
        const run = await tx.siteBuildRun.findUnique({
          where: { id: buildRunId },
          select: { status: true },
        });
        const claimed =
          run?.status === 'queued'
            ? await tx.siteBuildRun.updateMany({
                where: { id: buildRunId, status: 'queued' },
                data: {
                  status: 'running',
                  phase: 'P1_understanding',
                  progress: 0.05,
                  startedAt: new Date(),
                  steps: [
                    { key: 'kb_ingest', status: 'queued' },
                    { key: 'brand_profile', status: 'queued' },
                    { key: 'image_pipeline', status: 'queued' },
                    { key: 'copy', status: 'queued' },
                    { key: 'assemble_build', status: 'queued' },
                    { key: 'quality_loop', status: 'queued' },
                  ] as Prisma.InputJsonValue,
                },
              })
            : { count: run?.status === 'running' ? 1 : 0 };
        if (claimed.count === 0) {
          throw new Error(
            `run ${buildRunId} not claimable (cancelled or terminal) — aborting`,
          );
        }
        await tx.site.update({
          where: { id: siteId },
          data: { status: 'building' },
        });
      });
      // 预算门真接线（改动 1）：认领成功后才开账（失败 claim 上一步已抛）。close-then-open 清跨-retry
      // 残留账户 + wasExhausted 打标（镜像 discovery resetRunBudget，ledger 进程内无 GC，重试从干净态起）。
      // ⚠️ 只能在活动里（worker 进程持有 ledger 单例）；workflow sandbox 不可触碰。
      budgetLedger.close(buildRunId, { force: true });
      budgetLedger.open(buildRunId, siteBuildBudgetCents());
      await costLedger?.ensureBudget({
        workspaceId,
        siteId,
        buildRunId,
        capMicrousd: siteBuildBudgetCents() * 10_000,
      });
    },

    async recordRefurbishProgress(
      input: RefurbishProgressInput,
    ): Promise<void> {
      await recordBuildProgress(prisma, input, input);
    },

    /** P1：消化该站 queued KB 文档（fail-safe：workflow 侧降级不阻断构建）。 */
    async ingestPendingKb(
      input: RefurbishActivityInput,
    ): Promise<{ processed: number; failed: number }> {
      return processQueuedForSite(input.workspaceId, input.siteId);
    },

    /** P2：在首个短 Activity 中冻结本 build 的图片成员集合。 */
    async listImages(
      input: RefurbishActivityInput,
    ): Promise<{ assetIds: string[]; truncated: boolean }> {
      if (!imagePipeline) throw new Error('image pipeline unavailable');
      return imagePipeline.listSiteImageIds({
        workspaceId: input.workspaceId,
        siteId: input.siteId,
      });
    },

    /** P2：每张 ready 图片独立失败隔离；Sharp 在可杀子进程内运行。 */
    async processImages(
      input: RefurbishActivityInput,
    ): Promise<SiteImagePipelineSummary> {
      if (!imagePipeline) {
        return {
          status: 'degraded',
          processed: 0,
          failed: 0,
          variants: 0,
          items: [],
        };
      }
      let activity: ActivityContext | undefined;
      try {
        activity = ActivityContext.current();
      } catch {
        activity = undefined;
      }
      activity?.heartbeat({ siteId: input.siteId, stage: 'image-pipeline' });
      const heartbeatTimer = activity
        ? setInterval(
            () =>
              activity?.heartbeat({
                siteId: input.siteId,
                stage: 'image-pipeline',
              }),
            5_000,
          )
        : undefined;
      heartbeatTimer?.unref();
      try {
        return await imagePipeline.processSiteImages(
          {
            workspaceId: input.workspaceId,
            siteId: input.siteId,
            afterAssetId: input.imageCursor,
            upperBound: input.imageUpperBound,
            assetIds: input.imageAssetIds,
            limit: input.imageBatchLimit,
          },
          activity?.cancellationSignal,
        );
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },

    /** kbIngestWorkflow 的单 activity（assets commit 触发的摄入 Temporal 化）。 */
    async processQueuedKbDocs(input: {
      workspaceId: string;
      siteId: string;
    }): Promise<{ processed: number; failed: number }> {
      return processQueuedForSite(input.workspaceId, input.siteId);
    },

    /** 单素材 KB 活动：workflowId/input/DB fence 三者都绑定 assetId。 */
    async processKbAsset(input: KbRecoveryCandidate) {
      if (!kb?.processAsset) {
        return { assetId: input.assetId, outcome: 'not_due' as const };
      }
      // verifier/unit tests may invoke the activity function directly, outside a Temporal
      // Activity context. Production worker calls get heartbeat+cancellation propagation.
      let activity: ActivityContext | undefined;
      try {
        activity = ActivityContext.current();
      } catch {
        activity = undefined;
      }
      let stage = 'claim';
      activity?.heartbeat({ assetId: input.assetId, stage });
      const heartbeatTimer = activity
        ? setInterval(
            () => activity?.heartbeat({ assetId: input.assetId, stage }),
            5_000,
          )
        : undefined;
      heartbeatTimer?.unref();
      try {
        return await kb.processAsset(
          { userId: 'system', workspaceId: input.workspaceId, roles: [] },
          input.siteId,
          input.assetId,
          {
            signal: activity?.cancellationSignal,
            heartbeat: (nextStage) => {
              stage = nextStage;
              activity?.heartbeat({ assetId: input.assetId, stage });
            },
          },
        );
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },

    /**
     * 周期 recovery 的受信只读扫描器：只列有界 due queued / expired processing。
     * 高 attempt/长等待发结构化告警；不在 owner 连接上做任何租户写入。
     */
    async listKbRecoveryCandidates(input: {
      limit: number;
    }): Promise<KbRecoveryCandidate[]> {
      if (!ownerDb) return [];
      const now = new Date();
      const limit = Math.max(1, Math.min(input.limit, 500));
      const rows = await ownerDb.asset.findMany({
        where: {
          kind: 'doc',
          contentHash: { not: null },
          deletedAt: null,
          OR: [
            {
              processingStatus: 'queued',
              OR: [{ retryAt: null }, { retryAt: { lte: now } }],
            },
            { processingStatus: 'processing', leaseUntil: { lte: now } },
          ],
        },
        orderBy: [
          // `processing` sorts before `queued`, so an expired worker lease cannot be
          // starved forever by a sustained queued backlog before `take` is applied.
          { processingStatus: 'asc' },
          { leaseUntil: { sort: 'asc', nulls: 'last' } },
          { retryAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        take: limit,
        select: {
          id: true,
          workspaceId: true,
          siteId: true,
          processingAttempt: true,
          processingStatus: true,
          retryAt: true,
          leaseUntil: true,
          createdAt: true,
          processingErrorCode: true,
        },
      });
      for (const row of rows) {
        const ageMs = now.getTime() - row.createdAt.getTime();
        if (row.processingAttempt >= 5 || ageMs >= 60 * 60 * 1000) {
          log.warn(
            JSON.stringify({
              event: 'site_builder_kb_recovery_alert',
              assetId: row.id,
              workspaceId: row.workspaceId,
              siteId: row.siteId,
              status: row.processingStatus,
              attempt: row.processingAttempt,
              ageMs,
              retryAt: row.retryAt?.toISOString() ?? null,
              leaseUntil: row.leaseUntil?.toISOString() ?? null,
              errorCode: row.processingErrorCode,
            }),
          );
        }
      }
      return rows.map((row) => ({
        workspaceId: row.workspaceId,
        siteId: row.siteId,
        assetId: row.id,
      }));
    },

    /**
     * P1：品牌档案（M1-b，09 §2.4）。KB digest + 站主档案 + web 研究 → 模型综合 →
     * 确定性 evidence 闸（D1/D2）→ brand_profile 追加新版本（版本化不覆盖）。
     * - web 研究失败=独立降级位 researchDegraded（仅凭 KB 出 Brief），不整体失败；
     * - 模型全链失败=活动抛错，workflow 侧 fail-safe（构建继续，步骤标 failed）；
     * - Temporal 结果丢失重试会追加新版本行——append-only 设计下无害（读侧恒取最新版）。
     */
    async buildBrandProfile(
      input: RefurbishActivityInput,
    ): Promise<BrandProfileSummary> {
      const { workspaceId, siteId, buildRunId } = input;
      ensureRunBudget(buildRunId); // FIX B：入口幂等 open，防换 worker/重启后账户缺失绕过预算门
      if (!gateway) throw new Error('brand profile: model gateway unavailable');
      if (!costLedger) throw new Error('PERSISTENT_LEDGER_UNAVAILABLE');

      const taskClaim = await costLedger.claimTaskAttempt({
        workspaceId,
        siteId,
        buildRunId,
        taskId: BRAND_PROFILE_TASK.id,
      });
      if (taskClaim.kind === 'completed') {
        return taskClaim.result as unknown as BrandProfileSummary;
      }
      const attempt = taskClaim.attempt;
      const taskFence = {
        workspaceId,
        attemptId: attempt.id,
        fenceToken: attempt.fenceToken,
      };
      let taskCompleted = false;

      try {
        // 🔴 run 状态守卫（复审 Temporal F2）：镜像 assembleAndBuild——cancelled 后不再启动
        // 昂贵的研究+模型调用（其余活动都有守卫，唯此前缺）。落库前另有二次守卫防 zombie 写版本。
        const { site, run } = await prisma.withWorkspace(
          workspaceId,
          async (tx) => ({
            site: await tx.site.findUnique({ where: { id: siteId } }),
            run: await tx.siteBuildRun.findUnique({
              where: { id: buildRunId },
              select: { status: true },
            }),
          }),
        );
        if (!site) throw new Error(`site ${siteId} not found`);
        if (!run || run.status !== 'running') {
          throw new Error(
            `run ${buildRunId} not running (cancelled?) — skip brand profile`,
          );
        }
        if (!site.companyProfileId) {
          throw new Error(
            `SITE_COMPANY_PROFILE_LINK_REQUIRED: site ${siteId} has no verified CompanyProfile link`,
          );
        }
        const companyProfileId = site.companyProfileId;
        const intake = site.intake as unknown as IntakeInput;
        const profile = sanitizeProfileForPrompt(
          (site.profile as Record<string, unknown> | null) ?? undefined,
        );

        const digestDocs = kb?.digestSources
          ? await kb.digestSources(
              { userId: 'system', workspaceId, roles: [] },
              siteId,
            )
          : [];

        let research: { sources: ResearchSource[]; degraded: boolean } = {
          sources: [],
          degraded: true, // broker 缺席=研究能力缺失，诚实标记降级（不裸出网硬顶）
        };
        if (broker) {
          research = await researchBrand(
            { broker },
            {
              workspaceId,
              siteId,
              runId: buildRunId,
              paidCost: {
                taskAttemptId: attempt.id,
                fenceToken: attempt.fenceToken,
                scopeKey: `${attempt.id}:research`,
              },
              companyName: intake.company.nameEn ?? intake.company.nameZh,
              industry: intake.industry,
              websiteUrl: intake.websiteUrl ?? undefined,
            },
          );
        }

        // A1: PII is scrubbed before these exact model-visible blocks are normalized,
        // hashed and persisted. Upstream hashes remain separate provenance fields.
        const prepared = prepareBrandEvidenceSources({
          siteId,
          profileVersionId: site.profileVersionId,
          intake,
          profile,
          kb: digestDocs,
          research: research.sources,
        });
        const frozenSources = [
          prepared.intake,
          ...prepared.kb,
          ...prepared.research,
        ];
        const sourceEntries = frozenSources.map((source) => ({
          source,
          dedupeKey: evidenceSourceDedupeKey(siteId, source),
        }));
        const persistedSources = await prisma.withWorkspace(
          workspaceId,
          async (tx) => {
            const live = await tx.siteBuildRun.findUnique({
              where: { id: buildRunId },
              select: { status: true },
            });
            if (!live || live.status !== 'running') {
              throw new Error(
                `run ${buildRunId} no longer running — skip evidence snapshot write`,
              );
            }
            await tx.siteEvidenceSourceSnapshot.createMany({
              data: sourceEntries.map(({ source, dedupeKey }) => ({
                workspaceId,
                siteId,
                sourceKey: source.sourceKey,
                sourceType: source.sourceType,
                sourceRole: source.sourceRole,
                hashAlgorithm: source.hashAlgorithm,
                contentHash: source.contentHash,
                upstreamContentHash: source.upstreamContentHash,
                normalizationVersion: source.normalizationVersion,
                snapshotText: source.snapshotText,
                displayUrl: source.displayUrl,
                fetchedAt: source.fetchedAt
                  ? new Date(source.fetchedAt)
                  : undefined,
                provenance: source.provenance as Prisma.InputJsonObject,
                dedupeKey,
              })),
              skipDuplicates: true,
            });
            return tx.siteEvidenceSourceSnapshot.findMany({
              where: {
                siteId,
                dedupeKey: {
                  in: sourceEntries.map((entry) => entry.dedupeKey),
                },
              },
            });
          },
        );
        const persistedByDedupe = new Map(
          persistedSources.map((source) => [source.dedupeKey, source]),
        );
        const persistedFor = (source: FrozenEvidenceSource) => {
          const persisted = persistedByDedupe.get(
            evidenceSourceDedupeKey(siteId, source),
          );
          if (!persisted) {
            throw new Error(
              `evidence snapshot persistence lost source ${source.sourceKey}`,
            );
          }
          return persisted;
        };
        const toPromptSource = (
          source: FrozenEvidenceSource,
        ): PromptEvidenceSource => {
          const persisted = persistedFor(source);
          const title =
            typeof source.provenance.title === 'string'
              ? source.provenance.title
              : undefined;
          return {
            sourceId: persisted.id,
            sourceType: source.sourceType,
            sourceRole: source.sourceRole,
            contentHash: persisted.contentHash,
            content: persisted.snapshotText,
            ...(title ? { title } : {}),
            ...(persisted.displayUrl ? { url: persisted.displayUrl } : {}),
            ...(persisted.fetchedAt
              ? { fetchedAt: persisted.fetchedAt.toISOString() }
              : {}),
          };
        };
        const intakeSource = toPromptSource(prepared.intake);
        const kbSources = prepared.kb.map(toPromptSource);
        const researchSources = prepared.research.map(toPromptSource);
        const candidateBrandProfileInput = {
          companyName: intake.company.nameEn ?? intake.company.nameZh,
          industry: intake.industry,
          products: intake.products ?? [],
          targetMarkets: intake.targetMarkets ?? [],
          intakeSource,
          kbSources,
          research: researchSources,
        };

        const frozen = await costLedger.freezeTaskInput(taskFence, {
          taskInput: candidateBrandProfileInput,
          researchDegraded: research.degraded,
        });
        const frozenEnvelope = frozen.input as unknown as {
          taskInput: typeof candidateBrandProfileInput;
          researchDegraded: boolean;
        };
        const brandProfileInput = frozenEnvelope.taskInput;
        const researchDegraded = frozenEnvelope.researchDegraded;

        // The paid gateway must receive its domain persistence gate before the
        // provider call. A raw BrandProfile output is never a durable replay
        // payload: evidence and PII gates run first, and recovery keeps only a
        // controlled gap category instead of model-authored follow-up text.
        const frozenSourceIds = [
          ...new Set(
            [
              brandProfileInput.intakeSource,
              ...brandProfileInput.kbSources,
              ...brandProfileInput.research,
            ].map((source) => source.sourceId),
          ),
        ];
        const frozenPersistedSources = await prisma.withWorkspace(
          workspaceId,
          (tx) =>
            tx.siteEvidenceSourceSnapshot.findMany({
              where: { siteId, id: { in: frozenSourceIds } },
            }),
        );
        if (frozenPersistedSources.length !== frozenSourceIds.length) {
          throw new Error('frozen BrandProfile evidence source is missing');
        }

        const frozenById = new Map<string, FrozenEvidenceSource>(
          frozenPersistedSources.map((source) => [
            source.id,
            {
              sourceKey: source.sourceKey,
              sourceType:
                source.sourceType as FrozenEvidenceSource['sourceType'],
              sourceRole:
                source.sourceRole as FrozenEvidenceSource['sourceRole'],
              hashAlgorithm: 'sha256',
              contentHash: source.contentHash,
              upstreamContentHash: source.upstreamContentHash ?? undefined,
              normalizationVersion:
                source.normalizationVersion as FrozenEvidenceSource['normalizationVersion'],
              snapshotText: source.snapshotText,
              displayUrl: source.displayUrl ?? undefined,
              fetchedAt: source.fetchedAt?.toISOString(),
              provenance: source.provenance as Record<string, unknown>,
            },
          ]),
        );
        const projectBrandProfileOutput = (data: BrandProfileOutput) => {
          const gated = enforceEvidenceGateV2(data.factSheet ?? [], {
            sources: frozenById,
          });
          const gaps: GapItem[] = [
            ...gated.gaps,
            ...(data.gaps ?? []).map((gap) => ({
              field: gap.field,
              reason: 'needs_input' as const,
              hint: gap.question,
            })),
          ];
          return sanitizeBrandProfilePersistenceOutput(
            {
              valueProps: data.valueProps ?? [],
              tone: data.tone
                ? {
                    voice: data.tone.voice,
                    style: data.tone.style ?? [],
                  }
                : null,
              glossary: data.glossary ?? [],
              keywords: data.keywords ?? [],
              differentiators: data.differentiators ?? [],
              competitors: data.competitors ?? [],
              factSheet: gated.factSheet,
              gaps,
            },
            brandProfileInput,
          );
        };
        const toDurableBrandProfileData = (
          clean: ReturnType<typeof projectBrandProfileOutput>,
        ): BrandProfileOutput => ({
          valueProps: clean.valueProps,
          ...(clean.tone ? { tone: clean.tone } : {}),
          glossary: clean.glossary,
          keywords: clean.keywords,
          differentiators: clean.differentiators,
          competitors: clean.competitors,
          factSheet: clean.factSheet,
          gaps: clean.gaps.map((gap) => ({
            field: gap.reason,
            question: `Additional workspace evidence is required (${gap.reason}).`,
          })),
        });
        const durableReplayResult = (
          providerResult: Record<string, unknown>,
        ): Record<string, unknown> => {
          const data = providerResult.data;
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('BrandProfile durable replay has no object data');
          }
          const clean = projectBrandProfileOutput(data as BrandProfileOutput);
          return {
            ...providerResult,
            data: toDurableBrandProfileData(clean),
          };
        };

        let result: AiTaskRunResult<BrandProfileOutput>;
        let generatedModelOutput = false;
        if (
          attempt.status === 'MODEL_SUCCEEDED' &&
          attempt.outputJson &&
          typeof attempt.outputJson === 'object' &&
          !Array.isArray(attempt.outputJson)
        ) {
          result =
            attempt.outputJson as unknown as AiTaskRunResult<BrandProfileOutput>;
        } else {
          generatedModelOutput = true;
          result = await runAiTask<
            Parameters<typeof BRAND_PROFILE_TASK.buildPrompt>[0],
            BrandProfileOutput
          >(BRAND_PROFILE_TASK, brandProfileInput, {
            gateway,
            ctx: {
              workspaceId,
              runId: buildRunId,
              paidCost: {
                siteId,
                taskAttemptId: attempt.id,
                fenceToken: attempt.fenceToken,
                scopeKey: attempt.id,
                durableReplayResult,
              },
            },
          });
        }

        const clean = projectBrandProfileOutput(result.data);
        if (generatedModelOutput) {
          await costLedger.storeTaskOutput(taskFence, {
            ...result,
            data: toDurableBrandProfileData(clean),
          } as unknown as Record<string, unknown>);
        }

        // 版本追加：run 守卫（二次，防 zombie 写版本）+ P2002 并发撞版本→重算（复审 Temporal F2）。
        // aggregate+create 在独立事务，撞唯一约束整事务重试（interactive tx 内 create 失败会作废事务）。
        const brandProfileId = randomUUID();
        let version = 0;
        let persistedFactCount = 0;
        let persistedGapsCount = 0;
        const persisted = await runBrandProfilePersistenceWithRetry(() =>
          prisma.withWorkspace(workspaceId, async (tx) => {
            const live = await tx.siteBuildRun.findUnique({
              where: { id: buildRunId },
              select: { status: true },
            });
            if (!live || live.status !== 'running') {
              throw new Error(
                `run ${buildRunId} no longer running — skip brand profile write`,
              );
            }
            const agg = await tx.brandProfile.aggregate({
              where: { siteId },
              _max: { version: true },
            });
            const next = (agg._max.version ?? 0) + 1; // max+1 单调不回收（version-alloc 同款）
            const bridgeRepository = new PrismaClaimEvidenceBridgeRepository(
              tx,
            );
            const certificationGate =
              await gateCertificationFactsForPersistence(bridgeRepository, {
                workspaceId,
                siteId,
                facts: clean.factSheet,
              });
            const persistedFactSheet = certificationGate.factSheet.map(
              (fact) => ({
                ...fact,
                // Server-owned and frozen with the append-only BrandProfile fact.
                // Bridge readers must not reinterpret history after classifier changes.
                claimType: claimTypeForBrandFact(fact.key, fact.value),
              }),
            );
            const persistedGaps = [...clean.gaps, ...certificationGate.gaps];
            const projectionOrder = persistedFactSheet
              .map((fact, factIndex) => {
                const identity = claimOriginIdentity({
                  workspaceId,
                  companyProfileId,
                  factKey: fact.key,
                  claimType: fact.claimType,
                  statement: fact.value,
                });
                const evidenceOriginKey = claimEvidenceOriginKey({
                  claimOriginKey: identity.claimOriginKey,
                  workspaceId,
                  siteId,
                  sourceSnapshotId: fact.evidence.sourceId,
                  sourceRole: fact.evidence.sourceRole,
                  assetId: fact.evidence.assetId,
                  sourceContentHash: fact.evidence.contentHash,
                  quote: fact.evidence.quote,
                  quoteStart: fact.evidence.selector.start,
                  quoteEnd: fact.evidence.selector.end,
                  quotePrefix: fact.evidence.selector.prefix,
                  quoteSuffix: fact.evidence.selector.suffix,
                  sourceUrl: fact.evidence.url,
                  fetchedAt: fact.evidence.fetchedAt,
                });
                return {
                  factIndex,
                  sortKey: `${identity.claimOriginKey}:${evidenceOriginKey}`,
                  claimOriginKey: identity.claimOriginKey,
                };
              })
              .sort(compareClaimProjectionOrder);

            // Conflict resolution locks Claim rows by UUID. Prelocking every
            // existing target Claim in that same order prevents cross-path
            // deadlocks; missing Claims are then inserted in canonical origin
            // key order by the loop below.
            await bridgeRepository.lockExistingClaimsForOrigins(
              workspaceId,
              companyProfileId,
              projectionOrder.map((row) => row.claimOriginKey),
            );
            await tx.brandProfile.create({
              data: {
                id: brandProfileId,
                workspaceId,
                siteId,
                taskAttemptId: attempt.id,
                version: next,
                evidenceSchemaVersion: 2,
                valueProps: clean.valueProps as Prisma.InputJsonValue,
                tone: (clean.tone ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                glossary: clean.glossary as Prisma.InputJsonValue,
                keywords: clean.keywords as Prisma.InputJsonValue,
                differentiators: clean.differentiators as Prisma.InputJsonValue,
                competitors: clean.competitors as Prisma.InputJsonValue,
                factSheet:
                  persistedFactSheet as unknown as Prisma.InputJsonValue,
                gaps: persistedGaps as unknown as Prisma.InputJsonValue,
                researchDegraded,
              },
            });
            if (persistedFactSheet.length > 0) {
              await tx.brandProfileEvidenceRef.createMany({
                data: persistedFactSheet.map((fact, factIndex) => ({
                  id: fact.evidence.evidenceRefId,
                  workspaceId,
                  siteId,
                  brandProfileId,
                  factIndex,
                  factKey: fact.key,
                  sourceSnapshotId: fact.evidence.sourceId,
                  sourceContentHash: fact.evidence.contentHash,
                  quote: fact.evidence.quote,
                  quoteStart: fact.evidence.selector.start,
                  quoteEnd: fact.evidence.selector.end,
                  quotePrefix: fact.evidence.selector.prefix,
                  quoteSuffix: fact.evidence.selector.suffix,
                })),
              });

              const claimBridge = new ClaimEvidenceBridgeService(
                bridgeRepository,
              );
              for (const { factIndex } of projectionOrder) {
                const projection = await claimBridge.projectFact(
                  { userId: 'system', workspaceId, roles: [] },
                  { siteId, brandProfileId, factIndex },
                );
                if (projection.kind !== 'projected') {
                  throw new Error(
                    `claim bridge rejected persisted fact ${factIndex}: ${projection.reason}`,
                  );
                }
              }
            }
            const summary: BrandProfileSummary = {
              version: next,
              factCount: persistedFactSheet.length,
              gapsCount: persistedGaps.length,
              researchDegraded,
              model: result.model,
            };
            const completed = await tx.siteBuildTaskAttempt.updateMany({
              where: {
                id: attempt.id,
                fenceToken: attempt.fenceToken,
                status: 'MODEL_SUCCEEDED',
                leaseUntil: { gt: new Date() },
              },
              data: {
                status: 'SUCCEEDED',
                resultJson: summary as unknown as Prisma.InputJsonObject,
                leaseUntil: new Date(),
              },
            });
            if (completed.count !== 1) {
              throw new Error('paid task fence is stale or expired');
            }
            return summary;
          }),
        );
        version = persisted.version;
        persistedFactCount = persisted.factCount;
        persistedGapsCount = persisted.gapsCount;

        log.log(
          `brand profile v${version} for site ${siteId}: ${persistedFactCount} facts, ${persistedGapsCount} gaps, model=${result.model}${researchDegraded ? ', research degraded' : ''}`,
        );
        taskCompleted = true;
        return persisted;
      } finally {
        if (!taskCompleted) await costLedger.releaseTask(taskFence);
      }
    },

    /** M1-d: freeze exact publishable Claims, then generate one fenced task per locale. */
    async generateCopyBundles(
      input: RefurbishActivityInput,
    ): Promise<CopyGenerationSummary> {
      const { workspaceId, siteId, buildRunId } = input;
      ensureRunBudget(buildRunId);
      if (!gateway) throw new Error('copy: model gateway unavailable');
      if (!costLedger) throw new Error('PERSISTENT_LEDGER_UNAVAILABLE');

      const { site, snapshot, snapshotId } = await prisma.withWorkspace(
        workspaceId,
        async (tx) => {
          const repository = new PrismaPublishableClaimSnapshotRepository(tx);
          const snapshotService = new PublishableClaimSnapshotService(
            repository,
          );
          const captured = await snapshotService.capture(
            { userId: 'system', workspaceId, roles: [] },
            { siteId, buildRunId },
          );
          const stored = await tx.sitePublishableClaimSnapshot.findUnique({
            where: { buildRunId },
            select: { id: true },
          });
          const currentSite = await tx.site.findFirst({
            where: { id: siteId, workspaceId },
            select: { name: true, intake: true, stylePreset: true },
          });
          if (!stored || !currentSite) {
            throw new Error('copy snapshot or Site disappeared during capture');
          }
          return {
            site: currentSite,
            snapshot: captured,
            snapshotId: stored.id,
          };
        },
      );
      const locales = input.scope?.options?.locales ?? ['en'];
      const slots = copySlotCatalog(site);
      const taskAttemptIds: Record<string, string> = {};
      const localeOutputs = new Map<string, Promise<CopyTaskOutput>>();
      const pendingLocaleTasks = new Map<
        string,
        {
          attemptId: string;
          fence: {
            workspaceId: string;
            attemptId: string;
            fenceToken: string;
          };
        }
      >();

      const executeLocale = (locale: string): Promise<CopyTaskOutput> => {
        const existing = localeOutputs.get(locale);
        if (existing) return existing;
        const execution = (async () => {
          const taskId = `${COPY_TASK.id}:${locale}`;
          const taskClaim = await costLedger.claimTaskAttempt({
            workspaceId,
            siteId,
            buildRunId,
            taskId,
          });
          if (taskClaim.kind === 'completed') {
            const replay = taskClaim.result as unknown as {
              taskAttemptId: string;
              slots: CopyTaskOutput['slots'];
            };
            if (!replay.taskAttemptId || !replay.slots) {
              throw new Error(`completed ${taskId} result is malformed`);
            }
            taskAttemptIds[locale] = replay.taskAttemptId;
            return { slots: replay.slots };
          }

          const attempt = taskClaim.attempt;
          taskAttemptIds[locale] = attempt.id;
          const fence = {
            workspaceId,
            attemptId: attempt.id,
            fenceToken: attempt.fenceToken,
          };
          try {
            const candidate: CopyTaskInput = {
              locale,
              sourceLocale: 'en',
              snapshotDigest: snapshot.digest,
              claims: snapshot.items,
              slots,
            };
            const frozen = await costLedger.freezeTaskInput(
              fence,
              candidate as unknown as Record<string, unknown>,
            );
            const taskOutput =
              snapshot.items.length === 0
                ? neutralCopyOutput(slots, locale)
                : (
                    await runAiTask<CopyTaskInput, CopyTaskOutput>(
                      COPY_TASK,
                      frozen.input as unknown as CopyTaskInput,
                      {
                        gateway,
                        ctx: {
                          workspaceId,
                          runId: buildRunId,
                          paidCost: {
                            siteId,
                            taskAttemptId: attempt.id,
                            fenceToken: attempt.fenceToken,
                            scopeKey: `copy:${locale}`,
                            durableReplayResult: (providerResult) =>
                              providerResult,
                          },
                        },
                      },
                    )
                  ).data;
            pendingLocaleTasks.set(locale, {
              attemptId: attempt.id,
              fence,
            });
            return taskOutput;
          } catch (error) {
            await costLedger.releaseTask(fence);
            throw error;
          }
        })();
        localeOutputs.set(locale, execution);
        return execution;
      };

      const generator: CopySlotGenerator = {
        generateSlot: async ({ locale, slot }) => {
          const output = await executeLocale(locale);
          const generated = output.slots[slot.key];
          if (!generated)
            throw new Error(`model omitted copy slot ${slot.key}`);
          return generated;
        },
      };
      let generated;
      try {
        generated = await new CopyBundleService(generator).generate({
          locales,
          sourceLocale: 'en',
          snapshotId,
          snapshot,
          slots,
          approvedOutboundDomains: [],
        });
      } catch (error) {
        await Promise.all(
          [...pendingLocaleTasks.values()].map(({ fence }) =>
            costLedger.releaseTask(fence),
          ),
        );
        throw error;
      }
      const settledLocales = new Set<string>();
      try {
        for (const [locale, pending] of pendingLocaleTasks) {
          const bundle = generated.set.bundles[locale];
          if (!bundle) {
            await costLedger.releaseTask(pending.fence);
            settledLocales.add(locale);
            continue;
          }
          const canonicalOutput: CopyTaskOutput = {
            slots: Object.fromEntries(
              Object.entries(bundle.slots).map(([key, slot]) => [
                key,
                { content: slot.content, claimRefs: slot.claimRefs },
              ]),
            ),
          };
          await costLedger.storeTaskOutput(
            pending.fence,
            canonicalOutput as unknown as Record<string, unknown>,
          );
          await costLedger.completeTask(pending.fence, {
            taskAttemptId: pending.attemptId,
            slots: canonicalOutput.slots,
          });
          settledLocales.add(locale);
        }
      } finally {
        await Promise.all(
          [...pendingLocaleTasks.entries()]
            .filter(([locale]) => !settledLocales.has(locale))
            .map(([, { fence }]) => costLedger.releaseTask(fence)),
        );
      }
      return {
        snapshotId,
        set: generated.set,
        degradedLocales: generated.degradedLocales,
        taskAttemptIds,
      };
    },

    /** P3（M1-a 最小组装=确定性 spec 重建 + 真 Astro 构建；M1-e 换 agent 组装）。 */
    async assembleAndBuild(
      input: RefurbishActivityInput,
    ): Promise<{ previewSlug: string; versionId: string }> {
      const { workspaceId, siteId, buildRunId } = input;
      ensureRunBudget(buildRunId); // FIX B：入口幂等 open，防换 worker/重启后账户缺失绕过预算门
      const partialBuild =
        input.scope?.scope === 'page' ||
        input.scope?.scope === 'section' ||
        Boolean(input.scope?.options?.pages);
      const baseVersionId = input.scope?.baseVersionId;
      if (partialBuild && !baseVersionId) {
        throw new Error(
          'partial build is missing its immutable base SiteVersion',
        );
      }
      const { site, existing, activeSpec } = await prisma.withWorkspace(
        workspaceId,
        async (tx) => {
          // cancelled 后不再推进（复审 C2）
          const advanced = await tx.siteBuildRun.updateMany({
            where: { id: buildRunId, status: 'running' },
            data: {
              phase: 'P3_assembly',
              progress: input.progressV1 ? 0.65 : 0.5,
            },
          });
          if (advanced.count === 0) {
            throw new Error(
              `run ${buildRunId} no longer running (cancelled?) — aborting assemble`,
            );
          }
          const currentSite = await tx.site.findUnique({
            where: { id: siteId },
          });
          return {
            site: currentSite,
            activeSpec: baseVersionId
              ? ((
                  await tx.siteVersion.findFirst({
                    where: {
                      id: baseVersionId,
                      siteId,
                      buildStatus: 'succeeded',
                    },
                    select: { spec: true },
                  })
                )?.spec ?? null)
              : null,
            // Release candidate may survive an upload/DB ACK-loss. Reuse its exact version/spec.
            existing: await tx.siteVersion.findFirst({
              where: { buildRunId },
            }),
          };
        },
      );
      if (!site) throw new Error(`site ${siteId} not found`);
      if (existing?.buildStatus === 'succeeded') {
        return { previewSlug: site.slug, versionId: existing.id };
      }
      if (existing && existing.buildStatus !== 'building') {
        throw new Error(`run ${buildRunId} has a non-retryable SiteVersion`);
      }

      const intake = site.intake as unknown as IntakeInput;
      const stylePreset = input.scope?.options?.stylePreset ?? site.stylePreset;
      const polish = input.copy
        ? undefined
        : await polishCopy(
            workspaceId,
            intake,
            buildRunId,
            siteId,
            'assemble-demo-copy',
          );
      const candidate = buildDemoSpec({
        siteName: site.name,
        intake,
        stylePreset,
        polish,
      });
      if (input.copy) {
        const locales = Object.keys(input.copy.set.bundles);
        candidate.site.defaultLocale = input.copy.set.sourceLocale;
        candidate.site.locales = locales;
        candidate.copyBundleSet = input.copy.set;
        candidate.copyBundles = Object.fromEntries(
          Object.entries(input.copy.set.bundles).map(([locale, bundle]) => [
            locale,
            copyBundleToLegacyStrings(bundle),
          ]),
        );
      }
      const generatedDoc = applyBuildScope(
        activeSpec as unknown as SiteSpec | null,
        candidate,
        (input.scope ?? { scope: 'site' }) as NormalizedBuildRequest,
      );
      const doc = existing
        ? (existing.spec as unknown as SiteSpec)
        : generatedDoc;

      const version = await prisma.withWorkspace(workspaceId, async (tx) => {
        if (existing) return existing;
        const nextVersion = await allocateNextSiteVersion(tx, siteId);
        const created = await tx.siteVersion.create({
          data: {
            workspaceId,
            siteId,
            version: nextVersion,
            source: 'build',
            spec: doc as unknown as Prisma.InputJsonValue,
            specVersion: DEMO_SPEC_VERSION,
            buildStatus: 'building',
            buildRunId,
          },
        });
        if (input.copy) {
          await tx.siteCopyBundle.createMany({
            data: Object.entries(input.copy.set.bundles).map(
              ([locale, bundle]) => {
                const taskAttemptId = input.copy!.taskAttemptIds[locale];
                if (!taskAttemptId) {
                  throw new Error(`copy task attempt missing for ${locale}`);
                }
                return {
                  workspaceId,
                  siteId,
                  siteVersionId: created.id,
                  buildRunId,
                  claimSnapshotId: input.copy!.snapshotId,
                  taskAttemptId,
                  locale,
                  sourceLocale: bundle.sourceLocale,
                  status: bundle.status,
                  schemaVersion: bundle.schemaVersion,
                  slotCatalogVersion: bundle.slotCatalogVersion,
                  inputHash: bundle.inputHash,
                  bundleDigest: bundle.digest,
                  document: bundle as unknown as Prisma.InputJsonObject,
                };
              },
            ),
          });
        }
        return created;
      });

      // New R3-B2 histories render outside the slug served by the dev preview. finalizeRefurbish
      // promotes this run-scoped candidate only after the active-version CAS succeeds. Legacy
      // histories retain the original direct-to-slug path for Temporal replay compatibility.
      const outDir = input.progressV1
        ? previewStagingDir(buildRunId)
        : previewLiveDir(site.slug);
      if (input.progressV1) {
        await rm(outDir, { recursive: true, force: true });
      }
      await mkdir(outDir, { recursive: true });
      // Fail before renderer I/O or object upload. Section.astro still skips unknown types for
      // legacy compatibility, so R1 publication must enforce the exact supported contract here.
      assertReleaseContract(doc, DEMO_SPEC_VERSION);
      await renderSiteSpec(doc, {
        outDir,
        basePath: previewBasePath(site.slug),
      });

      const accepted = await prisma.withWorkspace(workspaceId, async (tx) => {
        // Serialize renderer completion with cancellation/failure compensation. Cancellation can
        // arrive while Astro ignores the Activity signal; a late renderer must not resurrect a
        // successful version after compensation has terminalized the run.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
        const run = await tx.siteBuildRun.findUnique({
          where: { id: buildRunId },
          select: { status: true },
        });
        if (!run || run.status !== 'running') {
          await tx.siteVersion.updateMany({
            where: { id: version.id, buildStatus: 'building' },
            data: { buildStatus: 'failed' },
          });
          return false;
        }
        return true;
      });
      if (!accepted) {
        if (input.progressV1) {
          await rm(outDir, { recursive: true, force: true });
        }
        throw new Error(
          `run ${buildRunId} no longer running — rendered candidate discarded`,
        );
      }
      if (input.progressV1) {
        if (!releaseService) {
          throw new Error('SITE_RELEASE_SERVICE_UNAVAILABLE');
        }
        await releaseService.materialize({
          workspaceId,
          siteId,
          siteVersionId: version.id,
          buildRunId,
          root: outDir,
          spec: doc,
          storedSpecVersion: DEMO_SPEC_VERSION,
          createdBy: 'system',
        });
      } else {
        // Temporal replay compatibility only. Every newly scheduled workflow has progressV1 and
        // therefore cannot enter this node-local branch.
        const completed = await prisma.withWorkspace(
          workspaceId,
          async (tx) =>
            tx.siteVersion.updateMany({
              where: {
                id: version.id,
                buildRunId,
                buildStatus: 'building',
              },
              data: {
                buildStatus: 'succeeded',
                artifactKey: `local:${outDir}`,
              },
            }),
        );
        if (completed.count !== 1) {
          throw new Error(`run ${buildRunId} local replay finalize was fenced`);
        }
      }
      return { previewSlug: site.slug, versionId: version.id };
    },

    /** P5 收尾：指针切新版本 + run 落 succeeded（steps 记 kb/profile 实况与骨架跳过项）。 */
    async finalizeRefurbish(
      input: RefurbishFinalizeInput,
    ): Promise<{ previewSlug: string }> {
      const {
        workspaceId,
        siteId,
        buildRunId,
        kb: kbSummary,
        profile,
        build,
      } = input;
      const images = input.images ?? {
        status: 'skipped_m1c' as const,
        processed: 0,
        failed: 0,
        variants: 0,
      };
      const costSummary = await terminalCostSummary(
        workspaceId,
        siteId,
        buildRunId,
        'run_succeeded',
      );
      let promotion: PreviewPromotion | undefined;
      let publicationBaseVersionId: string | null | undefined;
      try {
        await prisma.withWorkspace(workspaceId, async (tx) => {
          // Serialize terminal publication with progress writes. This also fences an ACK-lost
          // progress retry that arrives after the run becomes terminal.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-publish-${siteId}`}))`;
          const [runBefore, siteBefore] = await Promise.all([
            tx.siteBuildRun.findUnique({
              where: { id: buildRunId },
              select: { status: true, scope: true },
            }),
            tx.site.findUnique({
              where: { id: siteId },
              select: { activeVersionId: true },
            }),
          ]);
          if (!runBefore || !siteBefore) {
            throw new Error(`run ${buildRunId} publication state is missing`);
          }
          const storedScope =
            runBefore.scope &&
            typeof runBefore.scope === 'object' &&
            !Array.isArray(runBefore.scope)
              ? runBefore.scope
              : {};
          const hasStoredPublicationBase = Object.prototype.hasOwnProperty.call(
            storedScope,
            'publicationBaseVersionId',
          );
          const storedPublicationBase = (
            storedScope as Record<string, Prisma.JsonValue>
          ).publicationBaseVersionId;
          if (
            hasStoredPublicationBase &&
            storedPublicationBase !== null &&
            typeof storedPublicationBase !== 'string'
          ) {
            throw new Error(`run ${buildRunId} has corrupt publication base`);
          }
          const inputHasBase = Boolean(
            input.scope &&
            Object.prototype.hasOwnProperty.call(input.scope, 'baseVersionId'),
          );
          publicationBaseVersionId = input.progressV1
            ? hasStoredPublicationBase
              ? (storedPublicationBase as string | null)
              : runBefore.status === 'running'
                ? inputHasBase
                  ? (input.scope?.baseVersionId ?? null)
                  : siteBefore.activeVersionId
                : undefined
            : undefined;
          if (input.copy) {
            const snapshotRepository =
              new PrismaPublishableClaimSnapshotRepository(tx);
            const snapshotService = new PublishableClaimSnapshotService(
              snapshotRepository,
            );
            const frozen = await snapshotRepository.findByBuildRun(
              workspaceId,
              buildRunId,
            );
            const storedSnapshot =
              await tx.sitePublishableClaimSnapshot.findUnique({
                where: { buildRunId },
                select: { id: true },
              });
            if (
              !frozen ||
              !storedSnapshot ||
              storedSnapshot.id !== input.copy.snapshotId
            ) {
              throw new Error('COPY_CLAIM_SNAPSHOT_MISSING');
            }
            await snapshotService.assertCurrent(
              { userId: 'system', workspaceId, roles: [] },
              frozen,
            );
          }
          // 🔴 发布守卫（复审 C2 / Codex P2）：run 先于指针切换按状态条件落 succeeded——
          // cancelled 的 run 绝不发布；'succeeded' 也可重入=结果丢失重试幂等。count=0 抛错→补偿。
          const published = await tx.siteBuildRun.updateMany({
            where: { id: buildRunId, status: { in: ['running', 'succeeded'] } },
            data: {
              status: 'succeeded',
              phase: 'P5_publish',
              progress: 1,
              finishedAt: new Date(),
              ...(costSummary
                ? {
                    costSummary:
                      costSummary as unknown as Prisma.InputJsonObject,
                  }
                : {}),
              ...(!hasStoredPublicationBase &&
              publicationBaseVersionId !== undefined
                ? {
                    scope: {
                      ...storedScope,
                      publicationBaseVersionId,
                    } as Prisma.InputJsonValue,
                  }
                : {}),
              ...(input.progressV1
                ? {}
                : {
                    steps: [
                      {
                        key: 'kb_ingest',
                        status: kbSummary.degraded ? 'degraded' : 'done',
                        processed: kbSummary.processed,
                        failed: kbSummary.failed,
                      },
                      {
                        key: 'brand_profile',
                        status: profile.status,
                        gaps: profile.gaps,
                      },
                      {
                        key: 'image_pipeline',
                        status: images.status,
                        processed: images.processed,
                        failed: images.failed,
                        variants: images.variants,
                      },
                      { key: 'copy', status: 'skipped_m1d' },
                      { key: 'assemble_build', status: 'done' },
                      { key: 'quality_loop', status: 'skipped_m1f' },
                    ] as Prisma.InputJsonValue,
                  }),
            },
          });
          if (published.count === 0) {
            throw new Error(
              `run ${buildRunId} not publishable (cancelled?) — pointer untouched`,
            );
          }
          const targetVersion = await tx.siteVersion.findFirst({
            where: { id: build.versionId, siteId, buildStatus: 'succeeded' },
            select: {
              spec: true,
              artifactKey: true,
              copyBundles: {
                select: { locale: true, bundleDigest: true },
                orderBy: { locale: 'asc' },
              },
            },
          });
          if (!targetVersion)
            throw new Error(
              `site version ${build.versionId} is not activatable`,
            );
          if (input.copy) {
            const expected = Object.entries(input.copy.set.bundles)
              .map(([locale, bundle]) => ({
                locale,
                bundleDigest: bundle.digest,
              }))
              .sort((left, right) => left.locale.localeCompare(right.locale));
            if (
              JSON.stringify(targetVersion.copyBundles) !==
              JSON.stringify(expected)
            ) {
              throw new Error('COPY_BUNDLE_ACTIVATION_MISMATCH');
            }
          }
          await lockSiteSpecAssetsForActivation(tx, {
            workspaceId,
            siteId,
            spec: targetVersion.spec,
          });
          // 守卫通过才切指针（同事务：守卫失败=整体回滚，站点纹丝不动）
          if (publicationBaseVersionId !== undefined) {
            const activated = await tx.site.updateMany({
              where: {
                id: siteId,
                OR: [
                  { activeVersionId: publicationBaseVersionId },
                  { activeVersionId: build.versionId },
                ],
              },
              data: { activeVersionId: build.versionId, status: 'ready' },
            });
            if (activated.count !== 1) {
              throw new Error(
                'active SiteVersion changed during partial build — pointer untouched',
              );
            }
          } else {
            await tx.site.update({
              where: { id: siteId },
              data: { activeVersionId: build.versionId, status: 'ready' },
            });
          }
          if (targetVersion.artifactKey?.startsWith('release:')) {
            const activatedRelease = await tx.siteRelease.updateMany({
              where: {
                siteVersionId: build.versionId,
                siteId,
                status: 'ready',
              },
              data: { lastActivatedAt: new Date() },
            });
            if (activatedRelease.count !== 1) {
              throw new Error(
                `site version ${build.versionId} has no READY Release`,
              );
            }
          } else if (input.progressV1) {
            const stagingArtifact = `local:${previewStagingDir(buildRunId)}`;
            const versionArtifact = `local:${previewVersionDir(buildRunId)}`;
            const liveArtifact = `local:${previewLiveDir(build.previewSlug)}`;
            // liveArtifact only supports executions completed by the short-lived pre-fix branch.
            // Current executions prepare an immutable hidden version and atomically replace the
            // served .active symlink only after this transaction commits. On Activity retry the
            // version artifact already exists, so preparePreviewPromotion reconstructs the pointer.
            if (targetVersion.artifactKey !== liveArtifact) {
              if (
                targetVersion.artifactKey !== stagingArtifact &&
                targetVersion.artifactKey !== versionArtifact
              ) {
                throw new Error(
                  `site version ${build.versionId} has unexpected preview artifact`,
                );
              }
              promotion = await promotePreview({
                root: previewRoot(),
                slug: build.previewSlug,
                buildRunId,
              });
              if (targetVersion.artifactKey === stagingArtifact) {
                await tx.siteVersion.update({
                  where: { id: build.versionId },
                  data: { artifactKey: versionArtifact },
                });
              }
            }
          }
        });
      } catch (error) {
        if (promotion) {
          try {
            await promotion.rollback();
          } catch (rollbackError) {
            log.error(
              `preview rollback failed for run ${buildRunId}: ${String(rollbackError)}`,
            );
          }
        }
        throw error;
      }
      if (promotion) {
        // DB activeVersionId/artifactKey are committed before the only served-pointer mutation.
        // A crash or rename failure leaves the old pointer visible; Temporal retries this Activity
        // and reconstructs the pending link from the durable immutable version directory.
        try {
          await prisma.withWorkspace(workspaceId, async (tx) => {
            // This site-wide lock spans the final DB recheck and the single pointer rename. A
            // later build cannot publish between them; an old Activity retry that arrives after a
            // newer build observes the mismatch and only abandons its pending link.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-publish-${siteId}`}))`;
            const [siteNow, runNow, versionNow] = await Promise.all([
              tx.site.findUnique({
                where: { id: siteId },
                select: { activeVersionId: true },
              }),
              tx.siteBuildRun.findUnique({
                where: { id: buildRunId },
                select: { status: true },
              }),
              tx.siteVersion.findUnique({
                where: { id: build.versionId },
                select: { buildStatus: true, artifactKey: true },
              }),
            ]);
            const expectedArtifact = `local:${previewVersionDir(buildRunId)}`;
            if (
              siteNow?.activeVersionId !== build.versionId ||
              runNow?.status !== 'succeeded' ||
              versionNow?.buildStatus !== 'succeeded' ||
              versionNow.artifactKey !== expectedArtifact
            ) {
              await promotion!.abandon();
              return;
            }
            await promotion!.commit();
          });
        } catch (pointerError) {
          if (publicationBaseVersionId !== undefined) {
            try {
              await prisma.withWorkspace(workspaceId, async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-publish-${siteId}`}))`;
                await tx.site.updateMany({
                  where: { id: siteId, activeVersionId: build.versionId },
                  data: {
                    activeVersionId: publicationBaseVersionId,
                    status: publicationBaseVersionId ? 'ready' : 'draft',
                  },
                });
                const failed = await tx.siteBuildRun.updateMany({
                  where: { id: buildRunId, status: 'succeeded' },
                  data: {
                    status: 'failed',
                    error: 'preview pointer promotion failed',
                    finishedAt: new Date(),
                  },
                });
                if (failed.count === 1) {
                  await tx.siteVersion.updateMany({
                    where: {
                      id: build.versionId,
                      buildRunId,
                      buildStatus: 'succeeded',
                    },
                    data: { buildStatus: 'failed' },
                  });
                }
              });
            } catch (reconcileError) {
              log.error(
                `preview pointer reconciliation failed for run ${buildRunId}: ${String(reconcileError)}`,
              );
              throw new AggregateError(
                [pointerError, reconcileError],
                'preview pointer promotion and reconciliation failed',
                { cause: reconcileError },
              );
            }
          }
          throw pointerError;
        }
      }
      // 预算门收尾（改动 1）：run 终点强制关账（force 无视 refs）。发布失败走 compensate 关账。
      budgetLedger.close(buildRunId, { force: true });
      return { previewSlug: build.previewSlug };
    },

    /**
     * 🔴 refurbish 终态补偿（09 §2.6 雷①）：run 落 failed + 本次 building 版本行标 failed +
     * 站点状态回滚（有 activeVersion=ready，否则 draft）。**绝不删除站点/既有版本**——
     * 删站补偿只属于 demo_v0（站点因注册而生）。
     */
    async compensateRefurbish(
      input: RefurbishCompensationInput,
    ): Promise<void> {
      const { workspaceId, siteId, buildRunId } = input;
      const terminalStatus = input.terminalStatus ?? 'failed';
      try {
        const costSummary = await terminalCostSummary(
          workspaceId,
          siteId,
          buildRunId,
          terminalStatus === 'cancelled' ? 'run_cancelled' : 'run_failed',
        );
        await prisma.withWorkspace(workspaceId, async (tx) => {
          // Must be acquired before the terminal CAS to avoid a lock-order inversion with
          // recordBuildProgress (advisory lock → SiteBuildRun update).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
          const run = await tx.siteBuildRun.findUnique({
            where: { id: buildRunId },
          });
          if (run && ['queued', 'running'].includes(run.status)) {
            // 改动 3：转 failed 时补写 steps（观测性）——否则 API 显示「failed 但六步全 pending」。
            // brand_profile 落库无 buildRunId 列，用 createdAt>=startedAt 归属探测（单站单活跃 run，claim 守卫）；
            // startedAt 缺失（无从归属）→ 不查，保守判 aborted（不误认领旧版本）。
            const brandProfileDone = run.startedAt
              ? !!(await tx.brandProfile.findFirst({
                  where: { siteId, createdAt: { gte: run.startedAt } },
                }))
              : false;
            // assemble_build 完成靠 siteVersion 行核验（FIX 2）：assembleAndBuild 真成功即留一条
            // succeeded 版本行，buildRunId 唯一定位本 run，无需 startedAt；缺则保守判 aborted。
            const assembleBuildDone = !!(await tx.siteVersion.findFirst({
              where: { buildRunId, buildStatus: 'succeeded' },
            }));
            const legacySteps = input.progressV1
              ? null
              : (buildCompensatedSteps(
                  brandProfileDone,
                  assembleBuildDone,
                ) as Prisma.InputJsonValue);
            const transitioned = await tx.siteBuildRun.updateMany({
              where: { id: buildRunId, status: { in: ['queued', 'running'] } },
              data: {
                status: terminalStatus,
                error:
                  terminalStatus === 'failed'
                    ? (run.error ?? 'refurbish failed (compensated)')
                    : null,
                finishedAt: run.finishedAt ?? new Date(),
                ...(costSummary
                  ? {
                      costSummary:
                        costSummary as unknown as Prisma.InputJsonObject,
                    }
                  : {}),
                ...(legacySteps ? { steps: legacySteps } : {}),
              },
            });
            // The terminal CAS and Site rollback share one transaction. Only the run that
            // actually owned the active slot may change Site status; stale compensation is inert.
            if (transitioned.count === 1) {
              // Renderer completion uses the same advisory lock. Whichever side wins, a run that
              // really transitions terminal cannot retain a successful but unpublished candidate.
              await tx.siteVersion.updateMany({
                where: {
                  buildRunId,
                  buildStatus: { in: ['building', 'succeeded'] },
                },
                data: { buildStatus: 'failed' },
              });
              if (input.progressV1) {
                const terminalSteps = await terminalizeBuildProgress(tx, {
                  workspaceId,
                  buildRunId,
                  phase: (run.phase ?? 'P1_understanding') as Parameters<
                    typeof terminalizeBuildProgress
                  >[1]['phase'],
                  progress: run.progress,
                });
                await tx.siteBuildRun.update({
                  where: { id: buildRunId },
                  data: { steps: terminalSteps },
                });
              }
              const site = await tx.site.findUnique({ where: { id: siteId } });
              if (site) {
                await tx.site.update({
                  where: { id: siteId },
                  data: { status: site.activeVersionId ? 'ready' : 'draft' },
                });
              }
            }
          }
        });
        log.warn(
          `refurbish ${buildRunId} compensated — site ${siteId} preserved`,
        );
      } catch (err) {
        log.error(
          `compensateRefurbish failed for run ${buildRunId}: ${String(err)}`,
        );
        throw err;
      } finally {
        if (input.progressV1) {
          await rm(previewStagingDir(buildRunId), {
            recursive: true,
            force: true,
          }).catch((cleanupError) =>
            log.warn(
              `preview staging cleanup failed for run ${buildRunId}: ${String(cleanupError)}`,
            ),
          );
        }
        // 预算门收尾（改动 1）：run 终点强制关账，即便补偿 DB 工作失败也释放账户（force 无视 refs）。
        budgetLedger.close(buildRunId, { force: true });
      }
    },
  };
}

/** intake JSON → KB 文档 markdown（结构化事实，供后续检索/factSheet）。 */
export function intakeToMarkdown(intake: IntakeInput): string {
  return [
    '# Company registration facts',
    `Company name (zh): ${intake.company.nameZh}`,
    intake.company.nameEn ? `Company name (en): ${intake.company.nameEn}` : '',
    `Industry: ${intake.industry}`,
    `Main products: ${intake.products.join(', ')}`,
    `Target markets: ${intake.targetMarkets.join(', ')}`,
    // R0-4（隐私红线，与 ADR-010 存储侧同源）：businessEmail 是联系信息，绝不进 KB embedding / 品牌 Prompt；
    // 留在受控结构化区 Site.intake（Copy 的 contact 槽按用途读取），不入通用检索语料。
    intake.websiteUrl ? `Existing website: ${intake.websiteUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
