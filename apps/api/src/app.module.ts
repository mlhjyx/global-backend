import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { ClaimModule } from './claim/claim.module';
import { WsThrottlerGuard } from './common/ws-throttler.guard';
import { CompanyModule } from './company/company.module';
import { ComplianceModule } from './compliance/compliance.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { HealthModule } from './health/health.module';
import { IcpModule } from './icp/icp.module';
import { IdentityReviewModule } from './identity-review/identity-review.module';
import { LeadModule } from './lead/lead.module';
import { ModelGatewayModule } from './model-gateway/model-gateway.module';
import { ModelRuntimeModule } from './model-runtime';
import { PrismaModule } from './prisma/prisma.module';
import { RelayModule } from './relay/relay.module';
import {
  RuntimeModule,
  type RuntimeBootstrapSnapshot,
} from './runtime/runtime-admission';
import { SanctionsModule } from './sanctions/sanctions.module';
import { SiteBuilderModule } from './site-builder/site-builder.module';
import { TemporalModule } from './temporal/temporal.module';
import { WhoamiController } from './whoami/whoami.controller';
import { LeadQualityLabelModule } from './lead-quality-labels/lead-quality-label.module';

function positiveIntegerOrDefault(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('throttler configuration must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('throttler configuration must be a safe integer');
  }
  return parsed;
}

/** Root module bound to the exact pre-Nest runtime snapshot. */
@Module({})
export class AppModule {
  static register(runtime: RuntimeBootstrapSnapshot): DynamicModule {
    const env = runtime.process.environment;
    return {
      module: AppModule,
      imports: [
        RuntimeModule.forRoot(runtime),
        ThrottlerModule.forRoot([
          {
            ttl: positiveIntegerOrDefault(env.THROTTLE_TTL_MS, 60_000),
            limit: positiveIntegerOrDefault(env.THROTTLE_LIMIT, 300),
          },
        ]),
        PrismaModule,
        AuthModule,
        ModelGatewayModule,
        ModelRuntimeModule,
        TemporalModule,
        RelayModule,
        HealthModule,
        CompanyModule,
        ClaimModule,
        IcpModule,
        IdentityReviewModule,
        DiscoveryModule,
        LeadModule,
        LeadQualityLabelModule,
        EventsModule,
        ComplianceModule,
        SanctionsModule,
        SiteBuilderModule,
      ],
      controllers: [HealthController, WhoamiController],
      providers: [{ provide: APP_GUARD, useClass: WsThrottlerGuard }],
    };
  }
}
