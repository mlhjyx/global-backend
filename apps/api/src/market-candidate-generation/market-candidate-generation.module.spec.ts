import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { ModelGateway } from '../model-gateway/model-gateway';
import { TOOL_BUDGET_STORE } from '../tools/budget-store';
import { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { MarketCandidatesModule } from '../market-candidates/market-candidates.module';
import { MarketCandidateSetsService } from '../market-candidates/market-candidate-sets.service';
import { MarketCandidateGenerationModule } from './market-candidate-generation.module';
import { MarketCandidateGenerationRepository } from './generation.repository';
import { MarketCandidateGenerationService } from './generation.service';
import { MarketCandidateGenerationsController } from './generation.controller';

describe('generation product composition and supplied authoritative boundaries',()=>{
 it('registers one generation module and imports existing authority/storage exports without creating a new gateway or ledger',()=>{
  expect((Reflect.getMetadata(MODULE_METADATA.IMPORTS,AppModule)as unknown[]).filter(module=>module===MarketCandidateGenerationModule)).toHaveLength(1);
  expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS,MarketCandidateGenerationModule)).toEqual([ExecutionBudgetModule,MarketCandidatesModule]);
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS,MarketCandidateGenerationModule)).toEqual([MarketCandidateGenerationRepository,MarketCandidateGenerationService]);
  expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS,MarketCandidateGenerationModule)).toEqual([MarketCandidateGenerationsController]);
  expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS,MarketCandidateGenerationModule)).toEqual([MarketCandidateGenerationService]);
 });
 it('uses the actual production service constructor in a Nest root with controlled ports, and a read requires no gateway or budget method',async()=>{
  const workspaceId='11111111-1111-4111-8111-111111111111',userId='55555555-5555-4555-8555-555555555555',id='66666666-6666-4666-8666-666666666666';
  const row={id,workspaceId,companyId:'22222222-2222-4222-8222-222222222222',intentId:'77777777-7777-4777-8777-777777777777',intentDigest:'a'.repeat(64),phase:'PREPARED',reasonCode:null,preparedAt:new Date('2026-11-20T00:00:00Z'),updatedAt:new Date('2026-11-20T00:00:00Z')};
  const findInputs:unknown[][]=[];
  const repository={find:async(...args:unknown[])=>{findInputs.push(args);return row;}};
  const forbidden=()=>{throw Error('read-only composition must not access execution ports');};
  const budget={reserve:forbidden,readOperationResult:forbidden},authority={consumeVerifiedWorkspaceGrantInTransaction:forbidden},gateway={generateStructured:forbidden},sets={getRevision:forbidden};
  @Module({providers:[MarketCandidateGenerationService,{provide:MarketCandidateGenerationRepository,useValue:repository},{provide:ExecutionBudgetAuthorityService,useValue:authority},
   {provide:TOOL_BUDGET_STORE,useValue:budget},{provide:ModelGateway,useValue:gateway},{provide:MarketCandidateSetsService,useValue:sets}]})
  class SuppliedBoundaryRoot{}
  const app=await NestFactory.createApplicationContext(SuppliedBoundaryRoot,{logger:false,abortOnError:false});
  try{
   const service=app.get(MarketCandidateGenerationService);expect(service).toBeInstanceOf(MarketCandidateGenerationService);
   expect(app.get(TOOL_BUDGET_STORE)).toBe(budget);expect(app.get(ModelGateway)).toBe(gateway);
   const ctx={workspaceId,userId,roles:[]};expect(await service.get(ctx,id)).toMatchObject({generationId:id,phase:'PREPARED',set:null,execution:null});expect(findInputs).toEqual([[ctx,id]]);
  }finally{await app.close();}
 });
});
