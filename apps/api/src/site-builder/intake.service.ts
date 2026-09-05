import { createHash } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  HttpStatus,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { DEMO_V0_LAUNCHER, DemoV0Launcher } from "./demo-launcher";
import { makeSlug } from "./slug";
import {
  assertBudgetGrantConsumable,
  isBudgetGrantExpiredStorageError,
  SiteBuildBudgetGrantError,
  type VerifiedSiteBuildBudgetGrant,
} from "./site-build-budget-grant";
import { SiteBuildRuntimeGuard } from "../runtime/site-build-runtime.guard";

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

function storedIntakeMatches(
  value: Prisma.JsonValue,
  expectedHash: string,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const company = value.company;
  if (
    typeof company !== "object" ||
    company === null ||
    Array.isArray(company) ||
    typeof company.nameZh !== "string" ||
    !(
      company.nameEn === undefined ||
      company.nameEn === null ||
      typeof company.nameEn === "string"
    ) ||
    typeof value.industry !== "string" ||
    !Array.isArray(value.products) ||
    !value.products.every((item) => typeof item === "string") ||
    !Array.isArray(value.targetMarkets) ||
    !value.targetMarkets.every((item) => typeof item === "string") ||
    typeof value.hasWebsite !== "boolean" ||
    !(
      value.websiteUrl === undefined ||
      value.websiteUrl === null ||
      typeof value.websiteUrl === "string"
    ) ||
    typeof value.businessEmail !== "string"
  ) {
    return false;
  }

  return (
    intakeRequestHash({
      company: {
        nameZh: company.nameZh,
        nameEn: company.nameEn,
      },
      industry: value.industry,
      products: value.products,
      targetMarkets: value.targetMarkets,
      hasWebsite: value.hasWebsite,
      websiteUrl: value.websiteUrl,
      businessEmail: value.businessEmail,
    }) === expectedHash
  );
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
    private readonly runtimeGuard: SiteBuildRuntimeGuard,
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
    budgetGrant?: VerifiedSiteBuildBudgetGrant,
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
    const requestHash = intakeRequestHash(input);
    if (!budgetGrant) {
      throw new SiteBuildBudgetGrantError(
        "BUDGET_GRANT_REQUIRED",
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (
      budgetGrant.workspaceId !== ctx.workspaceId ||
      budgetGrant.siteId !== null ||
      budgetGrant.operation !== "intake" ||
      budgetGrant.requestSha256 !== requestHash
    ) {
      throw new SiteBuildBudgetGrantError(
        "BUDGET_GRANT_SCOPE_MISMATCH",
        HttpStatus.FORBIDDEN,
      );
    }
    const readinessFailure = await this.runtimeGuard
      .assertReady({ paidReachable: false })
      .then(() => null)
      .catch((error: unknown) => error);
    const nameEn = input.company.nameEn?.trim() || null;

    const prepared = await this.prisma.withWorkspace(
      ctx.workspaceId,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-grant-${budgetGrant.issuer}-${budgetGrant.jti}`}))`;
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
            const [existingGrant, existingBudget] = await Promise.all([
              tx.siteBuildBudgetGrant.findUnique({
                where: { buildRunId: run.id },
              }),
              tx.siteBuildBudget.findUnique({
                where: { buildRunId: run.id },
              }),
            ]);
            if (!existingGrant || !existingBudget) {
              throw new Error(
                "intake idempotency reference has no spending authority",
              );
            }
            const exactConsumedGrant =
              existingGrant.issuer === budgetGrant.issuer &&
              existingGrant.jti === budgetGrant.jti;
            if (exactConsumedGrant) {
              if (existingGrant.tokenSha256 !== budgetGrant.tokenSha256) {
                throw new ConflictException(
                  structuredError(
                    "BUDGET_GRANT_REUSED",
                    "budget grant was already consumed with a different token",
                  ),
                );
              }
            } else {
              // Do not let an old Idempotency-Key turn an unconsumed expired
              // Grant into an accepted authorization. Only the exact consumed
              // token digest has post-expiry replay semantics.
              assertBudgetGrantConsumable(budgetGrant);
            }
            return {
              response,
              run,
            };
          }
        }

        const consumedGrant = await tx.siteBuildBudgetGrant.findUnique({
          where: {
            issuer_jti: {
              issuer: budgetGrant.issuer,
              jti: budgetGrant.jti,
            },
          },
        });
        if (consumedGrant) {
          if (
            consumedGrant.tokenSha256 !== budgetGrant.tokenSha256 ||
            consumedGrant.workspaceId !== ctx.workspaceId ||
            consumedGrant.operation !== "intake" ||
            consumedGrant.requestSha256 !== requestHash
          ) {
            throw new ConflictException(
              structuredError(
                "BUDGET_GRANT_REUSED",
                "budget grant was already consumed by a different intake request",
              ),
            );
          }
          const run = await tx.siteBuildRun.findUnique({
            where: { id: consumedGrant.buildRunId },
            select: {
              id: true,
              siteId: true,
              status: true,
              temporalRunId: true,
            },
          });
          if (!run)
            throw new Error("budget grant references a missing intake build");
          return {
            response: {
              siteId: run.siteId,
              buildId: run.id,
              status: "generating_demo" as const,
            },
            run,
          };
        }
        if (readinessFailure) throw readinessFailure;
        assertBudgetGrantConsumable(budgetGrant);

        // SaaS owns tenant identity; this backend materializes only the FK
        // anchor. Site Builder may be the first write for a freshly issued
        // workspace token, so provision it in the same transaction before
        // CompanyProfile, but only after replay and runtime-readiness gates.
        await tx.workspace.upsert({
          where: { id: ctx.workspaceId },
          update: {},
          create: { id: ctx.workspaceId },
        });

        const existing = await tx.site.findFirst({
          where: { workspaceId: ctx.workspaceId },
          select: {
            id: true,
            status: true,
            companyProfileId: true,
            intake: true,
          },
        });
        if (existing?.status === "setup_failed" && !existing.companyProfileId) {
          // R4-A2: mutable intake/display names are not identity. A historical Site without an
          // explicit tenant-scoped CompanyProfile edge must be repaired through an audited path.
          throw new ConflictException(
            structuredError(
              "SITE_COMPANY_PROFILE_LINK_REQUIRED",
              "site has no verified company profile link",
            ),
          );
        }
        if (existing) {
          // Share the same per-site lock as POST /sites/:id/builds. A setup_failed re-intake
          // must not race a refurbish request into two active runs for one Site.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-${existing.id}`}))`;
          const active = await tx.siteBuildRun.findFirst({
            where: {
              siteId: existing.id,
              status: { in: ["queued", "running"] },
            },
            select: {
              id: true,
              siteId: true,
              kind: true,
              status: true,
              temporalRunId: true,
            },
          });
          if (active) {
            // An unkeyed request has no client replay identity, but the persisted intake plus the
            // single active demo run provide a safe server-side recovery key. Reuse only an exact
            // semantic replay whose Temporal ACK is still unknown; all other active builds fail closed.
            if (
              !idempotencyKey &&
              active.kind === "demo_v0" &&
              active.temporalRunId === null &&
              storedIntakeMatches(existing.intake, requestHash)
            ) {
              return {
                response: {
                  siteId: existing.id,
                  buildId: active.id,
                  status: "generating_demo" as const,
                },
                run: active,
              };
            }
            throw new ConflictException(
              structuredError(
                "SITE_LIMIT_REACHED",
                "workspace site already has an active build",
              ),
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

        const companyProfile = existing
          ? null
          : await tx.companyProfile.create({
              data: {
                workspaceId: ctx.workspaceId,
                name: nameEn ?? input.company.nameZh,
                website: input.hasWebsite ? input.websiteUrl : null,
                industry: input.industry,
                status: "DRAFT",
              },
              select: { id: true },
            });
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
                companyProfileId: companyProfile!.id,
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
        try {
          await tx.siteBuildBudgetGrant.create({
            data: {
              workspaceId: ctx.workspaceId,
              siteId: site.id,
              buildRunId: run.id,
              issuer: budgetGrant.issuer,
              audience: budgetGrant.audience,
              jti: budgetGrant.jti,
              schemaVersion: budgetGrant.schemaVersion,
              purpose: budgetGrant.purpose,
              operation: budgetGrant.operation,
              requestSha256: budgetGrant.requestSha256,
              tokenSha256: budgetGrant.tokenSha256,
              currency: budgetGrant.currency,
              unit: budgetGrant.unit,
              capMicrousd: budgetGrant.capMicrousd,
              issuedAt: budgetGrant.issuedAt,
              notBefore: budgetGrant.notBefore,
              expiresAt: budgetGrant.expiresAt,
            },
          });
        } catch (error) {
          if (isBudgetGrantExpiredStorageError(error)) {
            throw new SiteBuildBudgetGrantError(
              "BUDGET_GRANT_EXPIRED",
              HttpStatus.PAYMENT_REQUIRED,
            );
          }
          throw error;
        }
        await tx.$executeRaw`SELECT create_site_build_budget_from_grant(${ctx.workspaceId}::uuid, ${run.id}::uuid)`;
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
        return {
          response,
          run,
        };
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

      // A thrown start is ambiguous: Temporal may have accepted the deterministic workflow and only
      // lost the response. Recover its chain head before returning an error, and never overwrite
      // queued/running/succeeded state without proof that no execution exists.
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
        // Keep Site/run/key as the durable recovery anchor. A keyed replay reuses its ledger entry;
        // an exact unkeyed replay reuses the persisted intake and active demo run above.
        throw this.unavailable(Boolean(idempotencyKey));
      }
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
