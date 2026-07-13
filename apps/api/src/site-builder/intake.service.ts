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
 * 无站 → mode=builder，建 demo_v0 run 并触发 Temporal；有站 → mode=diagnosis（M3 分支只建档）。
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
    const mode = input.hasWebsite ? 'diagnosis' : 'builder';
    const status = mode === 'builder' ? 'building' : 'draft';
    const nameEn = input.company.nameEn?.trim() || null;

    const { site, run } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      // Codex P2：advisory xact lock 关闭双请求并发窗口——「每 workspace 限 1 站」原子成立
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-intake-${ctx.workspaceId}`}))`;
      const existing = await tx.site.findFirst({
        where: { workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException('workspace already has a site (v1 limit: 1 per workspace)');
      }
      const createdSite = await tx.site.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: nameEn ?? input.company.nameZh,
          slug: makeSlug(nameEn),
          mode,
          status,
          locales: ['en'] satisfies string[] as unknown as Prisma.InputJsonValue,
          intake: input as unknown as Prisma.InputJsonValue,
        },
      });
      if (mode !== 'builder') return { site: createdSite, run: null };
      const createdRun = await tx.siteBuildRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          siteId: createdSite.id,
          kind: 'demo_v0',
          status: 'queued',
        },
      });
      return { site: createdSite, run: createdRun };
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
        // Codex P1：补偿回滚（site 级联删 run）——否则残留站点让重试永远撞 409，注册卡死
        await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
          await tx.site.delete({ where: { id: site.id } });
        });
        throw new BadGatewayException(`demo v0 launch failed: ${message} (intake rolled back, safe to retry)`);
      }
    }

    return { siteId: site.id, mode, status };
  }
}
