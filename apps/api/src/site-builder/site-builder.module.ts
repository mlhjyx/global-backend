import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { BuildsController } from './builds.controller';
import { BuildsService } from './builds.service';
import { DEMO_V0_LAUNCHER } from './demo-launcher';
import { KB_INGEST_LAUNCHER, REFURBISH_LAUNCHER } from './refurbish-launcher';
import { TemporalDemoV0Launcher } from './temporal-demo-launcher';
import { TemporalKbIngestLauncher, TemporalRefurbishLauncher } from './temporal-refurbish-launcher';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';
import { StorageService } from './storage.service';
import { SiteSpecAssetReferenceScanner } from './site-spec-asset-reference-scanner';

/**
 * 独立站建设（docs/site-builder/02 §1）。M0：intake + 站点档案 + 素材/KB 地基。
 * DEMO_V0_LAUNCHER 在 M0-⑥ 换成 Temporal 实现（siteBuilderWorkflow 快速通道）。
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [IntakeController, SitesController, AssetsController, KbController, BuildsController],
  providers: [
    IntakeService,
    SitesService,
    AssetsService,
    BuildsService,
    KbService,
    StorageService,
    SiteSpecAssetReferenceScanner,
    EmbeddingsClient,
    DoclingClient,
    { provide: DEMO_V0_LAUNCHER, useClass: TemporalDemoV0Launcher },
    { provide: REFURBISH_LAUNCHER, useClass: TemporalRefurbishLauncher },
    { provide: KB_INGEST_LAUNCHER, useClass: TemporalKbIngestLauncher },
  ],
  exports: [IntakeService, SitesService, AssetsService, BuildsService, KbService, StorageService],
})
export class SiteBuilderModule {}
