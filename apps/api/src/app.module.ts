import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
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

/**
 * Root module. Domain modules (company-knowledge, icp, data-hub, lead) are
 * imported here as the AI-acquisition spine lands.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ModelGatewayModule,
    TemporalModule,
    RelayModule,
    CompanyModule,
    ClaimModule,
    IcpModule,
    DiscoveryModule,
    LeadModule,
  ],
  controllers: [HealthController, WhoamiController],
})
export class AppModule {}
