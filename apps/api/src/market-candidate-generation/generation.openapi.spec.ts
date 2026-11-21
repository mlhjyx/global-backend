import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_BUDGET_GRANT_HEADER } from '../execution-budget/execution-budget-grant.decorator';
function document(){return JSON.parse(readFileSync(resolve(process.cwd(),'../../packages/contracts/openapi/openapi.json'),'utf8'))as {paths:Record<string,Record<string,{operationId:string;security:unknown;'x-required-scopes':string[];parameters?:Array<{name:string}>;requestBody?:unknown;responses:Record<string,unknown>}>>;components:{schemas:Record<string,Record<string,unknown>>}};}
const routes=[
 ['post','/api/v1/companies/{companyId}/market-candidate-generations','prepare','acquisition:write'],
 ['post','/api/v1/market-candidate-generations/{generationId}/execute','execute','acquisition:write'],
 ['get','/api/v1/market-candidate-generations/{generationId}','get','acquisition:read'],
 ['post','/api/v1/market-candidate-generations/{generationId}/recover','recover','acquisition:write'],
]as const;
describe('market generation complete ordinary-user OpenAPI contract',()=>{
 it.each(routes)('publishes %s %s with its fixed operation identity and scope', (method,path,action,scope)=>{
  const op=document().paths[path]?.[method];expect(op).toBeDefined();expect(op.operationId).toBe(`MarketCandidateGenerationsController_${action}_v1`);
  expect(op.security).toEqual([{bearer:[]}]);expect(op['x-required-scopes']).toEqual([scope]);expect(op.responses).toHaveProperty('200');
  const headers=op.parameters?.filter(p=>p.name.toLowerCase()===EXECUTION_BUDGET_GRANT_HEADER.toLowerCase())??[];
  expect(headers).toHaveLength(action==='execute'?1:0);
  if(action==='execute'||action==='recover'){expect(op.responses).toHaveProperty('202');expect(JSON.stringify(op.responses['202'])).toContain('MarketCandidateGenerationDto');}
 });
 it('keeps client intention DTOs closed and never accepts authority, candidates, actor or source payload through generation APIs',()=>{
  const schemas=document().components.schemas;
  for(const name of ['MarketCandidateGenerationPrepareDto','MarketCandidateGenerationExecuteDto','MarketCandidateGenerationDto','MarketCandidateGenerationSetReferenceDto','MarketCandidateGenerationExecutionReferenceDto'])expect(schemas[name]?.additionalProperties).toBe(false);
  const prepare=schemas.MarketCandidateGenerationPrepareDto as {properties:Record<string,unknown>;required:string[]};
  expect(Object.keys(prepare.properties).sort()).toEqual(['claimIds','intentId','offeringIds']);expect(prepare.required).toEqual(['intentId']);
  const execute=schemas.MarketCandidateGenerationExecuteDto as {properties:Record<string,unknown>;required:string[]};
  expect(Object.keys(execute.properties)).toEqual(['intentDigest']);expect(execute.required).toEqual(['intentDigest']);
 });
 it('publishes all lifecycle and bounded domain-reason values without claiming every persisted phase is availability',()=>{
  const schema=document().components.schemas.MarketCandidateGenerationDto as {properties:{phase:{enum:string[]};reasonCode:{enum:string[]}}};
  expect(schema.properties.phase.enum).toEqual(['PREPARED','RUNNING','RESULT_UNKNOWN','RESULT_READY','PERSISTED','FAILED','NOT_APPLIED']);
  expect(schema.properties.reasonCode.enum).toEqual(['BASIS_UNAVAILABLE','BASIS_CHANGED','SUPERSEDED','VERSION_CONFLICT','OUTPUT_INVALID','EXECUTION_REJECTED','EXECUTION_FAILED','RESULT_UNKNOWN','RESULT_NOT_FOUND','SAVE_PENDING']);
 });
 it('publishes its declared top-level tag so the new operations introduce no undefined-tag lint warnings',()=>{
  const tags=(document()as unknown as {tags:Array<{name:string}>}).tags;
  expect(tags.map(tag=>tag.name)).toContain('Market Candidate Generations');
 });

});
