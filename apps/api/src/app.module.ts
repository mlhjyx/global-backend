import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ServeStaticModule } from '@nestjs/serve-static';
import path from 'node:path';
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
import { SiteBuilderModule } from './site-builder/site-builder.module';

/**
 * Root module. Domain modules (company-knowledge, icp, data-hub, lead) are
 * imported here as the AI-acquisition spine lands.
 */
@Module({
  imports: [
    // 按 workspace 限流（默认 300 req / 分钟 / 租户；可 env 覆盖）
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS) || 60_000,
        limit: Number(process.env.THROTTLE_LIMIT) || 300,
      },
    ]),
    // 本地预览雏形（site-builder M0）：/preview/{slug}/ → 构建产物目录。
    // M1 迁独立预览域 + 边缘节点（05 §1），此处仅 dev 直出。
    ServeStaticModule.forRoot({
      rootPath: process.env.PREVIEW_DIR ?? path.join(process.cwd(), '.preview', 'sites'),
      serveRoot: '/preview',
      serveStaticOptions: { index: ['index.html'], fallthrough: true },
    }),
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
    EventsModule,
    ComplianceModule,
    SiteBuilderModule,
  ],
  controllers: [HealthController, WhoamiController],
  providers: [{ provide: APP_GUARD, useClass: WsThrottlerGuard }],
})
export class AppModule {}
