import { createHash } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { DEMO_V0_LAUNCHER, DemoV0Launcher } from "./demo-launcher";
import { makeSlug } from "./slug";

/** 注册引导 6 项（01 §3.1）。DTO 层已校验形状，此处保留业务不变式。 */
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
  buildId: string;
  status: "generating_demo";
}

const INTAKE_ENDPOINT = "POST /api/v1/site-builder/intake";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function structuredError(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function normalizeIdempotencyKey(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException(
      structuredError(
        "INVALID_IDEMPOTENCY_KEY",
        "idempotency-key must contain 1–128 letters, digits, dots, underscores, colons, or hyphens",
      ),
    );
  }
  return normalized;
}

/**
 * Hash the semantic intake shape, not JavaScript object insertion order or raw HTTP bytes.
 * Optional fields normalize to null; array order is retained because it is user-authored ordering.
 */
export function intakeRequestHash(input: IntakeInput): string {
  const canonical = {
    company: {
      nameZh: input.company.nameZh,
      nameEn: input.company.nameEn ?? null,
    },
    industry: input.industry,
    products: input.products,
    targetMarkets: input.targetMarkets,
    hasWebsite: input.hasWebsite,
    websiteUrl: input.websiteUrl ?? null,
    businessEmail: input.businessEmail,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function storedIntakeResult(value: Prisma.JsonValue): IntakeResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.siteId !== "string" ||
    typeof value.buildId !== "string" ||
    value.status !== "generating_demo"
  ) {
    throw new Error("corrupt site-builder intake idempotency response");
  }
  return {
    siteId: value.siteId,
    buildId: value.buildId,
    status: value.status,
  };
}

/**
 * 注册引导 → 建档 + demo v0。hasWebsite 只作理解背景，不分叉；所有成功响应都已取得并
 * 持久化 Temporal execution-chain ACK。带 key 的 ACK 不确定失败保留账本，靠同 key 安全修复。
 */
@Injectable()
export class IntakeService {
  private readonly log = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DEMO_V0_LAUNCHER) private readonly demoLauncher: DemoV0Launcher,
  ) {}

  private async persistTemporalAck(
    workspaceId: string,
    buildId: string,
    firstExecutionRunId: string,
  ): Promise<void> {
    const acknowledged = await this.prisma.withWorkspace(
      workspaceId,
      async (tx) => {
        const updated = await tx.siteBuildRun.updateMany({
          where: { id: buildId, temporalRunId: null },
          data: { temporalRunId: firstExecutionRunId },
        });
        if (updated.count === 1) return true;

        // A concurrent replay may have persisted the same ACK first. A missing row or a different
        // execution id is not success: never return 201 without durable proof of this workflow.
        const current = await tx.siteBuildRun.findUnique({
          where: { id: buildId },
          select: { temporalRunId: true },
        });
        return current?.temporalRunId === firstExecutionRunId;
      },
    );
    if (!acknowledged)
      throw new Error("demo launch acknowledgement was not persisted");
  }

  private unavailable(hasIdempotencyKey: boolean): BadGatewayException {
    return new BadGatewayException(
      structuredError(
        "DEMO_LAUNCH_UNAVAILABLE",
        hasIdempotencyKey
          ? "demo orchestrator acknowledgement unavailable; retry with the same idempotency-key"
          : "demo launch acknowledgement unavailable; inspect the workspace site before retrying",
      ),
    );
  }

  async create(
    ctx: RequestContext,
    input: IntakeInput,
    rawIdempotencyKey?: string,
  ): Promise<IntakeResult> {
    if (input.hasWebsite && !input.websiteUrl) {
      throw new BadRequestException(
        structuredError(
          "VALIDATION_ERROR",
          "websiteUrl is required when hasWebsite=true",
        ),
      );
    }

    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    const requestHash = idempotencyKey ? intakeRequestHash(input) : undefined;
    const nameEn = input.company.nameEn?.trim() || null;

    const prepared = await this.prisma.withWorkspace(
      ctx.workspaceId,
      async (tx) => {
        // 同 workspace 的“幂等查/一站限制/建站/建 run/写 response”必须原子串行。
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-intake-${ctx.workspaceId}`}))`;

        if (idempotencyKey) {
          const prior = await tx.idempotencyKey.findUnique({
            where: {
              workspaceId_endpoint_key: {
                workspaceId: ctx.workspaceId,
                endpoint: INTAKE_ENDPOINT,
                key: idempotencyKey,
              },
            },
          });
          if (prior) {
            // This lookup is already scoped to the intake endpoint. A NULL legacy fingerprint cannot
            // prove request identity, so fail closed; other legacy endpoints remain unaffected.
            if (
              prior.requestHash === null ||
              prior.requestHash !== requestHash
            ) {
              throw new ConflictException(
                structuredError(
                  "IDEMPOTENCY_KEY_REUSED",
                  "idempotency-key was already used with a different request",
                ),
              );
            }
            const response = storedIntakeResult(prior.response);
            const run = await tx.siteBuildRun.findUnique({
              where: { id: response.buildId },
              select: {
                id: true,
                siteId: true,
                status: true,
                temporalRunId: true,
              },
            });
            if (!run || run.siteId !== response.siteId) {
              throw new Error(
                "corrupt site-builder intake idempotency reference",
              );
            }
            return { response, run, wasCreated: false };
          }
        }

        const existing = await tx.site.findFirst({
          where: { workspaceId: ctx.workspaceId },
          select: { id: true, status: true },
        });
        if (existing) {
          // Share the same per-site lock as POST /sites/:id/builds. A setup_failed re-intake
          // must not race a refurbish request into two active runs for one Site.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-${existing.id}`}))`;
          const active = await tx.siteBuildRun.findFirst({
            where: { siteId: existing.id, status: { in: ['queued', 'running'] } },
            select: { id: true },
          });
          if (active) {
            throw new ConflictException(
              structuredError('SITE_LIMIT_REACHED', 'workspace site already has an active build'),
            );
          }
        }
        // setup_failed 是异步终态失败留痕；新请求（通常新 key）在同一 Site 上重建 run。
        if (existing && existing.status !== "setup_failed") {
          throw new ConflictException(
            structuredError(
              "SITE_LIMIT_REACHED",
              "workspace already has a site (v1 limit: 1)",
            ),
          );
        }

        const shared = {
          name: nameEn ?? input.company.nameZh,
          mode: "builder",
          status: "building",
          locales: [
            "en",
          ] satisfies string[] as unknown as Prisma.InputJsonValue,
          intake: input as unknown as Prisma.InputJsonValue,
        };
        const site = existing
          ? await tx.site.update({ where: { id: existing.id }, data: shared })
          : await tx.site.create({
              data: {
                workspaceId: ctx.workspaceId,
                slug: makeSlug(nameEn),
                ...shared,
              },
            });
        const run = await tx.siteBuildRun.create({
          data: {
            workspaceId: ctx.workspaceId,
            siteId: site.id,
            kind: "demo_v0",
            status: "queued",
          },
        });
        const response: IntakeResult = {
          siteId: site.id,
          buildId: run.id,
          status: "generating_demo",
        };

        if (idempotencyKey) {
          await tx.idempotencyKey.create({
            data: {
              workspaceId: ctx.workspaceId,
              endpoint: INTAKE_ENDPOINT,
              key: idempotencyKey,
              requestHash: requestHash!,
              response: response as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return { response, run, wasCreated: !existing };
      },
    );

    // Only a persisted Temporal execution-chain id is a complete 201 proof.
    if (prepared.run.temporalRunId) return prepared.response;

    const launchInput = {
      workspaceId: ctx.workspaceId,
      siteId: prepared.response.siteId,
      buildRunId: prepared.response.buildId,
    };

    if (prepared.run.status !== "queued") {
      // The workflow demonstrably progressed, but the HTTP→DB ACK may have been lost. Never start a
      // terminal/running build again: describe the deterministic workflow and repair only its ACK.
      try {
        const recovered = await this.demoLauncher.recoverDemoV0(launchInput);
        await this.persistTemporalAck(
          ctx.workspaceId,
          prepared.response.buildId,
          recovered.firstExecutionRunId,
        );
        return prepared.response;
      } catch {
        this.log.error(
          `demo v0 ACK recovery failed for build ${prepared.response.buildId}: DEMO_ACK_RECOVERY_UNAVAILABLE`,
        );
        throw this.unavailable(Boolean(idempotencyKey));
      }
    }

    let launch: { firstExecutionRunId: string };
    try {
      launch = await this.demoLauncher.launchDemoV0(launchInput);
    } catch {
      this.log.error(
        `demo v0 launch failed for build ${prepared.response.buildId}: DEMO_LAUNCH_UNAVAILABLE`,
      );

      if (idempotencyKey) {
        // The workflow may already exist. Keep Site/run/key queued; retrying the same key invokes the
        // same deterministic workflowId and repairs temporalRunId without duplicating a build.
        throw this.unavailable(true);
      }

      // Without a key the caller cannot prove request identity across retries, so retain the existing
      // M0 compensation boundary: new Site is removed; reused user data is kept as setup_failed.
      await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        if (prepared.wasCreated) {
          await tx.site.delete({ where: { id: prepared.response.siteId } });
        } else {
          await tx.site.update({
            where: { id: prepared.response.siteId },
            data: { status: "setup_failed" },
          });
          await tx.siteBuildRun.update({
            where: { id: prepared.response.buildId },
            data: {
              status: "failed",
              error: "launch failed: orchestrator unavailable",
              finishedAt: new Date(),
            },
          });
        }
      });
      throw this.unavailable(false);
    }

    try {
      // 201 is not returned until the Temporal execution-chain head is durable in our DB. Once
      // start returned successfully, however, compensation must never delete its Site/run: the
      // workflow is already live and may still complete while a transient DB ACK write is retried.
      await this.persistTemporalAck(
        ctx.workspaceId,
        prepared.response.buildId,
        launch.firstExecutionRunId,
      );
      return prepared.response;
    } catch {
      this.log.error(
        `demo v0 ACK persistence failed for build ${prepared.response.buildId}: DEMO_ACK_PERSIST_UNAVAILABLE`,
      );
      throw this.unavailable(Boolean(idempotencyKey));
    }
  }
}
