import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Context as ActivityContext } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import {
  buildDemoSpec,
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
import { runAiTask } from '../site-builder/agents/ai-task';
import {
  BRAND_PROFILE_TASK,
  BrandProfileOutput,
  canonicalUrl,
  enforceEvidenceGate,
  EvidenceCorpus,
  GapItem,
  RawFactItem,
  sanitizeProfileForPrompt,
  scrubPii,
} from '../site-builder/agents/brand-profile';
import {
  researchBrand,
  ResearchSource,
} from '../site-builder/agents/brand-research';
import { buildKbDigest } from '../site-builder/agents/kb-digest';
import { buildSiteSpecWithTemporaryFile } from '../site-builder/renderer-build';
import {
  preparePreviewPromotion,
  type PreviewPromotion,
} from '../site-builder/preview-promotion';
import { lockSiteSpecAssetsForActivation } from '../site-builder/asset-reference-gate';
import { applyBuildScope } from '../site-builder/build-scope';
import type { SiteSpec } from '@global/contracts';
import {
  BuildProgressEvent,
  recordBuildProgress,
  terminalizeBuildProgress,
} from '../site-builder/build-progress';
import type { NormalizedBuildRequest } from '../site-builder/build-request-contract';
import type { ExecutionBroker } from '../tools/tool-contract';
import { budgetLedger, siteBuildBudgetCents } from '../tools/budget';

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

export interface DemoV0ActivityInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
}

export interface SiteBuilderActivityDeps {
  prisma: PrismaService;
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

export function createSiteBuilderActivities(deps: SiteBuilderActivityDeps) {
  const { prisma, gateway, kb, broker, ownerDb, imagePipeline } = deps;
  const log = new Logger('SiteBuilderActivities');

  // FIX B（Codex P2 · worker 重启鲁棒）：每个耗费活动入口幂等 open（open 取较大 cap + 引用计数，
  // 重复无害）。budgetLedger 是进程内单例、无 GC——若只在 beginRefurbishRun 开账，换 worker 或
  // 重启后（Temporal 把 begin 当已完成缓存、不重放）后续活动会发现无账户 → reserve 返回不限额 →
  // 预算门被绕过。故镜像 discovery.activities 的 ensureRunBudget，在每个耗费活动入口重新立账。
  // finalize/compensate 的 close(force) 无视引用计数，仍能完全关账。
  const ensureRunBudget = (runId: string): void =>
    budgetLedger.open(runId, siteBuildBudgetCents());

  async function polishCopy(
    workspaceId: string,
    intake: IntakeInput,
    runId?: string,
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
        { workspaceId, runId },
      );
      // 确定性防造假闸（Codex P2）：模型若无视提示编造年限/认证，弃字段回退模板
      return sanitizePolish(result.data ?? undefined);
    } catch {
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

      const site = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteBuildRun.update({
          where: { id: buildRunId },
          data: {
            status: 'running',
            phase: 'demo_v0',
            startedAt: new Date(),
            progress: 0.1,
          },
        });
        return tx.site.findUnique({ where: { id: siteId } });
      });
      if (!site) throw new Error(`site ${siteId} not found`);

      try {
        const intake = site.intake as unknown as IntakeInput;
        const polish = await polishCopy(workspaceId, intake, buildRunId);
        const doc = buildDemoSpec({
          siteName: site.name,
          intake,
          stylePreset: site.stylePreset,
          polish,
        });

        const version = await prisma.withWorkspace(workspaceId, async (tx) => {
          // Temporal 重试的上一次尝试可能残留 building 版本行（复审 LOW）——按 runId 清理
          await tx.siteVersion.deleteMany({
            where: { buildRunId, buildStatus: 'building' },
          });
          const nextVersion = await allocateNextSiteVersion(tx, siteId);
          return tx.siteVersion.create({
            data: {
              workspaceId,
              siteId,
              version: nextVersion,
              source: 'demo_v0',
              spec: doc as unknown as Prisma.InputJsonValue,
              specVersion: DEMO_SPEC_VERSION,
              buildStatus: 'building',
              buildRunId,
            },
          });
        });

        const outDir = path.join(previewRoot(), site.slug);
        await mkdir(outDir, { recursive: true });
        await buildSiteSpecWithTemporaryFile(doc, {
          outDir,
          basePath: previewBasePath(site.slug),
        });

        await prisma.withWorkspace(workspaceId, async (tx) => {
          await lockSiteSpecAssetsForActivation(tx, {
            workspaceId,
            siteId,
            spec: doc,
          });
          await tx.siteVersion.update({
            where: { id: version.id },
            data: { buildStatus: 'succeeded', artifactKey: `local:${outDir}` },
          });
          await tx.site.update({
            where: { id: siteId },
            data: { activeVersionId: version.id, status: 'ready' },
          });
          await tx.siteBuildRun.update({
            where: { id: buildRunId },
            data: { status: 'succeeded', progress: 1, finishedAt: new Date() },
          });
        });

        // 注册资料入知识库（01 §2）：best-effort，失败不影响 demo 就绪
        if (kb) {
          try {
            await kb.ingestText(
              { userId: 'system', workspaceId, roles: [] },
              {
                siteId,
                source: 'intake',
                title: `注册引导资料 — ${site.name}`,
                text: intakeToMarkdown(intake),
              },
            );
          } catch (err) {
            log.warn(
              `intake kb ingest failed for site ${siteId}: ${String(err)}`,
            );
          }
        }

        return { previewSlug: site.slug };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.withWorkspace(workspaceId, async (tx) => {
          await tx.siteBuildRun.update({
            where: { id: buildRunId },
            data: { status: 'failed', error: message, finishedAt: new Date() },
          });
          await tx.site.update({
            where: { id: siteId },
            data: { status: 'draft' },
          });
        });
        throw err;
      }
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
      const kbDigest = buildKbDigest(digestDocs);

      let research: { sources: ResearchSource[]; degraded: boolean } = {
        sources: [],
        degraded: true, // broker 缺席=研究能力缺失，诚实标记降级（不裸出网硬顶）
      };
      if (broker) {
        research = await researchBrand(
          { broker },
          {
            workspaceId,
            runId: buildRunId,
            companyName: intake.company.nameEn ?? intake.company.nameZh,
            industry: intake.industry,
            websiteUrl: intake.websiteUrl ?? undefined,
          },
        );
      }

      const result = await runAiTask<
        Parameters<typeof BRAND_PROFILE_TASK.buildPrompt>[0],
        BrandProfileOutput
      >(
        BRAND_PROFILE_TASK,
        {
          companyName: intake.company.nameEn ?? intake.company.nameZh,
          industry: intake.industry,
          products: intake.products ?? [],
          targetMarkets: intake.targetMarkets ?? [],
          profile,
          kbDigest,
          research: research.sources,
        },
        { gateway, ctx: { workspaceId, runId: buildRunId } },
      );

      // D1/D2 确定性出口闸（复审 F1）：闸执行时活动内有全部原文——按来源做 quote 核验。
      // intakeText 剔 contact 且不含 businessEmail（数据最小化）；urlText 用 canonical(url) 防尾斜杠误降。
      const urlText = new Map<string, string>();
      for (const s of research.sources) {
        const c = canonicalUrl(s.url);
        if (c) urlText.set(c, s.content);
      }
      const corpus: EvidenceCorpus = {
        intakeText: [
          intake.company.nameEn ?? '',
          intake.company.nameZh,
          intake.industry ?? '',
          (intake.products ?? []).join(' '),
          (intake.targetMarkets ?? []).join(' '),
          profile ? JSON.stringify(profile) : '',
        ].join(' '),
        kbText: kbDigest,
        urlText,
      };
      const gated = enforceEvidenceGate(result.data.factSheet ?? [], {
        corpus,
      });
      const gaps: GapItem[] = [
        ...gated.gaps,
        ...(result.data.gaps ?? []).map((g) => ({
          field: g.field,
          reason: 'needs_input' as const,
          hint: scrubPii(g.question),
        })),
      ];

      // 🔴 落库前 PII 清洗（复审 F2）：自由文本字段里的邮箱/电话遮蔽（第三方页面/资料可能带入）
      const scrubFact = (f: RawFactItem): RawFactItem => ({
        ...f,
        value: scrubPii(f.value),
        evidence: f.evidence
          ? {
              ...f.evidence,
              quote: f.evidence.quote ? scrubPii(f.evidence.quote) : undefined,
            }
          : undefined,
      });
      const clean = {
        valueProps: (result.data.valueProps ?? []).map(scrubPii),
        tone: result.data.tone
          ? {
              voice: scrubPii(result.data.tone.voice),
              style: (result.data.tone.style ?? []).map(scrubPii),
            }
          : null,
        glossary: (result.data.glossary ?? []).map((g) => ({
          term: scrubPii(g.term),
          definition: scrubPii(g.definition),
        })),
        keywords: (result.data.keywords ?? []).map(scrubPii),
        differentiators: (result.data.differentiators ?? []).map(scrubPii),
        competitors: (result.data.competitors ?? []).map((c) => ({
          name: scrubPii(c.name),
          positioning: scrubPii(c.positioning),
        })),
        factSheet: gated.factSheet.map(scrubFact),
        gaps: gaps.map((g) => ({ ...g, hint: scrubPii(g.hint) })),
      };

      // 版本追加：run 守卫（二次，防 zombie 写版本）+ P2002 并发撞版本→重算（复审 Temporal F2）。
      // aggregate+create 在独立事务，撞唯一约束整事务重试（interactive tx 内 create 失败会作废事务）。
      let version = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          version = await prisma.withWorkspace(workspaceId, async (tx) => {
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
            await tx.brandProfile.create({
              data: {
                workspaceId,
                siteId,
                version: next,
                valueProps: clean.valueProps as Prisma.InputJsonValue,
                tone: (clean.tone ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                glossary: clean.glossary as Prisma.InputJsonValue,
                keywords: clean.keywords as Prisma.InputJsonValue,
                differentiators: clean.differentiators as Prisma.InputJsonValue,
                competitors: clean.competitors as Prisma.InputJsonValue,
                factSheet: clean.factSheet as unknown as Prisma.InputJsonValue,
                gaps: clean.gaps as unknown as Prisma.InputJsonValue,
                researchDegraded: research.degraded,
              },
            });
            return next;
          });
          break;
        } catch (err) {
          const isVersionClash =
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002';
          if (isVersionClash && attempt < 4) continue; // 并发撞版本→重算，不让整活动 attempt 重跑
          throw err;
        }
      }

      log.log(
        `brand profile v${version} for site ${siteId}: ${clean.factSheet.length} facts, ${gaps.length} gaps, model=${result.model}${research.degraded ? ', research degraded' : ''}`,
      );
      return {
        version,
        factCount: clean.factSheet.length,
        gapsCount: gaps.length,
        researchDegraded: research.degraded,
        model: result.model,
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
            // Temporal 结果丢失重试的幂等位（Codex P2）：本 run 已有成功版本→复用，不再建第二个
            existing: await tx.siteVersion.findFirst({
              where: { buildRunId, buildStatus: 'succeeded' },
            }),
          };
        },
      );
      if (!site) throw new Error(`site ${siteId} not found`);
      if (existing) return { previewSlug: site.slug, versionId: existing.id };

      const intake = site.intake as unknown as IntakeInput;
      const stylePreset = input.scope?.options?.stylePreset ?? site.stylePreset;
      const polish = await polishCopy(workspaceId, intake, buildRunId);
      const candidate = buildDemoSpec({
        siteName: site.name,
        intake,
        stylePreset,
        polish,
      });
      const doc = applyBuildScope(
        activeSpec as unknown as SiteSpec | null,
        candidate,
        (input.scope ?? { scope: 'site' }) as NormalizedBuildRequest,
      );

      const version = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteVersion.deleteMany({
          where: { buildRunId, buildStatus: 'building' },
        });
        const nextVersion = await allocateNextSiteVersion(tx, siteId);
        return tx.siteVersion.create({
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
      await buildSiteSpecWithTemporaryFile(doc, {
        outDir,
        basePath: previewBasePath(site.slug),
      });

      await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteVersion.update({
          where: { id: version.id },
          data: { buildStatus: 'succeeded', artifactKey: `local:${outDir}` },
        });
      });
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
      let promotion: PreviewPromotion | undefined;
      try {
        await prisma.withWorkspace(workspaceId, async (tx) => {
          // Serialize terminal publication with progress writes. This also fences an ACK-lost
          // progress retry that arrives after the run becomes terminal.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
          // 🔴 发布守卫（复审 C2 / Codex P2）：run 先于指针切换按状态条件落 succeeded——
          // cancelled 的 run 绝不发布；'succeeded' 也可重入=结果丢失重试幂等。count=0 抛错→补偿。
          const published = await tx.siteBuildRun.updateMany({
            where: { id: buildRunId, status: { in: ['running', 'succeeded'] } },
            data: {
              status: 'succeeded',
              phase: 'P5_publish',
              progress: 1,
              finishedAt: new Date(),
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
            select: { spec: true, artifactKey: true },
          });
          if (!targetVersion)
            throw new Error(
              `site version ${build.versionId} is not activatable`,
            );
          await lockSiteSpecAssetsForActivation(tx, {
            workspaceId,
            siteId,
            spec: targetVersion.spec,
          });
          // 守卫通过才切指针（同事务：守卫失败=整体回滚，站点纹丝不动）
          if (input.scope?.baseVersionId) {
            const activated = await tx.site.updateMany({
              where: { id: siteId, activeVersionId: input.scope.baseVersionId },
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
          if (input.progressV1) {
            const stagingArtifact = `local:${previewStagingDir(buildRunId)}`;
            const liveArtifact = `local:${previewLiveDir(build.previewSlug)}`;
            // A finalize Activity result may be lost after commit. In that replay, both the active
            // pointer and artifactKey already describe the promoted preview, so no second swap occurs.
            if (targetVersion.artifactKey !== liveArtifact) {
              if (targetVersion.artifactKey !== stagingArtifact) {
                throw new Error(
                  `site version ${build.versionId} has unexpected preview artifact`,
                );
              }
              // The pointer CAS above is the publication gate. Keep the former live directory as a
              // rollback copy until Prisma confirms this transaction committed.
              promotion = await preparePreviewPromotion({
                root: previewRoot(),
                slug: build.previewSlug,
                buildRunId,
              });
              await tx.siteVersion.update({
                where: { id: build.versionId },
                data: { artifactKey: liveArtifact },
              });
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
        try {
          await promotion.commit();
        } catch (cleanupError) {
          // Publication is already committed. A retained rollback directory is safe garbage and
          // must not turn a successful workflow into a retry that could re-publish.
          log.warn(
            `preview rollback-copy cleanup failed for run ${buildRunId}: ${String(cleanupError)}`,
          );
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
        await prisma.withWorkspace(workspaceId, async (tx) => {
          // Must be acquired before the terminal CAS to avoid a lock-order inversion with
          // recordBuildProgress (advisory lock → SiteBuildRun update).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
          await tx.siteVersion.updateMany({
            where: { buildRunId, buildStatus: 'building' },
            data: { buildStatus: 'failed' },
          });
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
                ...(legacySteps ? { steps: legacySteps } : {}),
              },
            });
            // The terminal CAS and Site rollback share one transaction. Only the run that
            // actually owned the active slot may change Site status; stale compensation is inert.
            if (transitioned.count === 1) {
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
