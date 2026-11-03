import { Logger, Module } from '@nestjs/common';
import {
  SellerCompanyDocumentsController,
  SellerDocumentsController,
} from './seller-documents.controller';
import {
  SELLER_DOCUMENTS_INGEST_LAUNCHER,
  SellerDocumentsService,
  type SellerDocumentsIngestLauncher,
} from './seller-documents.service';
import { SellerDocumentsStorage } from './seller-documents.storage';

/**
 * 卖家资料库（模块 02，Phase 2）。ingest 工作流在下一块接入 Temporal；
 * 本块用占位 launcher（文档停在 queued），接口与存储已完整。
 */
class PendingIngestLauncher implements SellerDocumentsIngestLauncher {
  private readonly log = new Logger('SellerDocumentsIngestLauncher');

  async launchIngest(input: { workspaceId: string; companyId: string; documentId: string }): Promise<void> {
    this.log.log(
      `ingest queued (workflow lands in Phase 2b): workspace=${input.workspaceId} company=${input.companyId} document=${input.documentId}`,
    );
  }
}

@Module({
  controllers: [SellerCompanyDocumentsController, SellerDocumentsController],
  providers: [
    SellerDocumentsService,
    { provide: SellerDocumentsStorage, useFactory: () => new SellerDocumentsStorage() },
    { provide: SELLER_DOCUMENTS_INGEST_LAUNCHER, useClass: PendingIngestLauncher },
  ],
  exports: [SellerDocumentsService],
})
export class SellerKnowledgeModule {}
