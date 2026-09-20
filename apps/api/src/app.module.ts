import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { httpThrottlerOptions } from './common/redis-http-throttler.storage';
import { PrismaModule } from './prisma/prisma.module';
import { WsThrottlerGuard } from './common/ws-throttler.guard';
import { AuthModule } from './auth/auth.module';
import { ModelGatewayModule } from './model-gateway/model-gateway.module';
import { TemporalModule } from './temporal/temporal.module';
import { RelayModule } from './relay/relay.module';
import { HealthController } from './health/health.controller';
import { WhoamiController } from './whoami/whoami.controller';
import { CompanyModule } from './company/company.module';
import { ClaimModule } from './claim/claim.module';
import { IcpModule } from './icp/icp.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { LeadModule } from './lead/lead.module';
import { EventsModule } from './events/events.module';
import { ComplianceModule } from './compliance/compliance.module';
import { SanctionsModule } from './sanctions/sanctions.module';
import { SiteBuilderModule } from './site-builder/site-builder.module';
import { ModelRuntimeModule } from './model-runtime';
import { RuntimeModule } from './runtime/runtime.module';
import { RuntimeWorkAdmissionGuard } from './runtime/runtime-work-admission.guard';
import { ExecutionBudgetModule } from './execution-budget/execution-budget.module';
import { PlatformAuthorityModule } from './platform-authority/platform-authority.module';
import { PlatformTargetLookupModule } from './platform-authority/platform-target-lookup.module';
import { PlatformRevocationHttpModule } from './platform-authority/platform-revocation-http.module';

/**
 * Root module. Domain modules (company-knowledge, icp, data-hub, lead) are
 * imported here as the AI-acquisition spine lands.
 */
@Module({
  imports: [
    // 请求速率防护：沿用 WsThrottlerGuard tracker，默认 300 req / 分钟。
    ThrottlerModule.forRootAsync({
      useFactory: () => httpThrottlerOptions(process.env),
    }),
    PrismaModule,
    RuntimeModule,
    AuthModule,
    ModelGatewayModule,
    ExecutionBudgetModule,
    PlatformAuthorityModule,
    PlatformTargetLookupModule,
    PlatformRevocationHttpModule,
    ModelRuntimeModule,
    TemporalModule,
    RelayModule,
    CompanyModule,
    ClaimModule,
    IcpModule,
    DiscoveryModule,
    LeadModule,
    EventsModule,
    ComplianceModule,
    SanctionsModule,
    SiteBuilderModule,
  ],
  controllers: [HealthController, WhoamiController],
  providers: [
    { provide: APP_GUARD, useClass: WsThrottlerGuard },
    { provide: APP_GUARD, useClass: RuntimeWorkAdmissionGuard },
  ],
})
export class AppModule {}
