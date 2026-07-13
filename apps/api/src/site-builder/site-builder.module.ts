import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { DEMO_V0_LAUNCHER } from './demo-launcher';
import { TemporalDemoV0Launcher } from './temporal-demo-launcher';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';
import { StorageService } from './storage.service';

/**
 * 独立站建设（docs/site-builder/02 §1）。M0：intake + 站点档案 + 素材/KB 地基。
 * DEMO_V0_LAUNCHER 在 M0-⑥ 换成 Temporal 实现（siteBuilderWorkflow 快速通道）。
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [IntakeController, SitesController, AssetsController, KbController],
  providers: [
    IntakeService,
    SitesService,
    AssetsService,
    KbService,
    StorageService,
    EmbeddingsClient,
    DoclingClient,
    { provide: DEMO_V0_LAUNCHER, useClass: TemporalDemoV0Launcher },
  ],
  exports: [IntakeService, SitesService, AssetsService, KbService, StorageService],
})
export class SiteBuilderModule {}
