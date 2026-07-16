import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { DEMO_V0_LAUNCHER, DemoV0Launcher } from './demo-launcher';
import { makeSlug } from './slug';

/** 注册引导 6 项（01 §3.1）。DTO 层已校验形状，此处只留业务不变式兜底。 */
export interface IntakeInput {
  company: { nameZh: string; nameEn?: string | null };
  industry: string;
  products: string[];
  targetMarkets: string[];
  hasWebsite: boolean;
  websiteUrl?: string | null;
  businessEmail: string;
}

export interface IntakeResult {
  siteId: string;
  mode: string;
  status: string;
}

/**
 * 注册引导 → 建档 + demo v0（01 §2 两段式：注册绝不等分钟级管线）。
 * R0-2（01 §2.1 / DoD-1，2026-07-16 用户拍板）：**无条件建 demo**——不论 hasWebsite，都 mode=builder + 建 demo_v0 run + 触发 Temporal；
 * hasWebsite/websiteUrl 只作背景知识存入 intake（供后续 M3 诊断），不再分叉栏目/不再走 diagnosis 只建档路径。
 */
@Injectable()
export class IntakeService {
  private readonly log = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DEMO_V0_LAUNCHER) private readonly demoLauncher: DemoV0Launcher,
  ) {}

  async create(ctx: RequestContext, input: IntakeInput): Promise<IntakeResult> {
    if (input.hasWebsite && !input.websiteUrl) {
      throw new BadRequestException('websiteUrl is required when hasWebsite=true');
    }
    // R0-2：无条件建 demo，不因 hasWebsite 分叉（websiteUrl 仍在下方 intake JSON 里留存）
    const mode = 'builder';
    const status = 'building';
    const nameEn = input.company.nameEn?.trim() || null;

    const { site, run, wasCreated } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      // Codex P2：advisory xact lock 关闭双请求并发窗口——「每 workspace 限 1 站」原子成立
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-intake-${ctx.workspaceId}`}))`;
      const existing = await tx.site.findFirst({
        where: { workspaceId: ctx.workspaceId },
        select: { id: true, status: true },
      });
      // R0-6：既有 setup_failed 站 = 上次 demo 终态失败留痕（cleanupFailedDemo 不再删站）→ **原地重试**
      // （复用同 site，保留 id/slug 稳定预览 URL，刷新 intake + 回 building）；其余状态仍守「限 1 站」。
      if (existing && existing.status !== 'setup_failed') {
        throw new ConflictException('workspace already has a site (v1 limit: 1 per workspace)');
      }
      const shared = {
        name: nameEn ?? input.company.nameZh,
        mode,
        status,
        locales: ['en'] satisfies string[] as unknown as Prisma.InputJsonValue,
        intake: input as unknown as Prisma.InputJsonValue,
      };
      const createdSite = existing
        ? await tx.site.update({ where: { id: existing.id }, data: shared })
        : await tx.site.create({
            data: { workspaceId: ctx.workspaceId, slug: makeSlug(nameEn), ...shared },
          });
      const createdRun = await tx.siteBuildRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          siteId: createdSite.id,
          kind: 'demo_v0',
          status: 'queued',
        },
      });
      return { site: createdSite, run: createdRun, wasCreated: !existing };
    });

    if (run) {
      try {
        await this.demoLauncher.launchDemoV0({
          workspaceId: ctx.workspaceId,
          siteId: site.id,
          buildRunId: run.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`demo v0 launch failed for site ${site.id}: ${message}`);
        // R0-6：区分新建 vs 复用——
        //  · 新建站的同步 launch 失败（201 未返回、无既有用户数据）→ 整笔回滚删站（Codex P1：否则残留站撞 409）；
        //  · 复用的 setup_failed 站（用户数据已存在）→ **绝不删**，回置 setup_failed + run failed，待再次 re-intake。
        await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
          if (wasCreated) {
            await tx.site.delete({ where: { id: site.id } });
          } else {
            await tx.site.update({ where: { id: site.id }, data: { status: 'setup_failed' } });
            await tx.siteBuildRun.update({
              where: { id: run.id },
              data: { status: 'failed', error: message, finishedAt: new Date() },
            });
          }
        });
        const disposition = wasCreated ? 'intake rolled back' : 'site kept as setup_failed';
        throw new BadGatewayException(`demo v0 launch failed: ${message} (${disposition}, safe to retry)`);
      }
    }

    return { siteId: site.id, mode, status };
  }
}
