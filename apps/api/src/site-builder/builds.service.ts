import {
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
import {
  BuildScopeInput,
  REFURBISH_LAUNCHER,
  RefurbishLauncher,
  refurbishWorkflowId,
} from './refurbish-launcher';
import {
  buildRequestHash,
  normalizeBuildRequest,
} from './build-request-contract';
import { normalizeIdempotencyKey } from './idempotency-key';
import {
  assertActiveBuildTargets,
  BuildActiveSpecInvalidError,
  BuildTargetAmbiguousError,
  BuildTargetNotFoundError,
} from './build-scope';
import type { SiteSpec } from '@global/contracts';
import { terminalizeBuildProgress } from './build-progress';

/** 每站每日 run 上限（T5 资源闸雏形；ModelBroker 细粒度预算随 M1-b）。配错值 fail-closed 回默认。 */
const parsedDailyLimit = Number(process.env.SITE_BUILD_DAILY_LIMIT ?? 10);
const DAILY_BUILD_LIMIT =
  Number.isFinite(parsedDailyLimit) && parsedDailyLimit > 0
    ? parsedDailyLimit
    : 10;

export interface CreateBuildInput extends BuildScopeInput {
  idempotencyKey?: string | null;
}

const ACTIVE_STATUSES = ['queued', 'running'];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const BUILD_ENDPOINT = 'POST /api/v1/site-builder/sites/:id/builds';

type BuildErrorCode =
  | 'BUILD_IN_PROGRESS'
  | 'BUILD_NOT_CANCELLABLE'
  | 'BUILD_ALREADY_TERMINAL'
  | 'BUILD_LAUNCH_UNAVAILABLE'
  | 'BUILD_CANCEL_UNAVAILABLE'
  | 'BUILD_TARGET_NOT_FOUND'
  | 'BUILD_TARGET_AMBIGUOUS'
  | 'BUILD_ACTIVE_SPEC_INVALID'
  | 'QUOTA_EXCEEDED'
  | 'IDEMPOTENCY_KEY_REUSED';

function buildHttpError(
  status: HttpStatus,
  code: BuildErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  return new HttpException(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    status,
  );
}

function storedBuildId(value: Prisma.JsonValue): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.buildId !== 'string'
  ) {
    throw new Error('corrupt site-builder build idempotency response');
  }
  return value.buildId;
}

function sameStoredRequest(
  siteId: string,
  value: Prisma.JsonValue,
  request: ReturnType<typeof normalizeBuildRequest>,
): boolean {
  try {
    const stored = normalizeBuildRequest(value as unknown as BuildScopeInput);
    return (
      buildRequestHash(siteId, stored) === buildRequestHash(siteId, request)
    );
  } catch {
    return false;
  }
}

function storedBaseVersionId(value: Prisma.JsonValue | null): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return typeof value.baseVersionId === 'string' ? value.baseVersionId : undefined;
}

/**
 * 精装修构建 run（07 §5 / 09 §2.2）。同 site 单飞（02 §4）+ 当日配额 +
 * Idempotency-Key 以请求指纹重放。只有 Temporal workflowId + firstExecutionRunId
 * 持久化后才确认创建；ACK 不明时保留同一 run 供安全恢复，绝不误标 failed 或另起执行。
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
    const request = normalizeBuildRequest(input);
    const idempotencyKey = normalizeIdempotencyKey(
      input.idempotencyKey ?? undefined,
    );
    const endpoint = BUILD_ENDPOINT;
    const requestHash = idempotencyKey
      ? buildRequestHash(siteId, request)
      : undefined;

    const { run, replayed } = await this.prisma.withWorkspace(
      ctx.workspaceId,
      async (tx) => {
        // The ledger key is workspace-operation scoped, so requests for different Sites must
        // still serialize before checking/inserting the same key. Lock ordering is always
        // idempotency key first, then Site, avoiding cross-Site P2002 leaks and deadlocks.
        if (idempotencyKey) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-idem-${ctx.workspaceId}-${idempotencyKey}`}))`;
        }
        // 单飞/配额/幂等三查须原子（Codex P2 / 复审 C3）——advisory xact lock 串行化同站请求（intake 先例）
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-${siteId}`}))`;

        const site = await tx.site.findUnique({ where: { id: siteId } });
        if (!site) throw new NotFoundException('site not found');
        if (idempotencyKey) {
          const prior = await tx.idempotencyKey.findUnique({
            where: {
              workspaceId_endpoint_key: {
                workspaceId: ctx.workspaceId,
                endpoint,
                key: idempotencyKey,
              },
            },
          });
          if (prior) {
            if (
              prior.requestHash === null ||
              prior.requestHash !== requestHash
            ) {
              throw new ConflictException({
                error: {
                  code: 'IDEMPOTENCY_KEY_REUSED',
                  message:
                    'idempotency-key was already used with a different build request',
                },
              });
            }
            const existing = await tx.siteBuildRun.findUnique({
              where: { id: storedBuildId(prior.response) },
            });
            if (!existing || existing.siteId !== siteId) {
              throw new Error(
                'corrupt site-builder build idempotency reference',
              );
            }
            return { run: existing, replayed: true };
          }

          // A pre-R3 JSON-only key has no request fingerprint. Never guess that it is the same request.
          const legacy = await tx.siteBuildRun.findFirst({
            where: {
              scope: { path: ['idempotencyKey'], equals: idempotencyKey },
            },
          });
          if (legacy) {
            throw new ConflictException({
              error: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message:
                  'legacy idempotency-key cannot prove build request identity',
              },
            });
          }
        }

        // A durable idempotency replay above is independent of today's active pointer. Only a
        // genuinely new partial request validates the current active SiteSpec.
        let baseVersionId: string | undefined;
        if (request.scope !== 'site' || request.options?.pages) {
          const active = site.activeVersionId
            ? await tx.siteVersion.findFirst({
                where: {
                  id: site.activeVersionId,
                  siteId,
                  buildStatus: 'succeeded',
                },
                select: { id: true, spec: true },
              })
            : null;
          try {
            assertActiveBuildTargets(
              (active?.spec ?? null) as unknown as SiteSpec | null,
              request,
            );
          } catch (error) {
            if (error instanceof BuildTargetNotFoundError) {
              throw buildHttpError(
                HttpStatus.NOT_FOUND,
                'BUILD_TARGET_NOT_FOUND',
                error.message,
              );
            }
            if (error instanceof BuildTargetAmbiguousError) {
              throw buildHttpError(
                HttpStatus.UNPROCESSABLE_ENTITY,
                'BUILD_TARGET_AMBIGUOUS',
                error.message,
              );
            }
            if (error instanceof BuildActiveSpecInvalidError) {
              throw buildHttpError(
                HttpStatus.UNPROCESSABLE_ENTITY,
                'BUILD_ACTIVE_SPEC_INVALID',
                error.message,
              );
            }
            throw error;
          }
          baseVersionId = active?.id;
        }

        const active = await tx.siteBuildRun.findFirst({
          where: { siteId, status: { in: ACTIVE_STATUSES } },
        });
        if (active) {
          // A no-key request can still repair its own ambiguous start by presenting the
          // exact normalized request. Deterministic workflow identity prevents a second execution.
          if (
            !idempotencyKey &&
            active.status === 'queued' &&
            !active.temporalWorkflowId &&
            !active.temporalRunId &&
            sameStoredRequest(siteId, active.scope, request)
          ) {
            return { run: active, replayed: true };
          }
          throw buildHttpError(
            HttpStatus.CONFLICT,
            'BUILD_IN_PROGRESS',
            'a build is already in progress for this site',
            { buildId: active.id, status: active.status },
          );
        }

        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0); // 配额窗口 UTC 化，不随进程 TZ 漂移
        const todayCount = await tx.siteBuildRun.count({
          where: {
            siteId,
            createdAt: { gte: startOfDay },
            NOT: { status: 'failed', temporalRunId: null },
          },
        });
        if (todayCount >= DAILY_BUILD_LIMIT) {
          throw buildHttpError(
            HttpStatus.TOO_MANY_REQUESTS,
            'QUOTA_EXCEEDED',
            `daily build quota reached (${DAILY_BUILD_LIMIT}/day)`,
            { remaining: Math.max(0, DAILY_BUILD_LIMIT - todayCount) },
          );
        }

        let created: SiteBuildRun;
        try {
          created = await tx.siteBuildRun.create({
            data: {
              workspaceId: ctx.workspaceId,
              siteId,
              kind: 'refurbish',
              status: 'queued',
              scope: {
                ...request,
                ...(baseVersionId ? { baseVersionId } : {}),
              } as unknown as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw buildHttpError(
              HttpStatus.CONFLICT,
              'BUILD_IN_PROGRESS',
              'a build became active concurrently for this site',
            );
          }
          throw error;
        }
        if (idempotencyKey) {
          await tx.idempotencyKey.create({
            data: {
              workspaceId: ctx.workspaceId,
              endpoint,
              key: idempotencyKey,
              requestHash: requestHash!,
              response: { buildId: created.id, status: 'queued' },
            },
          });
        }
        return { run: created, replayed: false };
      },
    );

    const expectedWorkflowId = refurbishWorkflowId(run.id);
    if (
      run.temporalWorkflowId &&
      run.temporalWorkflowId !== expectedWorkflowId
    ) {
      throw buildHttpError(
        HttpStatus.BAD_GATEWAY,
        'BUILD_LAUNCH_UNAVAILABLE',
        'stored build workflow identity is invalid',
        { buildId: run.id },
      );
    }
    if (run.temporalWorkflowId && run.temporalRunId) {
      return { buildId: run.id, status: run.status };
    }

    const baseVersionId = storedBaseVersionId(run.scope);
    const launchInput = {
      workspaceId: ctx.workspaceId,
      siteId,
      buildRunId: run.id,
      scope: {
        ...request,
        ...(baseVersionId ? { baseVersionId } : {}),
      },
    };
    let launch: { workflowId: string; firstExecutionRunId: string };
    try {
      launch =
        replayed && run.status !== 'queued'
          ? await this.launcher.recoverRefurbish(launchInput)
          : await this.launcher.launchRefurbish(launchInput);
    } catch (startError) {
      try {
        launch = await this.launcher.recoverRefurbish(launchInput);
      } catch {
        this.log.error(
          `refurbish ACK unavailable for run ${run.id}: BUILD_LAUNCH_UNAVAILABLE`,
        );
        throw buildHttpError(
          HttpStatus.BAD_GATEWAY,
          'BUILD_LAUNCH_UNAVAILABLE',
          idempotencyKey
            ? 'build orchestrator acknowledgement unavailable; retry with the same idempotency-key'
            : 'build launch acknowledgement unavailable; inspect this build before retrying',
          { buildId: run.id },
        );
      }
      void startError;
    }

    if (launch.workflowId !== expectedWorkflowId) {
      this.log.error(
        `refurbish launcher returned an invalid workflow identity for run ${run.id}`,
      );
      throw buildHttpError(
        HttpStatus.BAD_GATEWAY,
        'BUILD_LAUNCH_UNAVAILABLE',
        'build orchestrator returned an invalid workflow identity',
        { buildId: run.id },
      );
    }

    try {
      const acknowledged = await this.prisma.withWorkspace(
        ctx.workspaceId,
        async (tx) => {
          const current = await tx.siteBuildRun.findUnique({
            where: { id: run.id },
          });
          if (!current || current.siteId !== siteId) return null;
          if (
            (current.temporalWorkflowId &&
              current.temporalWorkflowId !== launch.workflowId) ||
            (current.temporalRunId &&
              current.temporalRunId !== launch.firstExecutionRunId)
          ) {
            return null;
          }
          await tx.siteBuildRun.update({
            where: { id: run.id },
            data: {
              temporalWorkflowId: launch.workflowId,
              temporalRunId: launch.firstExecutionRunId,
            },
          });
          return current.status;
        },
      );
      if (!acknowledged)
        throw new Error('build launch acknowledgement conflict');
      return { buildId: run.id, status: acknowledged };
    } catch {
      this.log.error(
        `refurbish ACK persistence failed for run ${run.id}: BUILD_ACK_UNAVAILABLE`,
      );
      throw buildHttpError(
        HttpStatus.BAD_GATEWAY,
        'BUILD_LAUNCH_UNAVAILABLE',
        idempotencyKey
          ? 'build acknowledgement unavailable; retry with the same idempotency-key'
          : 'build acknowledgement unavailable; inspect this build before retrying',
        { buildId: run.id },
      );
    }
  }

  async get(ctx: RequestContext, buildId: string): Promise<SiteBuildRun> {
    const run = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: buildId } }),
    );
    if (!run) throw new NotFoundException('build not found');
    return run;
  }

  async cancel(
    ctx: RequestContext,
    buildId: string,
  ): Promise<{ buildId: string; status: string }> {
    const cancellable = await this.prisma.withWorkspace(
      ctx.workspaceId,
      async (tx) => {
        const run = await tx.siteBuildRun.findUnique({
          where: { id: buildId },
        });
        if (!run) throw new NotFoundException('build not found');
        if (run.kind !== 'refurbish') {
          // demo_v0 秒级完成且无 site-refurbish-* workflow 可取消（复审 C2 附带）
          throw buildHttpError(
            HttpStatus.CONFLICT,
            'BUILD_NOT_CANCELLABLE',
            'this build type cannot be cancelled',
            { kind: run.kind },
          );
        }
        if (TERMINAL_STATUSES.has(run.status)) {
          throw buildHttpError(
            HttpStatus.CONFLICT,
            'BUILD_ALREADY_TERMINAL',
            'build is already terminal',
            { status: run.status },
          );
        }
        const expectedWorkflowId = refurbishWorkflowId(run.id);
        if (
          run.temporalWorkflowId &&
          run.temporalWorkflowId !== expectedWorkflowId
        ) {
          throw buildHttpError(
            HttpStatus.CONFLICT,
            'BUILD_NOT_CANCELLABLE',
            'stored build workflow identity is invalid',
            { buildId: run.id },
          );
        }
        return { workflowId: run.temporalWorkflowId, siteId: run.siteId };
      },
    );
    let cancellation: Awaited<ReturnType<RefurbishLauncher['cancelRefurbish']>>;
    try {
      cancellation = await this.launcher.cancelRefurbish(
        buildId,
        cancellable.workflowId,
      );
    } catch {
      const terminal = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.siteBuildRun.findUnique({ where: { id: buildId } }),
      );
      if (terminal?.status === 'cancelled') {
        return { buildId, status: 'cancelled' };
      }
      if (terminal && TERMINAL_STATUSES.has(terminal.status)) {
        throw buildHttpError(
          HttpStatus.CONFLICT,
          'BUILD_ALREADY_TERMINAL',
          'build became terminal before cancellation completed',
          { status: terminal.status },
        );
      }
      this.log.error(
        `cancelRefurbish acknowledgement failed for ${buildId}: BUILD_CANCEL_UNAVAILABLE`,
      );
      // Keep the DB run active. The launcher only resolves after the execution chain closes;
      // any transport, timeout or non-cancellation terminal error remains fail-closed here.
      throw buildHttpError(
        HttpStatus.BAD_GATEWAY,
        'BUILD_CANCEL_UNAVAILABLE',
        'build cancellation was not acknowledged; retry cancellation with the same buildId',
        { buildId },
      );
    }

    const current = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: buildId } }),
    );
    if (current?.status === 'cancelled') {
      return { buildId, status: 'cancelled' };
    }
    if (current && TERMINAL_STATUSES.has(current.status)) {
      throw buildHttpError(
        HttpStatus.CONFLICT,
        'BUILD_ALREADY_TERMINAL',
        'build became terminal before cancellation completed',
        { status: current.status },
      );
    }
    if (
      current &&
      ACTIVE_STATUSES.includes(current.status) &&
      cancellation.terminalStatus !== 'completed'
    ) {
      // Temporal is conclusively closed, but its compensation exhausted retries while DB was
      // unavailable. Redrive the minimal terminal transaction under the same Site lock; an
      // executing/unknown chain never reaches this branch and therefore never releases single-flight.
      const repairedStatus =
        cancellation.terminalStatus === 'cancelled' ? 'cancelled' : 'failed';
      let repaired: SiteBuildRun | null;
      try {
        repaired = await this.prisma.withWorkspace(
          ctx.workspaceId,
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildId}`}))`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-${cancellable.siteId}`}))`;
            const before = await tx.siteBuildRun.findUnique({
              where: { id: buildId },
            });
            await tx.siteVersion.updateMany({
              where: { buildRunId: buildId, buildStatus: 'building' },
              data: { buildStatus: 'failed' },
            });
            const transitioned = await tx.siteBuildRun.updateMany({
              where: { id: buildId, status: { in: ACTIVE_STATUSES } },
              data: {
                status: repairedStatus,
                error:
                  repairedStatus === 'failed'
                    ? 'workflow failed after compensation retries were exhausted'
                    : null,
                finishedAt: new Date(),
              },
            });
            if (transitioned.count === 1) {
              const terminalSteps = await terminalizeBuildProgress(tx, {
                workspaceId: ctx.workspaceId,
                buildRunId: buildId,
                phase: (before?.phase ?? 'P1_understanding') as Parameters<
                  typeof terminalizeBuildProgress
                >[1]['phase'],
                progress: before?.progress ?? 0,
              });
              await tx.siteBuildRun.update({
                where: { id: buildId },
                data: { steps: terminalSteps },
              });
              const site = await tx.site.findUnique({
                where: { id: cancellable.siteId },
              });
              if (site) {
                await tx.site.update({
                  where: { id: site.id },
                  data: { status: site.activeVersionId ? 'ready' : 'draft' },
                });
              }
            }
            return tx.siteBuildRun.findUnique({ where: { id: buildId } });
          },
        );
      } catch {
        throw buildHttpError(
          HttpStatus.BAD_GATEWAY,
          'BUILD_CANCEL_UNAVAILABLE',
          'closed build compensation is not yet durable; retry cancellation with the same buildId',
          { buildId },
        );
      }
      if (repaired?.status === 'cancelled') {
        return { buildId, status: 'cancelled' };
      }
      if (repaired && TERMINAL_STATUSES.has(repaired.status)) {
        throw buildHttpError(
          HttpStatus.CONFLICT,
          'BUILD_ALREADY_TERMINAL',
          'build execution closed before cancellation completed',
          { status: repaired.status },
        );
      }
    }
    // A completed chain with an active DB row is an invariant violation, not safe to guess.
    throw buildHttpError(
      HttpStatus.BAD_GATEWAY,
      'BUILD_CANCEL_UNAVAILABLE',
      'build cancellation closed without durable compensation; retry cancellation with the same buildId',
      { buildId },
    );
  }
}
