import { Module } from '@nestjs/common';
import {
  SellerCompanyDocumentsController,
  SellerDocumentsController,
} from './seller-documents.controller';
import {
  SELLER_DOCUMENTS_INGEST_LAUNCHER,
  SellerDocumentsService,
} from './seller-documents.service';
import { SellerDocumentsStorage } from './seller-documents.storage';
import { TemporalSellerDocumentsIngestLauncher } from './temporal-seller-documents-launcher';
import { SellerDocumentClaimsController } from './seller-document-claims.controller';
import { SellerDocumentClaimsService } from './seller-document-claims.service';
import { EmbeddingsClient } from '../infra-clients/embeddings.client';

@Module({
  controllers: [SellerCompanyDocumentsController, SellerDocumentsController, SellerDocumentClaimsController],
  providers: [
    SellerDocumentsService,
    SellerDocumentClaimsService,
    EmbeddingsClient,
    { provide: SellerDocumentsStorage, useFactory: () => new SellerDocumentsStorage() },
    { provide: SELLER_DOCUMENTS_INGEST_LAUNCHER, useClass: TemporalSellerDocumentsIngestLauncher },
  ],
  exports: [SellerDocumentsService, SellerDocumentClaimsService],
})
export class SellerKnowledgeModule {}
