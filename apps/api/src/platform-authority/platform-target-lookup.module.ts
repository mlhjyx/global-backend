import { Module } from "@nestjs/common";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "../execution-budget/execution-budget-authority.repository";
import {
  ExecutionBudgetPlatformWriterDatabaseModule,
  type PlatformWriterPrismaClient,
} from "../execution-budget/execution-budget-platform-writer.database";
import { PlatformTargetReaderJwksVerifier } from "./platform-target-reader-jwks-verifier";
import { PlatformTargetLookupRepository } from "./platform-target-lookup.repository";
import { PlatformTargetLookupRedisRuntime } from "./platform-target-lookup-redis.runtime";
import { PlatformTargetLookupService } from "./platform-target-lookup.service";
import { PlatformTargetLookupController } from "./platform-target-lookup.controller";
import { PlatformTargetLookupGuard } from "./platform-target-lookup.guard";

export const PLATFORM_TARGET_LOOKUP_READINESS = "platform_target_lookup";
interface Probe {
  readiness(deadlineAtMs: number): Promise<boolean>;
}
interface Dependencies {
  verifier: Probe;
  repository: Probe;
  redis: Probe;
  admission: { current(): { admitted: boolean } };
  registry: Pick<RuntimeReadinessContributorRegistry, "register">;
  monotonicNow?: () => number;
}
export class PlatformTargetLookupReadinessContributor {
  private unregister?: () => void;
  private closed = false;
  constructor(private readonly dependencies: Dependencies) {}
  onModuleInit(): void {
    this.unregister = this.dependencies.registry.register(
      PLATFORM_TARGET_LOOKUP_READINESS,
      () => this.check(),
    );
  }
  private async check() {
    const failed = Object.freeze({
      status: "failed" as const,
      code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        this.closed ||
        this.dependencies.admission.current().admitted !== true
      )
        return failed;
      const now = this.dependencies.monotonicNow ?? (() => performance.now());
      const start = now();
      if (!Number.isFinite(start) || start < 0) return failed;
      const deadline = start + 2000;
      const results = await Promise.race([
        Promise.all([
          this.dependencies.verifier.readiness(deadline),
          this.dependencies.repository.readiness(deadline),
          this.dependencies.redis.readiness(deadline),
        ]),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 2000);
        }),
      ]);
      const finished = now();
      if (
        this.closed ||
        !Number.isFinite(finished) ||
        finished < start ||
        finished >= deadline ||
        this.dependencies.admission.current().admitted !== true ||
        !results ||
        !results.every((value) => value === true)
      )
        return failed;
      return Object.freeze({ status: "ok" as const });
    } catch {
      return failed;
    } finally {
      clearTimeout(timer);
    }
  }
  onModuleDestroy(): void {
    this.closed = true;
    this.unregister?.();
    this.unregister = undefined;
  }
}
export function createPlatformTargetLookupService(
  verifier: PlatformTargetReaderJwksVerifier,
  repository: PlatformTargetLookupRepository,
  redis: PlatformTargetLookupRedisRuntime,
  admission: RuntimeAdmissionService,
): PlatformTargetLookupService {
  return new PlatformTargetLookupService({
    verifier,
    repository,
    limiter: redis,
    admitted: () => admission.current().admitted,
  });
}
@Module({
  imports: [ExecutionBudgetPlatformWriterDatabaseModule],
  controllers: [PlatformTargetLookupController],
  providers: [
    {
      provide: PlatformTargetReaderJwksVerifier,
      useFactory: () => new PlatformTargetReaderJwksVerifier(),
    },
    {
      provide: PlatformTargetLookupRedisRuntime,
      useFactory: () => new PlatformTargetLookupRedisRuntime(process.env),
    },
    {
      provide: PlatformTargetLookupRepository,
      inject: [EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE],
      useFactory: (client: PlatformWriterPrismaClient | null) =>
        new PlatformTargetLookupRepository(client),
    },
    {
      provide: PlatformTargetLookupService,
      inject: [
        PlatformTargetReaderJwksVerifier,
        PlatformTargetLookupRepository,
        PlatformTargetLookupRedisRuntime,
        RuntimeAdmissionService,
      ],
      useFactory: createPlatformTargetLookupService,
    },
    {
      provide: PlatformTargetLookupReadinessContributor,
      inject: [
        PlatformTargetReaderJwksVerifier,
        PlatformTargetLookupRepository,
        PlatformTargetLookupRedisRuntime,
        RuntimeAdmissionService,
        RuntimeReadinessContributorRegistry,
      ],
      useFactory: (
        verifier: PlatformTargetReaderJwksVerifier,
        repository: PlatformTargetLookupRepository,
        redis: PlatformTargetLookupRedisRuntime,
        admission: RuntimeAdmissionService,
        registry: RuntimeReadinessContributorRegistry,
      ) =>
        new PlatformTargetLookupReadinessContributor({
          verifier,
          repository,
          redis,
          admission,
          registry,
        }),
    },
    PlatformTargetLookupGuard,
  ],
  exports: [PlatformTargetLookupService],
})
export class PlatformTargetLookupModule {}
