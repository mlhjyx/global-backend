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
import { EmbeddingsClient } from '../site-builder/embeddings.client';

@Module({
  controllers: [SellerCompanyDocumentsController, SellerDocumentsController],
  providers: [
    SellerDocumentsService,
    EmbeddingsClient,
    { provide: SellerDocumentsStorage, useFactory: () => new SellerDocumentsStorage() },
    { provide: SELLER_DOCUMENTS_INGEST_LAUNCHER, useClass: TemporalSellerDocumentsIngestLauncher },
  ],
  exports: [SellerDocumentsService],
})
export class SellerKnowledgeModule {}
