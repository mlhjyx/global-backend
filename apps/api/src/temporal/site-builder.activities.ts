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
  /** KB 摄入（intake 资料入库，best-effort）；worker 装配 KbService，测试可注 stub。 */
  kb?: { ingestText: KbService['ingestText'] };
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
  const { prisma, gateway, kb } = deps;
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
          const count = await tx.siteVersion.count({ where: { siteId } });
          return tx.siteVersion.create({
            data: {
              workspaceId,
              siteId,
              version: count + 1,
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
