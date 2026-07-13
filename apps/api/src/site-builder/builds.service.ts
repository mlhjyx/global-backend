import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SiteBuildRun } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { BuildScopeInput, REFURBISH_LAUNCHER, RefurbishLauncher } from './refurbish-launcher';

/** 每站每日 run 上限（T5 资源闸雏形；ModelBroker 细粒度预算随 M1-b）。配错值 fail-closed 回默认。 */
const parsedDailyLimit = Number(process.env.SITE_BUILD_DAILY_LIMIT ?? 10);
const DAILY_BUILD_LIMIT =
  Number.isFinite(parsedDailyLimit) && parsedDailyLimit > 0 ? parsedDailyLimit : 10;

export interface CreateBuildInput extends BuildScopeInput {
  idempotencyKey?: string | null;
}

const ACTIVE_STATUSES = ['queued', 'running'];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * 精装修构建 run（07 §5 / 09 §2.2）。同 site 单飞（02 §4）+ 当日配额 +
 * Idempotency-Key 重放。launcher 失败=run 落 failed + 502——🔴 与 demo_v0 相反，
 * 绝不删用户站点（站点先于本次构建存在）。
 */
@Injectable()
export class BuildsService {
  private readonly log = new Logger(BuildsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REFURBISH_LAUNCHER) private readonly launcher: RefurbishLauncher,
  ) {}

  async create(
    ctx: RequestContext,
    siteId: string,
    input: CreateBuildInput,
  ): Promise<{ buildId: string; status: string }> {
    if ((input.scope === 'page' || input.scope === 'section') && !input.targetId) {
      throw new BadRequestException(`scope=${input.scope} requires targetId`);
    }

    const { run, replayed } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      // 单飞/配额/幂等三查须原子（Codex P2 / 复审 C3）——advisory xact lock 串行化同站请求（intake 先例）
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-${siteId}`}))`;

      const site = await tx.site.findUnique({ where: { id: siteId } });
      if (!site) throw new NotFoundException('site not found');

      if (input.idempotencyKey) {
        // failed（含 launch 失败）不参与重放（复审 C4）：502 说 safe to retry，同 key 重试必须能真正重发
        const existing = await tx.siteBuildRun.findFirst({
          where: {
            siteId,
            scope: { path: ['idempotencyKey'], equals: input.idempotencyKey },
            NOT: { status: 'failed' },
          },
        });
        if (existing) return { run: existing, replayed: true };
      }

      const active = await tx.siteBuildRun.findFirst({
        where: { siteId, status: { in: ACTIVE_STATUSES } },
      });
      if (active) throw new ConflictException('a build is already in progress for this site');

      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0); // 配额窗口 UTC 化，不随进程 TZ 漂移
      const todayCount = await tx.siteBuildRun.count({
        where: { siteId, createdAt: { gte: startOfDay } },
      });
      if (todayCount >= DAILY_BUILD_LIMIT) {
        throw new HttpException(
          {
            error: {
              code: 'QUOTA_EXCEEDED',
              message: `daily build quota reached (${DAILY_BUILD_LIMIT}/day)`,
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const created = await tx.siteBuildRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          siteId,
          kind: 'refurbish',
          status: 'queued',
          scope: {
            scope: input.scope,
            targetId: input.targetId ?? null,
            options: (input.options ?? {}) as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return { run: created, replayed: false };
    });

    if (replayed) return { buildId: run.id, status: run.status };

    try {
      await this.launcher.launchRefurbish({
        workspaceId: ctx.workspaceId,
        siteId,
        buildRunId: run.id,
        scope: { scope: input.scope, targetId: input.targetId ?? null, options: input.options },
      });
    } catch (err) {
      // 站点不动（🔴 refurbish 补偿边界）；run 落 failed，用户可直接重试。
      // 原始错误只进日志；落库/回给租户用泛化文案，不泄内网细节（复审 C6）
      this.log.error(`launchRefurbish failed for run ${run.id}: ${String(err)}`);
      await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        await tx.siteBuildRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            error: 'launch failed: orchestrator unavailable',
            finishedAt: new Date(),
          },
        });
      });
      throw new BadGatewayException('build orchestrator unavailable, safe to retry');
    }

    return { buildId: run.id, status: run.status };
  }

  async get(ctx: RequestContext, buildId: string): Promise<SiteBuildRun> {
    const run = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: buildId } }),
    );
    if (!run) throw new NotFoundException('build not found');
    return run;
  }

  async cancel(ctx: RequestContext, buildId: string): Promise<{ buildId: string; status: string }> {
    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const run = await tx.siteBuildRun.findUnique({ where: { id: buildId } });
      if (!run) throw new NotFoundException('build not found');
      if (run.kind !== 'refurbish') {
        // demo_v0 秒级完成且无 site-refurbish-* workflow 可取消（复审 C2 附带）
        throw new ConflictException(`${run.kind} runs cannot be cancelled`);
      }
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new ConflictException(`build already ${run.status}`);
      }
      await tx.siteBuildRun.update({
        where: { id: buildId },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    });
    try {
      await this.launcher.cancelRefurbish(buildId);
    } catch (err) {
      this.log.warn(`cancelRefurbish best-effort failed for ${buildId}: ${String(err)}`);
    }
    return { buildId, status: 'cancelled' };
  }
}
