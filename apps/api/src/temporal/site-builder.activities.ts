import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { researchBrand, ResearchSource } from '../site-builder/agents/brand-research';
import { buildKbDigest } from '../site-builder/agents/kb-digest';
import type { ExecutionBroker } from '../tools/tool-contract';

const execFileAsync = promisify(execFile);

const POLISH_TIMEOUT_MS = 8_000; // 02 §4：轻文案调用超时即用模板默认文案
const BUILD_TIMEOUT_MS = 180_000;

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
    digestSources?: KbService['digestSources'];
  };
  /** 品牌 web 研究的唯一出网闸门（缺省=研究降级 researchDegraded，不裸出网）。 */
  broker?: ExecutionBroker;
}

export interface RefurbishActivityInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  scope?: BuildScopeInput;
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
  build: { previewSlug: string; versionId: string };
}

/** 本地预览产物根目录（M0 雏形；M1 迁对象存储 + 边缘节点，05 §1）。 */
export function previewRoot(): string {
  return process.env.PREVIEW_DIR ?? path.join(process.cwd(), '.preview', 'sites');
}

/** 构建 base 路径=预览 URL 的 pathname（两者必须一致，否则资产 404）。子域模式自然得 '/'。 */
export function previewBasePath(slug: string): string {
  const pattern = process.env.PREVIEW_URL_PATTERN ?? 'http://localhost:3000/preview/{slug}/';
  try {
    return new URL(pattern.replace('{slug}', slug)).pathname;
  } catch {
    return `/preview/${slug}/`;
  }
}

export function createSiteBuilderActivities(deps: SiteBuilderActivityDeps) {
  const { prisma, gateway, kb, broker } = deps;
  const log = new Logger('SiteBuilderActivities');

  async function polishCopy(
    workspaceId: string,
    intake: IntakeInput,
  ): Promise<DemoCopyPolish | undefined> {
    if (!gateway) return undefined;
    try {
      const result = await Promise.race([
        gateway.generateStructured<DemoCopyPolish>(
          {
            task: 'site_builder.demo_copy',
            prompt: [
              'Write concise English website copy for a manufacturer landing page.',
              `Company: ${intake.company.nameEn ?? intake.company.nameZh}`,
              `Products: ${intake.products.join(', ')}`,
              `Target markets (ISO country codes): ${intake.targetMarkets.join(', ')}`,
              'Return headline (<=70 chars), subhead (<=160 chars), aboutBody (<=420 chars).',
              'Rules: use ONLY the facts above; never invent years in business, certificates, factory size or client names.',
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
          },
          { workspaceId },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('demo copy polish timeout')), POLISH_TIMEOUT_MS),
        ),
      ]);
      // 确定性防造假闸（Codex P2）：模型若无视提示编造年限/认证，弃字段回退模板
      return sanitizePolish(result.data ?? undefined);
    } catch {
      return undefined; // 超时/失败=模板默认文案（fail-safe，不阻塞 demo）
    }
  }

  async function runAstroBuild(specPath: string, outDir: string, basePath: string): Promise<void> {
    await execFileAsync(
      'pnpm',
      ['--filter', '@global/site-renderer', 'exec', 'astro', 'build'],
      {
        env: {
          ...process.env,
          SITESPEC_PATH: specPath,
          OUT_DIR: outDir,
          BASE_PATH: basePath, // 子路径预览必设，否则 /_astro 资产 404
          ASTRO_TELEMETRY_DISABLED: '1',
        },
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  }

  /** 消化该站全部 queued KB 文档（refurbish P1 与 kbIngestWorkflow 共用）。 */
  async function processQueuedForSite(
    workspaceId: string,
    siteId: string,
  ): Promise<{ processed: number; failed: number }> {
    if (!kb?.processQueued) return { processed: 0, failed: 0 };
    return kb.processQueued({ userId: 'system', workspaceId, roles: [] }, siteId);
  }

  return {
    /** demo v0：模板选择 → 轻文案（可选）→ SiteSpec → Astro 构建 → 预览就绪。 */
    async generateDemoV0(input: DemoV0ActivityInput): Promise<{ previewSlug: string }> {
      const { workspaceId, siteId, buildRunId } = input;

      const site = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteBuildRun.update({
          where: { id: buildRunId },
          data: { status: 'running', phase: 'demo_v0', startedAt: new Date(), progress: 0.1 },
        });
        return tx.site.findUnique({ where: { id: siteId } });
      });
      if (!site) throw new Error(`site ${siteId} not found`);

      try {
        const intake = site.intake as unknown as IntakeInput;
        const polish = await polishCopy(workspaceId, intake);
        const doc = buildDemoSpec({
          siteName: site.name,
          intake,
          stylePreset: site.stylePreset,
          polish,
        });

        const version = await prisma.withWorkspace(workspaceId, async (tx) => {
          // Temporal 重试的上一次尝试可能残留 building 版本行（复审 LOW）——按 runId 清理
          await tx.siteVersion.deleteMany({ where: { buildRunId, buildStatus: 'building' } });
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

        const specPath = path.join(tmpdir(), `sitespec-${buildRunId}.json`);
        await writeFile(specPath, JSON.stringify(doc), 'utf8');
        const outDir = path.join(previewRoot(), site.slug);
        await mkdir(outDir, { recursive: true });
        await runAstroBuild(specPath, outDir, previewBasePath(site.slug));
        await rm(specPath, { force: true });

        await prisma.withWorkspace(workspaceId, async (tx) => {
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
            log.warn(`intake kb ingest failed for site ${siteId}: ${String(err)}`);
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
          await tx.site.update({ where: { id: siteId }, data: { status: 'draft' } });
        });
        throw err;
      }
    },

    /**
     * 终态失败补偿（demoV0Workflow catch 调用）：删除半成品 site（级联 run/version），
     * 否则「每 workspace 限 1 站」让用户 re-intake 永远 409——一次构建失败=注册砖化（复审 MEDIUM）。
     */
    async cleanupFailedDemo(input: DemoV0ActivityInput): Promise<void> {
      try {
        await prisma.withWorkspace(input.workspaceId, async (tx) => {
          await tx.site.delete({ where: { id: input.siteId } });
        });
        log.warn(`demo v0 terminally failed — site ${input.siteId} rolled back, intake retryable`);
      } catch (err) {
        log.error(`cleanupFailedDemo failed for site ${input.siteId}: ${String(err)}`);
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
        const claimed = await tx.siteBuildRun.updateMany({
          where: { id: buildRunId, status: { in: ['queued', 'running'] } },
          data: {
            status: 'running',
            phase: 'P1_understanding',
            progress: 0.05,
            startedAt: new Date(),
            steps: [
              { key: 'kb_ingest', status: 'pending' },
              { key: 'brand_profile', status: 'pending' },
              { key: 'image_pipeline', status: 'pending_m1c' },
              { key: 'copy', status: 'pending_m1d' },
              { key: 'assemble_build', status: 'pending' },
              { key: 'quality_loop', status: 'pending_m1f' },
            ] as Prisma.InputJsonValue,
          },
        });
        if (claimed.count === 0) {
          throw new Error(`run ${buildRunId} not claimable (cancelled or terminal) — aborting`);
        }
        await tx.site.update({ where: { id: siteId }, data: { status: 'building' } });
      });
    },

    /** P1：消化该站 queued KB 文档（fail-safe：workflow 侧降级不阻断构建）。 */
    async ingestPendingKb(
      input: RefurbishActivityInput,
    ): Promise<{ processed: number; failed: number }> {
      return processQueuedForSite(input.workspaceId, input.siteId);
    },

    /** kbIngestWorkflow 的单 activity（assets commit 触发的摄入 Temporal 化）。 */
    async processQueuedKbDocs(input: {
      workspaceId: string;
      siteId: string;
    }): Promise<{ processed: number; failed: number }> {
      return processQueuedForSite(input.workspaceId, input.siteId);
    },

    /**
     * P1：品牌档案（M1-b，09 §2.4）。KB digest + 站主档案 + web 研究 → 模型综合 →
     * 确定性 evidence 闸（D1/D2）→ brand_profile 追加新版本（版本化不覆盖）。
     * - web 研究失败=独立降级位 researchDegraded（仅凭 KB 出 Brief），不整体失败；
     * - 模型全链失败=活动抛错，workflow 侧 fail-safe（构建继续，步骤标 failed）；
     * - Temporal 结果丢失重试会追加新版本行——append-only 设计下无害（读侧恒取最新版）。
     */
    async buildBrandProfile(input: RefurbishActivityInput): Promise<BrandProfileSummary> {
      const { workspaceId, siteId, buildRunId } = input;
      if (!gateway) throw new Error('brand profile: model gateway unavailable');

      // 🔴 run 状态守卫（复审 Temporal F2）：镜像 assembleAndBuild——cancelled 后不再启动
      // 昂贵的研究+模型调用（其余活动都有守卫，唯此前缺）。落库前另有二次守卫防 zombie 写版本。
      const { site, run } = await prisma.withWorkspace(workspaceId, async (tx) => ({
        site: await tx.site.findUnique({ where: { id: siteId } }),
        run: await tx.siteBuildRun.findUnique({
          where: { id: buildRunId },
          select: { status: true },
        }),
      }));
      if (!site) throw new Error(`site ${siteId} not found`);
      if (!run || run.status !== 'running') {
        throw new Error(`run ${buildRunId} not running (cancelled?) — skip brand profile`);
      }
      const intake = site.intake as unknown as IntakeInput;
      const profile = sanitizeProfileForPrompt(
        (site.profile as Record<string, unknown> | null) ?? undefined,
      );

      const digestDocs = kb?.digestSources
        ? await kb.digestSources({ userId: 'system', workspaceId, roles: [] }, siteId)
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
      const gated = enforceEvidenceGate(result.data.factSheet ?? [], { corpus });
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
          ? { ...f.evidence, quote: f.evidence.quote ? scrubPii(f.evidence.quote) : undefined }
          : undefined,
      });
      const clean = {
        valueProps: (result.data.valueProps ?? []).map(scrubPii),
        tone: result.data.tone
          ? { voice: scrubPii(result.data.tone.voice), style: (result.data.tone.style ?? []).map(scrubPii) }
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
              throw new Error(`run ${buildRunId} no longer running — skip brand profile write`);
            }
            const agg = await tx.brandProfile.aggregate({ where: { siteId }, _max: { version: true } });
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
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
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
      const { site, existing } = await prisma.withWorkspace(workspaceId, async (tx) => {
        // cancelled 后不再推进（复审 C2）
        const advanced = await tx.siteBuildRun.updateMany({
          where: { id: buildRunId, status: 'running' },
          data: { phase: 'P3_assembly', progress: 0.5 },
        });
        if (advanced.count === 0) {
          throw new Error(`run ${buildRunId} no longer running (cancelled?) — aborting assemble`);
        }
        return {
          site: await tx.site.findUnique({ where: { id: siteId } }),
          // Temporal 结果丢失重试的幂等位（Codex P2）：本 run 已有成功版本→复用，不再建第二个
          existing: await tx.siteVersion.findFirst({
            where: { buildRunId, buildStatus: 'succeeded' },
          }),
        };
      });
      if (!site) throw new Error(`site ${siteId} not found`);
      if (existing) return { previewSlug: site.slug, versionId: existing.id };

      const intake = site.intake as unknown as IntakeInput;
      const stylePreset = input.scope?.options?.stylePreset ?? site.stylePreset;
      const polish = await polishCopy(workspaceId, intake);
      const doc = buildDemoSpec({ siteName: site.name, intake, stylePreset, polish });

      const version = await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteVersion.deleteMany({ where: { buildRunId, buildStatus: 'building' } });
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

      const specPath = path.join(tmpdir(), `sitespec-${buildRunId}.json`);
      await writeFile(specPath, JSON.stringify(doc), 'utf8');
      const outDir = path.join(previewRoot(), site.slug);
      await mkdir(outDir, { recursive: true });
      await runAstroBuild(specPath, outDir, previewBasePath(site.slug));
      await rm(specPath, { force: true });

      await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.siteVersion.update({
          where: { id: version.id },
          data: { buildStatus: 'succeeded', artifactKey: `local:${outDir}` },
        });
      });
      return { previewSlug: site.slug, versionId: version.id };
    },

    /** P5 收尾：指针切新版本 + run 落 succeeded（steps 记 kb/profile 实况与骨架跳过项）。 */
    async finalizeRefurbish(input: RefurbishFinalizeInput): Promise<{ previewSlug: string }> {
      const { workspaceId, siteId, buildRunId, kb: kbSummary, profile, build } = input;
      await prisma.withWorkspace(workspaceId, async (tx) => {
        // 🔴 发布守卫（复审 C2 / Codex P2）：run 先于指针切换按状态条件落 succeeded——
        // cancelled 的 run 绝不发布；'succeeded' 也可重入=结果丢失重试幂等。count=0 抛错→补偿。
        const published = await tx.siteBuildRun.updateMany({
          where: { id: buildRunId, status: { in: ['running', 'succeeded'] } },
          data: {
            status: 'succeeded',
            phase: 'P5_publish',
            progress: 1,
            finishedAt: new Date(),
            steps: [
              {
                key: 'kb_ingest',
                status: kbSummary.degraded ? 'degraded' : 'done',
                processed: kbSummary.processed,
                failed: kbSummary.failed,
              },
              { key: 'brand_profile', status: profile.status, gaps: profile.gaps },
              { key: 'image_pipeline', status: 'skipped_m1c' },
              { key: 'copy', status: 'skipped_m1d' },
              { key: 'assemble_build', status: 'done' },
              { key: 'quality_loop', status: 'skipped_m1f' },
            ] as Prisma.InputJsonValue,
          },
        });
        if (published.count === 0) {
          throw new Error(`run ${buildRunId} not publishable (cancelled?) — pointer untouched`);
        }
        // 守卫通过才切指针（同事务：守卫失败=整体回滚，站点纹丝不动）
        await tx.site.update({
          where: { id: siteId },
          data: { activeVersionId: build.versionId, status: 'ready' },
        });
      });
      return { previewSlug: build.previewSlug };
    },

    /**
     * 🔴 refurbish 终态补偿（09 §2.6 雷①）：run 落 failed + 本次 building 版本行标 failed +
     * 站点状态回滚（有 activeVersion=ready，否则 draft）。**绝不删除站点/既有版本**——
     * 删站补偿只属于 demo_v0（站点因注册而生）。
     */
    async compensateRefurbish(input: RefurbishActivityInput): Promise<void> {
      const { workspaceId, siteId, buildRunId } = input;
      try {
        await prisma.withWorkspace(workspaceId, async (tx) => {
          await tx.siteVersion.updateMany({
            where: { buildRunId, buildStatus: 'building' },
            data: { buildStatus: 'failed' },
          });
          const site = await tx.site.findUnique({ where: { id: siteId } });
          if (site) {
            await tx.site.update({
              where: { id: siteId },
              data: { status: site.activeVersionId ? 'ready' : 'draft' },
            });
          }
          const run = await tx.siteBuildRun.findUnique({ where: { id: buildRunId } });
          if (run && run.status !== 'succeeded' && run.status !== 'cancelled') {
            await tx.siteBuildRun.update({
              where: { id: buildRunId },
              data: {
                status: 'failed',
                error: run.error ?? 'refurbish failed (compensated)',
                finishedAt: run.finishedAt ?? new Date(),
              },
            });
          }
        });
        log.warn(`refurbish ${buildRunId} compensated — site ${siteId} preserved`);
      } catch (err) {
        log.error(`compensateRefurbish failed for run ${buildRunId}: ${String(err)}`);
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
    `Business email: ${intake.businessEmail}`,
    intake.websiteUrl ? `Existing website: ${intake.websiteUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
