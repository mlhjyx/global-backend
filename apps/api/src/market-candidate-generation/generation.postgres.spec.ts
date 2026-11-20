import { ProviderHttpError, ProviderTransportError } from '../model-gateway/providers/provider-output-error';
import { applyDomainAckConsumerTransaction } from '../durable-results/domain-ack-consumer-bindings';
import { generationOutputToDraft, type GenerationOutput } from './generation-output';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import type { ModelRouter } from '../model-gateway/model-router';
import type { ModelProvider } from '../model-gateway/model-provider';
import type { GenerateStructuredInput } from '../model-gateway/types';
import type { ExecutionBudgetGrantVerifier, ExecutionBudgetGrantExpectedScope } from '../execution-budget/execution-budget-grant.verifier';
import { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import { ExecutionBudgetAuthorityRepository } from '../execution-budget/execution-budget-authority.repository';
import { ExecutionBudgetGrantError, type VerifiedExecutionBudgetAuthority } from '../execution-budget/execution-budget-authority.types';
import { PostgresBudgetStore, type BudgetReservation, type BudgetReservationRequest } from '../tools/budget-store';
import { MarketCandidateSetsService } from '../market-candidates/market-candidate-sets.service';
import { MarketCandidateGenerationService } from './generation.service';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { buildGenerationBasis } from './generation-basis';
import { documentHash } from '../market-candidates/market-candidate-set.document';
import { ClaimService } from '../claim/claim.service';
import { MarketCandidateGenerationRepository } from './generation.repository';
const ENABLED=process.env.MARKET_CANDIDATE_GENERATION_DATABASE_TEST==='1';
const OWNER=process.env.MARKET_CANDIDATE_GENERATION_TEST_DATABASE_URL,APP=process.env.MARKET_CANDIDATE_GENERATION_TEST_APP_DATABASE_URL;
if(ENABLED){if(!OWNER||!APP||APP!==process.env.APP_DATABASE_URL)throw Error('B2_TEST_URL_PAIR_REQUIRED');const a=new URL(OWNER),b=new URL(APP);if([a,b].some(u=>u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/global_test'||u.search||u.hash)||a.host!==b.host||b.username!=='app_user')throw Error('B2_EXPLICIT_LOOPBACK_GLOBAL_TEST_ONLY');}
const suite=ENABLED?describe:describe.skip;
interface Fixture {workspaceId:string;companyId:string;userId:string;id:string;intentId:string;basis:ReturnType<typeof buildGenerationBasis>}

suite('generation controls are durable tenant data, not a fixture producer or model-result copy',()=>{
 let owner:PrismaClient,app:PrismaService;
 beforeAll(async()=>{owner=new PrismaClient({datasourceUrl:OWNER});app=new PrismaService();const[p]=await app.$queryRaw<Array<{database:string;user:string;superuser:boolean;bypass:boolean}>>`SELECT current_database()AS database,current_user AS user,rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;expect(p).toEqual({database:'global_test',user:'app_user',superuser:false,bypass:false});});
 afterAll(async()=>{await app?.$disconnect();await owner?.$disconnect();});
 async function fixture():Promise<Fixture>{const workspaceId=randomUUID(),companyId=randomUUID(),userId=randomUUID();await owner.workspace.create({data:{id:workspaceId,name:'Synthetic generation-control fixture'}});await owner.companyProfile.create({data:{id:companyId,workspaceId,name:'Synthetic supplier',website:'https://synthetic.example.test',version:1}});const offering=await owner.offering.create({data:{workspaceId,companyId,name:'Synthetic supply',description:'Unknown capacity',attributes:{capability:'conditional'}}});const draft=await owner.claim.create({data:{workspaceId,companyId,type:'capability',statement:'Synthetic source statement',status:'NEEDS_REVIEW',version:1}});const claim=await new ClaimService(app).transition({workspaceId,userId,roles:[]},draft.id,'APPROVED',1);const currentCompany=await owner.companyProfile.findUniqueOrThrow({where:{id:companyId}});return{workspaceId,companyId,userId,id:randomUUID(),intentId:randomUUID(),basis:buildGenerationBasis({workspaceId,companyId},{company:currentCompany,offerings:[offering],claims:[claim]})};}
 async function insert(tx:Prisma.TransactionClient,f:Fixture,sequence=1n){return tx.$executeRaw`INSERT INTO market_candidate_generation(id,workspace_id,company_id,requested_by,intent_id,intent_sequence,prepare_request_hash,intent_digest,source_selection,basis_descriptors,input_material_digest,contract_version,contract_digest,prompt_digest,input_schema_digest,output_schema_digest,model_policy_digest)
 VALUES(${f.id}::uuid,${f.workspaceId}::uuid,${f.companyId}::uuid,${f.userId}::uuid,${f.intentId}::uuid,${sequence},${documentHash({intentId:f.intentId})},${'a'.repeat(64)},'{}'::jsonb,${JSON.stringify(f.basis.descriptors)}::jsonb,${f.basis.inputMaterialDigest},'market-candidate-generation-contract/v1',${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${'e'.repeat(64)},${'f'.repeat(64)})`;}
 async function head(tx:Prisma.TransactionClient,f:Fixture,sequence=1n){return tx.$executeRaw`INSERT INTO market_candidate_generation_head(workspace_id,company_id,latest_generation_id,intent_sequence)VALUES(${f.workspaceId}::uuid,${f.companyId}::uuid,${f.id}::uuid,${sequence})`;}
 async function prepared(f:Fixture){await app.withWorkspace(f.workspaceId,async tx=>{await insert(tx,f);await head(tx,f);});}
 it('provides all three ENABLE/FORCE RLS controls under the real app principal',async()=>{const rows=await owner.$queryRaw<Array<{name:string;enabled:boolean;forced:boolean}>>`SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public'AND relname IN('market_candidate_generation','market_candidate_generation_head','market_candidate_generation_attempt')ORDER BY relname`;expect(rows).toEqual(['market_candidate_generation','market_candidate_generation_attempt','market_candidate_generation_head'].map(name=>({name,enabled:true,forced:true})));});
 it('commits a prepared operation and its head atomically, and cold-reads only metadata in its workspace',async()=>{const f=await fixture();await prepared(f);const rows=await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw<Array<{id:string;phase:string;set_id:string|null;source_selection:unknown}>>`SELECT id::text,phase,set_id::text,source_selection FROM market_candidate_generation WHERE id=${f.id}::uuid`);expect(rows).toEqual([{id:f.id,phase:'PREPARED',set_id:null,source_selection:{}}]);const other=await fixture();expect(await app.withWorkspace(other.workspaceId,tx=>tx.$queryRaw`SELECT id FROM market_candidate_generation WHERE id=${f.id}::uuid`)).toEqual([]);expect(await app.$queryRaw`SELECT id FROM market_candidate_generation WHERE id=${f.id}::uuid`).toEqual([]);});
 it('rejects an inserted generation without a matching current head at commit',async()=>{const f=await fixture();await expect(app.withWorkspace(f.workspaceId,tx=>insert(tx,f))).rejects.toThrow();});
 it('enforces actor/intent durable uniqueness rather than allocating a second generation on replay',async()=>{const f=await fixture();await prepared(f);const duplicate={...f,id:randomUUID()};await expect(app.withWorkspace(f.workspaceId,async tx=>{await insert(tx,duplicate,2n);await tx.$executeRaw`UPDATE market_candidate_generation_head SET latest_generation_id=${duplicate.id}::uuid,intent_sequence=2 WHERE workspace_id=${f.workspaceId}::uuid AND company_id=${f.companyId}::uuid`;})).rejects.toThrow(/unique/iu);const[count]=await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM market_candidate_generation`);expect(count.count).toBe(1);});
 it('keeps immutable intent/source/actor columns and all deletes out of the app_user ACL',async()=>{const f=await fixture();await prepared(f);for(const sql of ['UPDATE market_candidate_generation SET requested_by=requested_by WHERE false','UPDATE market_candidate_generation SET intent_digest=intent_digest WHERE false','UPDATE market_candidate_generation SET basis_descriptors=basis_descriptors WHERE false','DELETE FROM market_candidate_generation WHERE false','UPDATE market_candidate_generation_attempt SET authority_id=authority_id WHERE false','DELETE FROM market_candidate_generation_head WHERE false'])await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRawUnsafe(sql))).rejects.toThrow(/permission denied/iu);});
 it('refuses fake terminal success or NOT_APPLIED without exact settled output consumption and ACK',async()=>{const f=await fixture();await prepared(f);await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation SET phase='PERSISTED'WHERE id=${f.id}::uuid`)).rejects.toThrow();await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation SET phase='NOT_APPLIED',reason_code='SUPERSEDED'WHERE id=${f.id}::uuid`)).rejects.toThrow();});
 it('preserves composite company ownership and does not accept another workspace company UUID',async()=>{const f=await fixture(),other=await fixture();await expect(app.withWorkspace(f.workspaceId,async tx=>{const wrong={...f,companyId:other.companyId,basis:other.basis};await insert(tx,wrong);await head(tx,wrong);})).rejects.toThrow(/foreign key/iu);});
 it('requires a generation-specific attempt before RUNNING and refuses head rollback or skips',async()=>{const f=await fixture();await prepared(f);await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation SET phase='RUNNING'WHERE id=${f.id}::uuid`)).rejects.toThrow();await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation_head SET intent_sequence=0 WHERE workspace_id=${f.workspaceId}::uuid`)).rejects.toThrow();await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation_head SET intent_sequence=3 WHERE workspace_id=${f.workspaceId}::uuid`)).rejects.toThrow();});
 const frozenContract = () => ({ contractVersion: 'market-candidate-generation-contract/v1', contractDigest: 'b'.repeat(64), promptDigest: 'c'.repeat(64), inputSchemaDigest: 'd'.repeat(64), outputSchemaDigest: 'e'.repeat(64), modelPolicyDigest: 'f'.repeat(64) });
 const ctx = (f:Fixture) => ({ workspaceId:f.workspaceId, userId:f.userId, roles:[] });
 it('repository prepares once and cold-reads the same metadata and head across a recreated process boundary',async()=>{
   const f=await fixture(),repository=new MarketCandidateGenerationRepository(app);
   const original=await repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract);
   expect(original).toMatchObject({workspaceId:f.workspaceId,companyId:f.companyId,requestedBy:f.userId,intentId:f.intentId,intentSequence:1n,phase:'PREPARED',setId:null,activeAttemptId:null,basisDescriptors:f.basis.descriptors,inputMaterialDigest:f.basis.inputMaterialDigest});
   expect(original.id).toMatch(/^[0-9a-f-]{36}$/);
   const cold=new MarketCandidateGenerationRepository(app);
   expect(await cold.find(ctx(f),original.id)).toEqual(original);
   expect(await cold.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract)).toEqual(original);
   const rows=await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM market_candidate_generation WHERE company_id=${f.companyId}::uuid`);
   expect(rows).toEqual([{count:1}]);
 });
 it('repository rejects another request body under the same actor/intent and fences a different actor as a new explicit intent',async()=>{
   const f=await fixture(),repository=new MarketCandidateGenerationRepository(app);
   const first=await repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract);
   await expect(repository.prepare(ctx(f),f.companyId,{intentId:f.intentId,claimIds:[]},frozenContract)).rejects.toMatchObject({status:409,response:{error:{code:'IDEMPOTENCY_CONFLICT'}}});
   const second=await repository.prepare({...ctx(f),userId:randomUUID()},f.companyId,{intentId:f.intentId},frozenContract);
   expect(second.id).not.toBe(first.id);expect(second.intentSequence).toBe(2n);
 });
 it('repository replays the original body before reevaluating changed sources, but never bypasses current company visibility',async()=>{
   const f=await fixture(),repository=new MarketCandidateGenerationRepository(app);
   const original=await repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract);
   await owner.offering.updateMany({where:{companyId:f.companyId},data:{description:'changed after explicit intent'}});
   expect(await repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},()=>{throw Error('replay must not reprepare');})).toEqual(original);
   const other=await fixture();await expect(repository.find(ctx(other),original.id)).rejects.toMatchObject({status:404});
   await owner.companyProfile.update({where:{id:f.companyId},data:{deletedAt:new Date()}});
   await expect(repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract)).rejects.toMatchObject({status:404});
   await expect(repository.find(ctx(f),original.id)).rejects.toMatchObject({status:404});
 });
 it('repository rolls back allocation and the head when pure contract/context preparation refuses the full input',async()=>{
   const f=await fixture(),repository=new MarketCandidateGenerationRepository(app);
   await expect(repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},()=>{throw Error('synthetic context rejected');})).rejects.toThrow('synthetic context rejected');
   const rows=await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw<Array<{count:number}>>`SELECT (SELECT count(*)FROM market_candidate_generation WHERE company_id=${f.companyId}::uuid)+(SELECT count(*)FROM market_candidate_generation_head WHERE company_id=${f.companyId}::uuid) AS count`);
   expect(Number(rows[0].count)).toBe(0);
 });
 it('repository detects more than 200 default sources instead of truncating to a seemingly valid material',async()=>{
   const f=await fixture(),repository=new MarketCandidateGenerationRepository(app);
   await owner.offering.createMany({data:Array.from({length:200},(_,i)=>({workspaceId:f.workspaceId,companyId:f.companyId,name:`Synthetic overflow supply ${i}`}))});
   await expect(repository.prepare(ctx(f),f.companyId,{intentId:f.intentId},frozenContract)).rejects.toThrow();
   const rows=await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM market_candidate_generation WHERE company_id=${f.companyId}::uuid`);
   expect(rows).toEqual([{count:0}]);
 });

 // Synthetic verifier/provider are explicit fixture seams. Admission, reserve, settle, ACK and domain writes use real app_user SQL.
 function system(f:Fixture, options:{cap?:bigint;beforeReturn?:()=>Promise<void>;beforeGrantReturn?:()=>Promise<void>;output?:GenerationOutput;unknownGatewaySettlement?:boolean}={}){
   const store=new PostgresBudgetStore(app),sets=new MarketCandidateSetsService(app),repository=new MarketCandidateGenerationRepository(app);
   const state={calls:0,verifications:0,reservations:[]as BudgetReservation[],requests:[]as BudgetReservationRequest[]};
   const reserve=store.reserve.bind(store);
   store.reserve=async request=>{state.requests.push(request);const result=await reserve(request);state.reservations.push(result);return result;};
   const verifier={verify:async(compact:string|undefined,expected:ExecutionBudgetGrantExpectedScope)=>{
     state.verifications+=1;if(compact!=='synthetic-owned-grant')throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
     await options.beforeGrantReturn?.();
     const now=Math.floor(Date.now()/1000);
     return {schemaVersion:'execution-budget-grant/v1',authorityKind:'WORKSPACE_GRANT',issuer:'https://synthetic-control.example.test',audience:'global-backend:execution-budget',jti:randomUUID(),
       purpose:expected.purpose,workspaceId:expected.workspaceId!,subjectType:expected.subjectType!,subjectId:expected.subjectId!,requestSha256:expected.requestSha256!,scheduleId:null,
       currency:'USD',unit:'microusd',capMicrousd:options.cap??800000n,capPerRunMicrousd:null,campaignCapMicrousd:null,maxRuns:null,tokenSha256:documentHash({nonce:randomUUID()}),issuedAt:now-5,notBefore:now-5,expiresAt:now+240} satisfies VerifiedExecutionBudgetAuthority;
   }}as unknown as ExecutionBudgetGrantVerifier;
   const authorities=new ExecutionBudgetAuthorityService(verifier,new ExecutionBudgetAuthorityRepository(app));
   const provider={id:'synthetic-b2',generateStructured:async(input:GenerateStructuredInput)=>{
     state.calls+=1;await options.beforeReturn?.();
     return {data:options.output??{outcome:'COMPLETED_EMPTY',candidates:[]},provider:'synthetic-b2',model:input.model!,reportedModel:input.model!,modelResolutionSource:'upstream_response',usage:{inputTokens:4,outputTokens:4,costUsd:0.001,...(options.unknownGatewaySettlement?{gatewaySettlements:[{status:'unknown'} as never]}:{})},callCount:1};
   },generateText:async()=>{throw Error('text forbidden');},embed:async()=>{throw Error('embedding forbidden');},health:async()=>({healthy:true})}as unknown as ModelProvider;
   const gateway=new RouterModelGateway({route:()=>[provider]}as unknown as ModelRouter,undefined,store);
   const service=new MarketCandidateGenerationService(repository,authorities,store,sets,gateway);
   return {service,repository,authorities,store,sets,gateway,state};
 }
 async function financialCounts(f:Fixture){return app.withWorkspace(f.workspaceId,async tx=>({authorities:await tx.executionBudgetAuthority.count(),attempts:await tx.marketCandidateGenerationAttempt.count(),operations:await tx.toolBudgetOperation.count(),sets:await tx.marketCandidateSet.count()}));}
 it('runs a synthetic provider through actual Router and reserves the pre-recorded identity exactly once, then cold-reads the committed empty set',async()=>{
   const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   expect(prepared.phase).toBe('PREPARED');expect(s.state.calls).toBe(0);
   const result=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
   expect(result).toMatchObject({phase:'PERSISTED',reasonCode:null,set:{revision:1,documentHash:expect.stringMatching(/^[0-9a-f]{64}$/)}});
   expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);expect(s.state.requests[0].estimatedMicrousd).toBe(800000n);
   const attempts=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:prepared.generationId}}));
   expect(attempts).toHaveLength(1);expect(attempts[0].expectedOperationKey).toBe(s.state.requests[0].operationKey);
   const initial=await s.sets.getRevision(ctx(f),result.set!.setId,1);expect(initial.document.generationOutcome).toBe('COMPLETED_EMPTY');expect(initial.document.candidates).toEqual([]);
   s.store.readOperationResult=async()=>{throw Error('terminal reader must not load projection');};
   const cold=new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
   expect(await cold.get(ctx(f),prepared.generationId)).toEqual(result);
   expect(await cold.recover(ctx(f),prepared.generationId)).toEqual(result);expect(s.state.calls).toBe(1);
   expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:1});
 });
 it('refuses a missing durable reader before consuming authority or dispatching a synthetic provider',async()=>{
   const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   s.store.readOperationResult=undefined;
   await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});expect(s.state.calls).toBe(0);
 });
 it('refuses changed used fields before grant consumption even when company.version did not change',async()=>{
   const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   await owner.offering.updateMany({where:{companyId:f.companyId},data:{description:'changed before wire without a company bump'}});
   await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toMatchObject({status:409});
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});expect(s.state.calls).toBe(0);
 });
 it('refuses an actor who can read the workspace but did not request this execution intent',async()=>{
   const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   await expect(s.service.execute({...ctx(f),userId:randomUUID()},prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toMatchObject({status:403});
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});
 });
 it.each([799999n,800001n])('refuses a cap different from the complete logical envelope before consume: %s',async cap=>{
   const f=await fixture(),s=system(f,{cap}),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toThrow(/EXECUTION_BUDGET/);
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});
 });
 it('consumes a superseded settled result as exact NOT_APPLIED plus ACK with no set, and terminal recovery never reads its projection again',async()=>{
   const f=await fixture();const s:ReturnType<typeof system>=system(f,{beforeReturn:async()=>{await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});}});
   const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   const result=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
   expect(result).toMatchObject({phase:'NOT_APPLIED',reasonCode:'SUPERSEDED',set:null,execution:{ackId:expect.stringMatching(/^[0-9a-f]{64}$/)}});
   expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
   s.store.readOperationResult=async()=>{throw Error('terminal projection unavailable');};
   expect(await s.service.recover(ctx(f),prepared.generationId)).toEqual(result);expect(s.state.calls).toBe(1);
 });
 it('consumes a known source change after the wire as NOT_APPLIED without treating database failure as a discard',async()=>{
   const f=await fixture(),s=system(f,{beforeReturn:async()=>{await owner.offering.updateMany({where:{companyId:f.companyId},data:{description:'changed after model observation'}});}});
   const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   const result=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
   expect(result).toMatchObject({phase:'NOT_APPLIED',reasonCode:'BASIS_CHANGED',set:null});
   expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
   await owner.offering.updateMany({where:{companyId:f.companyId},data:{description:'Unknown capacity'}});
   expect((await s.service.recover(ctx(f),prepared.generationId)).phase).toBe('NOT_APPLIED');expect(s.state.calls).toBe(1);
 });
 it('rolls back the B1 set, ACK and terminal tuple together on a real terminal write failure, then a new instance recovers without a gateway',async()=>{
   const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   const name='synthetic_b2_terminal_'+f.id.replaceAll('-','');
   await owner.$executeRawUnsafe(`CREATE FUNCTION ${name}()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='${prepared.generationId}'::uuid AND NEW.phase='PERSISTED' THEN RAISE EXCEPTION 'SYNTHETIC_TERMINAL_WRITE_FAILURE';END IF;RETURN NEW;END$$`);
   await owner.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON market_candidate_generation FOR EACH ROW EXECUTE FUNCTION ${name}()`);
   try{
     const pending=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
     expect(pending).toMatchObject({phase:'RESULT_READY',reasonCode:'SAVE_PENDING',set:null});
     const counts=await financialCounts(f);expect(counts).toEqual({authorities:1,attempts:1,operations:1,sets:0});
     expect(await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw`SELECT ack_id FROM execution_domain_ack`)).toEqual([]);
   }finally{await owner.$executeRawUnsafe(`DROP TRIGGER ${name} ON market_candidate_generation`);await owner.$executeRawUnsafe(`DROP FUNCTION ${name}()`);}
   const cold=new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
   const result=await cold.recover(ctx(f),prepared.generationId);expect(result.phase).toBe('PERSISTED');expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);
 });
 it('holds unknown outcomes and prevents a new intent or grant from buying another wire before the old company risk is resolved',async()=>{
   const f=await fixture();const s:ReturnType<typeof system>=system(f,{beforeReturn:async()=>{await s.store.markResultUnknown(s.state.reservations[0]);throw Error('synthetic unknown physical observation');}});
   const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
   const unknown=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
   expect(unknown).toMatchObject({phase:'RESULT_UNKNOWN',set:null});
   expect((await s.service.recover(ctx(f),prepared.generationId)).phase).toBe('RESULT_UNKNOWN');
   await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
   const newer=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});
   await s.service.execute(ctx(f),newer.generationId,{intentDigest:newer.intentDigest},'synthetic-owned-grant').catch(()=>null);
   expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);
   expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
 });

 function proposed(f:Fixture):GenerationOutput{
  const keys=f.basis.descriptors.sources.map(source=>source.key);
  const statement=(text:string,knowledgeState='INFERENCE')=>({text,knowledgeState,basisKeys:keys,impact:'Synthetic purchasing relationship remains unverified'});
  return {outcome:'CANDIDATES_PROPOSED',candidates:[{proposal:{supplyOrCapability:{offeringId:f.basis.inputMaterial.offerings[0].sourceId,description:'Synthetic supply capability'},buyerOrganizationCountry:null,projectCountry:null,
   application:statement('Synthetic conditional assembly'),organizationRole:statement('Unknown purchasing organization','UNKNOWN'),fitExplanation:statement('Potential fit, not verified demand'),
   entryConditions:[],support:[statement('Approved seller statement only','SELLER_ASSERTION')],counterEvidence:[],gaps:[statement('No independent demand evidence','UNKNOWN')],
   recommendation:{status:'CONDITIONAL',reason:'Verify actual supply and procurement context'},nextVerification:['Verify purchasing evidence']}}]}as GenerationOutput;
 }
 it('admits concurrent executes as one logical wire and one durable operation rather than consuming a second account',async()=>{
  const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const outcomes=await Promise.all([s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant'),s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')]);
  expect(outcomes.some(outcome=>outcome.phase==='PERSISTED')).toBe(true);expect((await s.service.get(ctx(f),prepared.generationId)).phase).toBe('PERSISTED');
  expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:1});
 });
 it('moves only a proven never-dispatched expired grant to its own retry account, closes the old account and retains the whole family under the logical cap',async()=>{
  const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const reserve=s.store.reserve.bind(s.store);
  s.store.reserve=async request=>{const reservation=await reserve(request);await s.store.release(reservation);throw Error('synthetic stopped before provider dispatch');};
  expect((await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).phase).toBe('FAILED');expect(s.state.calls).toBe(0);
  const first=(await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:prepared.generationId}})))[0];
  await owner.$executeRaw`UPDATE execution_budget_authority SET issued_at=issued_at-INTERVAL'10 minutes',not_before=not_before-INTERVAL'10 minutes',expires_at=expires_at-INTERVAL'10 minutes' WHERE id=${first.authorityId}::uuid`;
  s.store.reserve=reserve;
  const result=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');expect(result.phase).toBe('PERSISTED');
  const attempts=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:prepared.generationId},orderBy:{admittedAt:'asc'}}));
  expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(first);expect(attempts[1].accountKey).toBe(first.accountKey+':retry:'+attempts[1].authorityId);
  const accounts=await app.withWorkspace(f.workspaceId,tx=>tx.toolBudgetAccount.findMany({where:{scopeKey:f.workspaceId}}));
  expect(accounts.find(a=>a.accountKey===first.accountKey)?.closedAt).not.toBeNull();
  expect(accounts.reduce((sum,a)=>sum+a.chargedMicrousd+a.reservedMicrousd,0n)).toBeLessThanOrEqual(800000n);
  await expect(reserve({workspaceId:f.workspaceId,accountKey:first.accountKey,operationKey:first.expectedOperationKey,estimatedMicrousd:800000n})).rejects.toThrow();
  expect(s.state.calls).toBe(1);
 });
 it('cold-recovers settled data through a closed account and expired JWT using concurrent consumers with exactly one set and ACK',async()=>{
  const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const name='synthetic_b2_hold_'+f.id.replaceAll('-','');
  await owner.$executeRawUnsafe(`CREATE FUNCTION ${name}()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='${prepared.generationId}'::uuid AND NEW.phase='PERSISTED' THEN RAISE EXCEPTION 'SYNTHETIC_SAVE_HOLD';END IF;RETURN NEW;END$$`);
  await owner.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON market_candidate_generation FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{expect((await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_READY');}
  finally{await owner.$executeRawUnsafe(`DROP TRIGGER ${name} ON market_candidate_generation`);await owner.$executeRawUnsafe(`DROP FUNCTION ${name}()`);}
  const attempt=(await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:prepared.generationId}})))[0];
  await s.store.close({workspaceId:f.workspaceId,accountKey:attempt.accountKey,force:true});
  await owner.$executeRaw`UPDATE execution_budget_authority SET issued_at=issued_at-INTERVAL'1 hour',not_before=not_before-INTERVAL'1 hour',expires_at=expires_at-INTERVAL'1 hour' WHERE id=${attempt.authorityId}::uuid`;
  const cold=()=>new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
  const results=await Promise.all([cold().recover(ctx(f),prepared.generationId),cold().recover(ctx(f),prepared.generationId)]);
  expect(results.every(result=>result.phase==='PERSISTED')).toBe(true);expect(results[0].set).toEqual(results[1].set);
  expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:1});expect(s.state.calls).toBe(1);
  expect(await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw`SELECT ack_id FROM execution_domain_ack`)).toHaveLength(1);
 });
 it('keeps feedback history when a model finishes against a changed current revision, recording VERSION_CONFLICT plus an exact discard ACK',async()=>{
  const f=await fixture();const s:ReturnType<typeof system>=system(f,{output:proposed(f),beforeReturn:async()=>{await s.sets.recordFeedback(ctx(f),setId,candidateId,{expectedRevision:1,action:'CONFIRM'},randomUUID());}});
  const original=await s.sets.persistInitial(ctx(f),f.companyId,generationOutputToDraft(proposed(f),f.basis.descriptors),randomUUID());const setId=original.setId;
  const candidateId=(await s.sets.getCurrent(ctx(f),setId)).document.candidates[0].candidateId;
  const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  expect(await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).toMatchObject({phase:'NOT_APPLIED',reasonCode:'VERSION_CONFLICT',set:null});
  expect((await s.sets.getCurrent(ctx(f),setId)).document.revision).toBe(2);
  expect(await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateFeedback.count())).toBe(1);expect((await financialCounts(f)).sets).toBe(1);
 });
 it('persists a nonempty hypothesis set with stable server IDs and fresh PENDING feedback rather than inheriting an old confirmation',async()=>{
  const f=await fixture(),s=system(f,{output:proposed(f)});
  const original=await s.sets.persistInitial(ctx(f),f.companyId,generationOutputToDraft(proposed(f),f.basis.descriptors),randomUUID());
  const old=(await s.sets.getCurrent(ctx(f),original.setId)).document.candidates[0];
  await s.sets.recordFeedback(ctx(f),original.setId,old.candidateId,{expectedRevision:1,action:'CONFIRM'},randomUUID());
  const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId}),result=await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
  expect(result.phase).toBe('PERSISTED');expect(result.set!.setId).not.toBe(original.setId);
  const card=(await s.sets.getCurrent(ctx(f),result.set!.setId)).document.candidates[0];
  expect(card.candidateId).not.toBe(old.candidateId);expect(card.feedback).toBe('PENDING');
  expect((await s.service.get(ctx(f),prepared.generationId)).set).toEqual(result.set);
 });
 it('consumes a known post-wire change even when its new complete material cannot fit the actual model context',async()=>{
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{await owner.companyProfile.update({where:{id:f.companyId},data:{summary:'\\'.repeat(120000)}});}});
  const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  expect(await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).toMatchObject({phase:'NOT_APPLIED',reasonCode:'BASIS_CHANGED',set:null});
  expect((await financialCounts(f)).sets).toBe(0);expect(s.state.calls).toBe(1);
 });
 it('finishes only the internal admitted audit after company soft-deletion, without reviving or exposing its domain payload',async()=>{
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{await owner.companyProfile.update({where:{id:f.companyId},data:{deletedAt:new Date()}});}});
  const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toMatchObject({status:404});
  const row=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:prepared.generationId}}));
  expect(row).toMatchObject({phase:'NOT_APPLIED',reasonCode:'BASIS_UNAVAILABLE',setId:null,consumerAckId:expect.stringMatching(/^[0-9a-f]{64}$/)});
  await expect(s.service.get(ctx(f),prepared.generationId)).rejects.toMatchObject({status:404});await expect(s.service.recover(ctx(f),prepared.generationId)).rejects.toMatchObject({status:404});
  expect((await financialCounts(f)).sets).toBe(0);expect(s.state.calls).toBe(1);
 });

 async function holdClaim(f:Fixture){
  let release!:()=>void,taken!:()=>void;const ready=new Promise<void>(resolve=>{taken=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const claimId=f.basis.descriptors.sources.find(source=>source.kind==='CLAIM')!.sourceId;
  const done=owner.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM claim WHERE id=${claimId}::uuid FOR UPDATE`;taken();await gate;},{timeout:20000});
  await Promise.race([ready,done.then(()=>{throw Error('claim lock ended before acquisition');})]);
  return async()=>{release();await done;};
 }
 it('bounds a busy pure preflight as a controlled conflict without consuming authority or dispatching',async()=>{
  const f=await fixture(),s=system(f),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId}),release=await holdClaim(f);
  try{await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toMatchObject({status:409});
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});expect(s.state.calls).toBe(0);expect(s.state.verifications).toBe(0);
  }finally{await release();}
 });
 it('rolls back the complete authority/account/attempt admission when a Claim becomes busy after verification',async()=>{
  const f=await fixture();let release:(()=>Promise<void>)|undefined;
  const s=system(f,{beforeGrantReturn:async()=>{release=await holdClaim(f);}}),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  try{await expect(s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).rejects.toMatchObject({status:409});
   expect(await financialCounts(f)).toEqual({authorities:0,attempts:0,operations:0,sets:0});expect(s.state.calls).toBe(0);expect(s.state.verifications).toBe(1);
  }finally{await release?.();}
 });
 it('rolls back the entire ACK transaction on Claim NOWAIT contention and later recovers once without another Grant or model',async()=>{
  const f=await fixture();let release:(()=>Promise<void>)|undefined;
  const s=system(f,{beforeReturn:async()=>{release=await holdClaim(f);}}),prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  try{expect(await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).toMatchObject({phase:'RESULT_READY',reasonCode:'SAVE_PENDING',set:null});
   expect(await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw`SELECT ack_id FROM execution_domain_ack`)).toEqual([]);
   expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
  }finally{await release?.();}
  expect((await s.service.recover(ctx(f),prepared.generationId)).phase).toBe('PERSISTED');expect(s.state.calls).toBe(1);expect(s.state.verifications).toBe(1);expect(s.state.requests).toHaveLength(1);
 });
 it('fences reverse response order using the latest explicit intent after the old physical result is already settled',async()=>{
  const f=await fixture(),old=system(f),newer=system(f);let release!:()=>void,settled!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{settled=resolve;});
  const settle=old.store.settle.bind(old.store);old.store.settle=async(...args)=>{const result=await settle(...args);settled();await gate;return result;};
  const first=await old.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});const pending=old.service.execute(ctx(f),first.generationId,{intentDigest:first.intentDigest},'synthetic-owned-grant');
  try{await Promise.race([seen,pending.then(()=>{throw Error('old execution ended before settlement gate');})]);
   const second=await newer.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});
   const available=await newer.service.execute(ctx(f),second.generationId,{intentDigest:second.intentDigest},'synthetic-owned-grant');expect(available.phase).toBe('PERSISTED');
  }finally{release();}
  expect(await pending).toMatchObject({phase:'NOT_APPLIED',reasonCode:'SUPERSEDED',set:null});
  expect((await financialCounts(f)).sets).toBe(1);expect(old.state.calls).toBe(1);expect(newer.state.calls).toBe(1);
 });

 async function settledPending(f:Fixture,s:ReturnType<typeof system>){
  const prepared=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()}),name='synthetic_b2_integrity_'+prepared.generationId.replaceAll('-','');
  await owner.$executeRawUnsafe(`CREATE FUNCTION ${name}()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='${prepared.generationId}'::uuid AND NEW.phase='PERSISTED' THEN RAISE EXCEPTION 'SYNTHETIC_INTEGRITY_FIXTURE_HOLD';END IF;RETURN NEW;END$$`);
  await owner.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON market_candidate_generation FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{expect((await s.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_READY');}
  finally{await owner.$executeRawUnsafe(`DROP TRIGGER ${name} ON market_candidate_generation`);await owner.$executeRawUnsafe(`DROP FUNCTION ${name}()`);}
  const row=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:prepared.generationId}}));
  const attempt=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findUniqueOrThrow({where:{id:row.activeAttemptId!}}));
  const snapshot=await s.store.readOperationResult!({scopeKey:f.workspaceId,authorityId:attempt.authorityId,accountKey:attempt.accountKey,accountGeneration:attempt.accountGeneration,operationKey:attempt.expectedOperationKey,resultSchema:'market-candidates-generation/v1'});
  if(snapshot.status!=='SETTLED')throw Error('synthetic settled fixture did not settle');
  return {prepared,row,attempt,snapshot};
 }
 it('rejects exact-shaped but wrong ACK, operation, schema, digest and set bindings instead of allowing an isolated receipt to forge a terminal decision',async()=>{
  const f=await fixture(),s=system(f),first=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const available=await s.service.execute(ctx(f),first.generationId,{intentDigest:first.intentDigest},'synthetic-owned-grant');
  const old=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:first.generationId}}));
  const pending=await settledPending(f,s);
  const ack=await app.withWorkspace(f.workspaceId,tx=>applyDomainAckConsumerTransaction({transaction:tx,producerId:'market.candidates.generate',receipt:pending.snapshot.receipt,domainAckKey:pending.row.id,domainRevision:'1',apply:async()=>undefined}));
  expect(ack.status).toBe('APPLIED');if(ack.status==='UNRECEIPTED')throw Error('fixture ACK must be trusted');
  const receipt=pending.snapshot.receipt;
  const failures=[
   {phase:'NOT_APPLIED',reason:'SUPERSEDED',set:null,op:receipt.operationId,schema:receipt.resultSchema,digest:receipt.resultDigest,ack:old.consumerAckId!},
   {phase:'NOT_APPLIED',reason:'SUPERSEDED',set:null,op:old.executionOperationId!,schema:receipt.resultSchema,digest:receipt.resultDigest,ack:ack.ack.ackId},
   {phase:'NOT_APPLIED',reason:'SUPERSEDED',set:null,op:receipt.operationId,schema:'taxonomy-code/v1',digest:receipt.resultDigest,ack:ack.ack.ackId},
   {phase:'NOT_APPLIED',reason:'SUPERSEDED',set:null,op:receipt.operationId,schema:receipt.resultSchema,digest:receipt.resultDigest[0]==='a'?'b'.repeat(64):'a'.repeat(64),ack:ack.ack.ackId},
   {phase:'PERSISTED',reason:null,set:available.set!.setId,op:receipt.operationId,schema:receipt.resultSchema,digest:receipt.resultDigest,ack:ack.ack.ackId},
  ];
  for(const value of failures)await expect(app.withWorkspace(f.workspaceId,tx=>tx.$executeRaw`UPDATE market_candidate_generation
    SET phase=${value.phase},reason_code=${value.reason},set_id=${value.set}::uuid,execution_operation_id=${value.op}::uuid,result_schema=${value.schema},result_digest=${value.digest},consumer_ack_id=${value.ack},consumed_at=clock_timestamp()
    WHERE id=${pending.row.id}::uuid`)).rejects.toThrow(/MARKET_GENERATION_EXACT_TERMINAL_ACK_REQUIRED/);
  expect((await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:pending.row.id}}))).phase).toBe('RESULT_READY');
  await expect(s.service.recover(ctx(f),pending.row.id)).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  expect((await financialCounts(f)).sets).toBe(1);expect(s.state.calls).toBe(2);
 });

 it('does not let an old released-result lookup overwrite a newly admitted active retry as a free failure',async()=>{
  const f=await fixture(),old=system(f),prepared=await old.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const reserve=old.store.reserve.bind(old.store);old.store.reserve=async request=>{const value=await reserve(request);await old.store.release(value);throw Error('synthetic never dispatched');};
  expect((await old.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant')).phase).toBe('FAILED');
  const first=(await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:prepared.generationId}})))[0];
  await owner.$executeRaw`UPDATE execution_budget_authority SET issued_at=issued_at-INTERVAL'10 minutes',not_before=not_before-INTERVAL'10 minutes',expires_at=expires_at-INTERVAL'10 minutes' WHERE id=${first.authorityId}::uuid`;
  let readerSeen!:()=>void,readerRelease!:()=>void,wireSeen!:()=>void,wireRelease!:()=>void;
  const inspected=new Promise<void>(resolve=>{readerSeen=resolve;}),readerGate=new Promise<void>(resolve=>{readerRelease=resolve;}),started=new Promise<void>(resolve=>{wireSeen=resolve;}),wireGate=new Promise<void>(resolve=>{wireRelease=resolve;});
  const read=old.store.readOperationResult!.bind(old.store);
  old.store.readOperationResult=async query=>{const value=await read(query);if(query.authorityId===first.authorityId&&value.status==='RELEASED'){readerSeen();await readerGate;}return value;};
  const recovery=old.service.recover(ctx(f),prepared.generationId);await inspected;
  const fresh=system(f,{beforeReturn:async()=>{wireSeen();await wireGate;}}),retry=fresh.service.execute(ctx(f),prepared.generationId,{intentDigest:prepared.intentDigest},'synthetic-owned-grant');
  try{await Promise.race([started,retry.then(()=>{throw Error('new retry ended before gated observation');})]);readerRelease();
   const stale=await recovery;expect(['RUNNING','RESULT_UNKNOWN']).toContain(stale.phase);
   const row=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:prepared.generationId}}));expect(row.activeAttemptId).not.toBe(first.id);expect(row.phase).not.toBe('FAILED');
  }finally{readerRelease();wireRelease();await Promise.allSettled([recovery,retry]);}
  expect((await fresh.service.get(ctx(f),prepared.generationId)).phase).toBe('PERSISTED');expect(fresh.state.calls).toBe(1);expect(old.state.calls).toBe(0);
 },20000);


 it('r4: retains historical PERSISTED facts after preparing and executing a later intent',async()=>{
  const f=await fixture(),s=system(f),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const saved=await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');expect(saved.phase).toBe('PERSISTED');
  const b=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});
  expect(await s.service.get(ctx(f),a.generationId)).toEqual(saved);expect(await s.service.recover(ctx(f),a.generationId)).toEqual(saved);
  expect(await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId})).toEqual(saved);expect(s.state.calls).toBe(1);
  const next=await s.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant');expect(next.phase).toBe('PERSISTED');expect(next.set?.setId).not.toBe(saved.set?.setId);
  const cold=new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
  expect(await cold.get(ctx(f),a.generationId)).toEqual(saved);expect(await cold.recover(ctx(f),a.generationId)).toEqual(saved);expect(s.state.calls).toBe(2);
 });
 it('r4: bills rejected output once and persistently reports failed no-result without another wire or ACK',async()=>{
  const f=await fixture(),valid=proposed(f),first=valid.candidates[0];const invalid={...valid,candidates:[{...first,proposal:{...first.proposal,supplyOrCapability:{...first.proposal.supplyOrCapability,offeringId:randomUUID()}}}]} as GenerationOutput;
  const s=system(f,{output:invalid}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const failed=await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');expect(failed).toMatchObject({phase:'FAILED',reasonCode:'OUTPUT_INVALID',set:null,execution:null});
  const cold=new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
  expect(await cold.get(ctx(f),a.generationId)).toEqual(failed);expect(await cold.recover(ctx(f),a.generationId)).toEqual(failed);
  expect(await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).toEqual(failed);
  const operations=await app.withWorkspace(f.workspaceId,tx=>tx.toolBudgetOperation.findMany());expect(operations).toHaveLength(1);expect(operations[0].status).toBe('SETTLED');expect(operations[0].chargedMicrousd).toBeGreaterThan(0n);expect(operations[0].resultSchema).toBeNull();expect(operations[0].resultDigest).toBeNull();
  expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});expect(await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw`SELECT ack_id FROM execution_domain_ack`)).toEqual([]);expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);
 });
 it('r4: ignores a same-attempt stale RESERVED recovery after RESULT_READY commits',async()=>{
  let wireSeen!:()=>void,wireRelease!:()=>void,readSeen!:()=>void,readRelease!:()=>void,readySeen!:()=>void,applyRelease!:()=>void;
  const wireStarted=new Promise<void>(resolve=>{wireSeen=resolve;}),wireGate=new Promise<void>(resolve=>{wireRelease=resolve;}),readStarted=new Promise<void>(resolve=>{readSeen=resolve;}),readGate=new Promise<void>(resolve=>{readRelease=resolve;}),readyStarted=new Promise<void>(resolve=>{readySeen=resolve;}),applyGate=new Promise<void>(resolve=>{applyRelease=resolve;});
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{wireSeen();await wireGate;}}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const boundary=s.service as unknown as {apply:(...args:unknown[])=>Promise<unknown>},apply=boundary.apply.bind(s.service);boundary.apply=async(...args)=>{readySeen();await applyGate;return apply(...args);};
  const read=s.store.readOperationResult!.bind(s.store);let hold=true;s.store.readOperationResult=async query=>{const value=await read(query);if(hold&&value.status==='RESERVED'){hold=false;readSeen();await readGate;}return value;};
  const executing=s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');await wireStarted;const recovering=s.service.recover(ctx(f),a.generationId);await readStarted;
  try{wireRelease();await Promise.race([readyStarted,executing.then(()=>{throw Error('execution ended before apply gate');})]);expect((await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:a.generationId}}))).phase).toBe('RESULT_READY');readRelease();expect((await recovering).phase).toBe('RESULT_READY');
  }finally{wireRelease();readRelease();applyRelease();await Promise.allSettled([executing,recovering]);}
  expect((await s.service.get(ctx(f),a.generationId)).phase).toBe('PERSISTED');expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);
 },20000);
 it('r4: safely readmits a ledger-RELEASED old attempt whose domain remained UNKNOWN after a crash',async()=>{
  const f=await fixture(),old=system(f),a=await old.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});const reserve=old.store.reserve.bind(old.store),read=old.store.readOperationResult!.bind(old.store);
  old.store.readOperationResult=async query=>{const value=await read(query);if(value.status==='RELEASED')throw Error('synthetic crash before domain failure reconciliation');return value;};
  old.store.reserve=async request=>{const reservation=await reserve(request);expect((await old.service.recover(ctx(f),a.generationId)).phase).toBe('RESULT_UNKNOWN');await old.store.release(reservation);throw Error('synthetic definite pre-wire failure');};
  await expect(old.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).rejects.toThrow('synthetic crash before domain failure reconciliation');
  const row=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:a.generationId}}));expect(row.phase).toBe('RESULT_UNKNOWN');const first=(await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGenerationAttempt.findMany({where:{generationId:a.generationId}})))[0];const operation=(await app.withWorkspace(f.workspaceId,tx=>tx.toolBudgetOperation.findMany()))[0];expect(operation.status).toBe('RELEASED');expect(operation.chargedMicrousd).toBe(0n);
  await owner.$executeRaw`UPDATE execution_budget_authority SET issued_at=issued_at-INTERVAL'10 minutes',not_before=not_before-INTERVAL'10 minutes',expires_at=expires_at-INTERVAL'10 minutes' WHERE id=${first.authorityId}::uuid`;
  const fresh=system(f),saved=await fresh.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');expect(saved.phase).toBe('PERSISTED');expect(old.state.calls).toBe(0);expect(fresh.state.calls).toBe(1);
  const accounts=await app.withWorkspace(f.workspaceId,tx=>tx.toolBudgetAccount.findMany());expect(accounts.find(x=>x.accountKey===first.accountKey)?.closedAt).not.toBeNull();expect(accounts.reduce((n,x)=>n+x.chargedMicrousd+x.reservedMicrousd,0n)).toBeLessThanOrEqual(800000n);expect((await financialCounts(f)).attempts).toBe(2);
 },20000);


 it('r4: keeps the database latest-intent commit fence even if an application read is stale',async()=>{
  const f=await fixture();let next!:Awaited<ReturnType<MarketCandidateGenerationService['prepare']>>;const s=system(f,{beforeReturn:async()=>{next=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});}}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  const head=s.repository.head.bind(s.repository);s.repository.head=async(tx,row)=>{const value=await head(tx,row);return value?{...value,latestGenerationId:a.generationId}:value;};
  try{expect((await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_READY');expect((await financialCounts(f)).sets).toBe(0);expect(await app.withWorkspace(f.workspaceId,tx=>tx.$queryRaw`SELECT ack_id FROM execution_domain_ack`)).toEqual([]);
  }finally{s.repository.head=head;}
  expect(next.phase).toBe('PREPARED');expect((await s.service.recover(ctx(f),a.generationId)).phase).toBe('NOT_APPLIED');expect(s.state.calls).toBe(1);
 });


 it.each([504,524,'cut'] as const)('r4u: ordinary provider %s keeps paid unknown across same and new intents',async kind=>{
  const error=()=>kind==='cut'?new ProviderTransportError('SYNTHETIC_CUT_STREAM',{inputTokens:4,outputTokens:1,costUsd:0.001},{reasonCode:'CHAT_COMPLETIONS_STREAM_TRUNCATED',provider:'synthetic-b2',model:'synthetic'}):new ProviderHttpError({status:kind,provider:'synthetic-b2',model:'synthetic'});
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{throw error();}}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  expect((await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_UNKNOWN');
  const cold=new MarketCandidateGenerationService(new MarketCandidateGenerationRepository(app),s.authorities,s.store,new MarketCandidateSetsService(app),undefined as never);
  expect((await cold.recover(ctx(f),a.generationId)).phase).toBe('RESULT_UNKNOWN');expect((await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_UNKNOWN');
  const b=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});await expect(s.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant')).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  const operations=await app.withWorkspace(f.workspaceId,tx=>tx.toolBudgetOperation.findMany());expect(operations).toHaveLength(1);expect(operations[0].status).toBe('SETTLED');expect(operations[0].chargedMicrousd).toBeGreaterThan(0n);expect(operations[0].resultSchema).toBeNull();expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
 });
 it.each(['schema','hard-gate'] as const)('r4u: unknown gateway settlement on %s output never becomes a definite failure',async kind=>{
  const f=await fixture(),valid=proposed(f),first=valid.candidates[0];const output=kind==='schema'?{syntheticBadSchema:true} as unknown as GenerationOutput:{...valid,candidates:[{...first,proposal:{...first.proposal,supplyOrCapability:{...first.proposal.supplyOrCapability,offeringId:randomUUID()}}}]} as GenerationOutput;
  const s=system(f,{output,unknownGatewaySettlement:true}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});expect((await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).phase).toBe('RESULT_UNKNOWN');
  const b=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});await expect(s.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant')).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');expect((await s.service.recover(ctx(f),a.generationId)).phase).toBe('RESULT_UNKNOWN');expect(s.state.calls).toBe(1);expect(s.state.requests).toHaveLength(1);
 });
 it('r4u: unclassified settled no-result blocks a new intent even before cold recovery',async()=>{
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{throw new ProviderHttpError({status:504,provider:'synthetic-b2',model:'synthetic'});}}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});const read=s.store.readOperationResult!.bind(s.store);s.store.readOperationResult=async query=>{const value=await read(query);if(value.status==='SETTLED_NO_RESULT')throw Error('synthetic crash after ledger settled before classification');return value;};
  await expect(s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).rejects.toThrow('synthetic crash after ledger settled before classification');const row=await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.findUniqueOrThrow({where:{id:a.generationId}}));expect(row.phase).toBe('RUNNING');
  const cold=system(f),b=await cold.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});await expect(cold.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant')).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');expect(cold.state.calls).toBe(0);expect((await cold.service.recover(ctx(f),a.generationId)).phase).toBe('RESULT_UNKNOWN');expect((await cold.service.get(ctx(f),a.generationId)).phase).toBe('RESULT_UNKNOWN');expect(s.state.calls).toBe(1);expect(await financialCounts(f)).toEqual({authorities:1,attempts:1,operations:1,sets:0});
 });


 it('r4u: legacy unclassified FAILED is not trusted as determinate or allowed a fresh company wire',async()=>{
  const f=await fixture(),s=system(f,{beforeReturn:async()=>{throw new ProviderHttpError({status:504,provider:'synthetic-b2',model:'synthetic'});}}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});
  await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');
  await app.withWorkspace(f.workspaceId,tx=>tx.marketCandidateGeneration.update({where:{id:a.generationId},data:{phase:'FAILED',reasonCode:'EXECUTION_FAILED'}}));
  await expect(s.service.get(ctx(f),a.generationId)).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');await expect(s.service.recover(ctx(f),a.generationId)).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  const b=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});await expect(s.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant')).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');expect(s.state.calls).toBe(1);
 });


 it('r5u: determinate rejected output permits a separately authorised later intent but never same-intent replay',async()=>{
  const f=await fixture(),valid=proposed(f),first=valid.candidates[0];const output={...valid,candidates:[{...first,proposal:{...first.proposal,supplyOrCapability:{...first.proposal.supplyOrCapability,offeringId:randomUUID()}}}]} as GenerationOutput;
  const s=system(f,{output}),a=await s.service.prepare(ctx(f),f.companyId,{intentId:f.intentId});expect((await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant')).reasonCode).toBe('OUTPUT_INVALID');await s.service.execute(ctx(f),a.generationId,{intentDigest:a.intentDigest},'synthetic-owned-grant');expect(s.state.calls).toBe(1);
  const b=await s.service.prepare(ctx(f),f.companyId,{intentId:randomUUID()});expect((await s.service.execute(ctx(f),b.generationId,{intentDigest:b.intentDigest},'synthetic-owned-grant')).reasonCode).toBe('OUTPUT_INVALID');expect(s.state.calls).toBe(2);expect(await financialCounts(f)).toEqual({authorities:2,attempts:2,operations:2,sets:0});
 });

});
