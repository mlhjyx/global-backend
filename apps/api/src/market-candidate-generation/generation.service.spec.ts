import type { MarketCandidateGeneration } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import type { MarketCandidateGenerationRepository } from './generation.repository';
import type { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import type { BudgetStore } from '../tools/budget-store';
import type { MarketCandidateSetsService } from '../market-candidates/market-candidate-sets.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import { MarketCandidateGenerationService } from './generation.service';
import { describe, expect, it } from 'vitest';
import { getTask } from '../ai-tasks/task-registry';
import { buildGenerationBasis, GENERATION_INPUT_BYTES, generationCanonicalJson } from './generation-basis';
import { prepareGenerationModel } from './generation.service';

const workspaceId='11111111-1111-4111-8111-111111111111', companyId='22222222-2222-4222-8222-222222222222';
const generationId='66666666-6666-4666-8666-666666666666';
function basis(summary: string | null = null) {
  return buildGenerationBasis({workspaceId,companyId},{company:{id:companyId,workspaceId,version:1,name:'Synthetic supplier',website:null,industry:null,industryCode:null,summary,targetMarkets:[],deletedAt:null},
    offerings:[{id:'33333333-3333-4333-8333-333333333333',workspaceId,companyId,name:'Synthetic supply',description:'Full unverified material',attributes:{nested:{full:'no truncation'}}}],
    claims:[{id:'44444444-4444-4444-8444-444444444444',workspaceId,companyId,version:2,status:'APPROVED',type:'capability',statement:'Synthetic approved statement, not independent proof',validUntil:null,verifiedAt:null,verificationMethod:null}]});
}
describe('market generation deterministic full-input model preparation',()=>{
 it('renders exactly the complete canonical material under the registered bounded task, never a digest-only or truncated prompt',()=>{
   const prepared=prepareGenerationModel(basis(),generationId,workspaceId);
   expect(prepared.input).toMatchObject({task:'market.candidates.generate',model:getTask('market.candidates.generate')?.model,maxCostCents:40,maxTokens:16000});
   expect(prepared.input.prompt.endsWith(generationCanonicalJson(basis().inputMaterial))).toBe(true);
   expect(prepared.fingerprints).toMatchObject({contractVersion:'market-candidate-generation-contract/v1',promptDigest:expect.stringMatching(/^[0-9a-f]{64}$/),inputSchemaDigest:expect.stringMatching(/^[0-9a-f]{64}$/),outputSchemaDigest:expect.stringMatching(/^[0-9a-f]{64}$/),modelPolicyDigest:expect.stringMatching(/^[0-9a-f]{64}$/)});
   expect(prepared.contextDigest).toMatch(/^[0-9a-f]{64}$/);
 });
 it('changes the prompt and context fingerprints when actually used material changes without a company-version bump',()=>{
   const a=prepareGenerationModel(basis('original'),generationId,workspaceId),b=prepareGenerationModel(basis('changed'),generationId,workspaceId);
   expect(a.fingerprints.promptDigest).not.toBe(b.fingerprints.promptDigest);
   expect(a.contextDigest).not.toBe(b.contextDigest);
   expect(a.fingerprints.modelPolicyDigest).not.toBe(b.fingerprints.modelPolicyDigest);
 });
 it('refuses legal input bytes that overflow the actual double-escaped required runtime context, before a grant or gateway is available',()=>{
   const material=basis('\\'.repeat(120_000));
   expect(Buffer.byteLength(generationCanonicalJson(material.inputMaterial),'utf8')).toBeLessThanOrEqual(GENERATION_INPUT_BYTES);
   expect(()=>prepareGenerationModel(material,generationId,workspaceId)).toThrow('required context segments exceed the model context budget');
 });
 it('rejects a forged material digest instead of binding an unsent or different source body',()=>{
   const forged=basis();forged.inputMaterialDigest='a'.repeat(64);
   expect(()=>prepareGenerationModel(forged,generationId,workspaceId)).toThrow('VALIDATION_ERROR');
 });

});


describe('authoritative status and zero-dispatch service branches with controlled persistence ports',()=>{
 const userId='55555555-5555-4555-8555-555555555555',ctx:RequestContext={workspaceId,userId,roles:[]};
 function ports(phase='PREPARED',active=false,status='NOT_FOUND',validTerminal=true){
  const row={id:generationId,workspaceId,companyId,requestedBy:userId,intentId:'77777777-7777-4777-8777-777777777777',intentDigest:'a'.repeat(64),phase,reasonCode:phase==='NOT_APPLIED'?'SUPERSEDED':null,
   preparedAt:new Date('2026-11-20T00:00:00Z'),updatedAt:new Date('2026-11-20T00:00:00Z'),activeAttemptId:active?'88888888-8888-4888-8888-888888888888':null,
   executionOperationId:'99999999-9999-4999-8999-999999999999',resultSchema:'market-candidates-generation/v1',resultDigest:'b'.repeat(64),consumerAckId:'c'.repeat(64),setId:null}as unknown as MarketCandidateGeneration;
  const unexpected=()=>{throw Error('unexpected execution dependency');};
  const repository={find:async()=>row,transaction:async(_workspace:string,run:(tx:object)=>Promise<unknown>)=>run({}),terminalValid:async()=>validTerminal,
   attempts:async()=>[{id:row.activeAttemptId,authorityId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accountKey:'synthetic',accountGeneration:1,expectedOperationKey:'d'.repeat(64)}],
   lockGeneration:async()=>row,progress:async(_tx:unknown,_current:unknown,next:string,reason:string|null)=>{row.phase=next;row.reasonCode=reason;return row;}};
  const budget={readOperationResult:async()=>({status}),reserve:unexpected,attestAuthorized:unexpected,open:unexpected,settle:unexpected};
  const service=new MarketCandidateGenerationService(repository as unknown as MarketCandidateGenerationRepository,{verifyWorkspaceGrant:unexpected,consumeVerifiedWorkspaceGrantInTransaction:unexpected}as unknown as ExecutionBudgetAuthorityService,budget as unknown as BudgetStore,{getRevision:unexpected}as unknown as MarketCandidateSetsService,{generateStructured:unexpected}as unknown as ModelGateway);
  return {row,repository,budget,service};
 }
 it('returns a durable prepared status without invoking any execution port',async()=>{
  const s=ports();expect(await s.service.get(ctx,generationId)).toMatchObject({generationId,phase:'PREPARED',set:null,execution:null});
  expect(await s.service.recover(ctx,generationId)).toMatchObject({phase:'PREPARED',set:null});
 });
 it('reads a NOT_APPLIED terminal decision without asking for an old projection or a set',async()=>{
  const s=ports('NOT_APPLIED');s.budget.readOperationResult=async()=>{throw Error('projection deliberately unavailable');};
  expect(await s.service.get(ctx,generationId)).toMatchObject({phase:'NOT_APPLIED',reasonCode:'SUPERSEDED',set:null,execution:{ackId:'c'.repeat(64)}});
  expect(await s.service.recover(ctx,generationId)).toMatchObject({phase:'NOT_APPLIED',set:null});
 });
 it('does not present an isolated terminal row as available when its exact ACK validation is false',async()=>{
  const s=ports('PERSISTED',true,'SETTLED',false);await expect(s.service.get(ctx,generationId)).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
 });
 it('refuses an altered intent, another requester and missing durable read capability before budget verification',async()=>{
  const s=ports();await expect(s.service.execute(ctx,generationId,{intentDigest:'b'.repeat(64)})).rejects.toMatchObject({status:409});
  await expect(s.service.execute({...ctx,userId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},generationId,{intentDigest:'a'.repeat(64)})).rejects.toMatchObject({status:403});
  s.budget.readOperationResult=undefined as never;
  await expect(s.service.execute(ctx,generationId,{intentDigest:'a'.repeat(64)})).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
 });
 it.each(['RESERVED','RESULT_UNKNOWN','RELEASED','NOT_FOUND'])('reports the original %s result as fact without dispatching or inventing an empty success',async status=>{
  const s=ports('RUNNING',true,status);const expected=status==='RELEASED'?'FAILED':status==='NOT_FOUND'?'RUNNING':'RESULT_UNKNOWN';
  expect(await s.service.recover(ctx,generationId)).toMatchObject({phase:expected,set:null});
 });
 it('refuses an absent original attempt tuple instead of fabricating a lookup or a new account',async()=>{
  const s=ports('RUNNING',true);s.repository.attempts=async()=>[];
  await expect(s.service.recover(ctx,generationId)).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
 });
 it('keeps the execute body closed even with an otherwise readable persistent intent',async()=>{
  const s=ports();await expect(s.service.execute(ctx,generationId,{intentDigest:'a'.repeat(64),authorityId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).rejects.toMatchObject({status:400});
 });
});
