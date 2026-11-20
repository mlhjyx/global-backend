import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { MarketCandidatesModule } from './market-candidates.module';
import { MarketCandidateSetsService } from './market-candidate-sets.service';
import { MarketCandidateSetsController } from './market-candidate-sets.controller';

describe('market candidate product composition boundary', () => {
  it('registers one storage-only module without a producer, execution or model dependency', () => {
    expect((Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[]).filter(m => m === MarketCandidatesModule)).toHaveLength(1);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, MarketCandidatesModule) ?? []).toEqual([]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MarketCandidatesModule)).toEqual([MarketCandidateSetsService]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, MarketCandidatesModule)).toEqual([MarketCandidateSetsService]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MarketCandidatesModule)).toEqual([MarketCandidateSetsController]);
    expect(Reflect.getMetadata('self:paramtypes', MarketCandidateSetsService)).toEqual([{ index: 0, param: PrismaService }]);
  });
  it('keeps the initial persistence port off every HTTP route', () => {
    const paths = Object.getOwnPropertyNames(MarketCandidateSetsController.prototype).filter(name => name !== 'constructor');
    expect(paths.sort()).toEqual(['getCurrent','getLatest','getRevision','listRevisions','recordFeedback']);
    expect(paths).not.toContain('persistInitial');
  });
});
