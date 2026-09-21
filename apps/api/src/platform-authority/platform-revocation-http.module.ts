import { Module } from "@nestjs/common";
import { getStorageToken, type ThrottlerStorage } from "@nestjs/throttler";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "../execution-budget/execution-budget-authority.repository";
import {
  ExecutionBudgetPlatformWriterDatabaseModule,
  type PlatformWriterPrismaClient,
} from "../execution-budget/execution-budget-platform-writer.database";
import { PlatformRevocationRepository } from "./platform-revocation.repository";
import { PlatformFenceAckDeliveryRepository } from "./platform-fence-ack-delivery.repository";
import { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import { PlatformRevocationIssuerRateLimiter } from "./platform-revocation-issuer-rate-limit";
import { PlatformRevocationHttpService } from "./platform-revocation-http.service";
import { PlatformRevocationHttpGuard } from "./platform-revocation-http.guard";
import { PlatformRevocationHttpController } from "./platform-revocation-http.controller";
import { PlatformFenceAckJwksController } from "./platform-fence-ack-jwks.controller";

export function createPlatformRevocationHttpService(
  trust: PlatformRevocationTrustRuntime,
  limiter: PlatformRevocationIssuerRateLimiter,
  revocations: PlatformRevocationRepository,
  deliveries: PlatformFenceAckDeliveryRepository,
  admission: RuntimeAdmissionService,
) {
  return new PlatformRevocationHttpService({
    trust,
    limiter,
    revocations,
    deliveries,
    admitted: () => admission.current().admitted,
  });
}
@Module({
  imports: [ExecutionBudgetPlatformWriterDatabaseModule],
  controllers: [
    PlatformRevocationHttpController,
    PlatformFenceAckJwksController,
  ],
  providers: [
    {
      provide: PlatformRevocationTrustRuntime,
      useFactory: () => new PlatformRevocationTrustRuntime(),
    },
    {
      provide: PlatformRevocationIssuerRateLimiter,
      inject: [getStorageToken()],
      useFactory: (storage: ThrottlerStorage) =>
        new PlatformRevocationIssuerRateLimiter(storage),
    },
    {
      provide: PlatformRevocationRepository,
      inject: [EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE],
      useFactory: (client: PlatformWriterPrismaClient | null) =>
        new PlatformRevocationRepository(client),
    },
    {
      provide: PlatformFenceAckDeliveryRepository,
      inject: [EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE],
      useFactory: (client: PlatformWriterPrismaClient | null) =>
        new PlatformFenceAckDeliveryRepository(client),
    },
    {
      provide: PlatformRevocationHttpService,
      inject: [
        PlatformRevocationTrustRuntime,
        PlatformRevocationIssuerRateLimiter,
        PlatformRevocationRepository,
        PlatformFenceAckDeliveryRepository,
        RuntimeAdmissionService,
      ],
      useFactory: createPlatformRevocationHttpService,
    },
    PlatformRevocationHttpGuard,
  ],
})
export class PlatformRevocationHttpModule {}
