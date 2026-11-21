import { ExecutionControlError } from '../execution-budget/execution-control-error';
import 'reflect-metadata';
import { Global, Module, ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { createRolesToScopesPolicy, ROLES_TO_SCOPES_POLICY } from '../auth/scopes';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { RuntimeWorkAdmissionGuard } from '../runtime/runtime-work-admission.guard';
import type { RuntimeAdmissionService } from '../runtime/runtime-admission';
import type { RuntimeReadinessService } from '../health/runtime-readiness.service';
import { EXECUTION_BUDGET_GRANT_HEADER } from '../execution-budget/execution-budget-grant.decorator';
import { MarketCandidateGenerationsController } from './generation.controller';
import { MarketCandidateGenerationService } from './generation.service';

const companyId='22222222-2222-4222-8222-222222222222',generationId='66666666-6666-4666-8666-666666666666';
const workspaceId='11111111-1111-4111-8111-111111111111',userId='55555555-5555-4555-8555-555555555555',intentId='77777777-7777-4777-8777-777777777777';
const view={generationId,companyId,intentId,intentDigest:'a'.repeat(64),phase:'PREPARED',reasonCode:null,set:null,execution:null,preparedAt:'2026-11-20T00:00:00.000Z',updatedAt:'2026-11-20T00:00:00.000Z'};
let serviceFailure:unknown;
const calls:Array<{name:string;args:unknown[]}>=[];
const service=Object.fromEntries(['prepare','get','execute','recover'].map(name=>[name,async(...args:unknown[])=>{if(serviceFailure)throw serviceFailure;calls.push({name,args});return {...view,phase:name==='execute'?'RUNNING':name==='recover'?'RESULT_READY':'PREPARED'};} ]));
@Global()
@Module({providers:[AuthGuard,ScopesGuard,{provide:TokenVerifier,useValue:{verify:async(token:string)=>({workspaceId,userId,roles:[token]})}},
 {provide:ROLES_TO_SCOPES_POLICY,useValue:createRolesToScopesPolicy({AUTH_ROLE_SCOPE_MAP_JSON:JSON.stringify({writer:['acquisition:read','acquisition:write'],reader:['acquisition:read'],outsider:[]})},'development')}],
 exports:[AuthGuard,ScopesGuard,TokenVerifier,ROLES_TO_SCOPES_POLICY]})
class AuthPorts{}
let admitted=true;
@Module({imports:[AuthPorts],controllers:[MarketCandidateGenerationsController],providers:[{provide:MarketCandidateGenerationService,useValue:service},
 {provide:APP_GUARD,inject:[Reflector],useFactory:(reflector:Reflector)=>new RuntimeWorkAdmissionGuard({current:()=>({admitted})}as unknown as RuntimeAdmissionService,{current:()=>({status:'ready'})}as unknown as RuntimeReadinessService,reflector)}]})
class HttpApp{}

describe('generation real ordinary-user HTTP and global-admission boundary',()=>{
 let app:INestApplication,origin:string;
 const prepare=`/api/v1/companies/${companyId}/market-candidate-generations`,base=`/api/v1/market-candidate-generations/${generationId}`;
 beforeAll(async()=>{app=await NestFactory.create(HttpApp,{logger:false,abortOnError:false});app.setGlobalPrefix('api');app.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));app.useGlobalFilters(new GlobalHttpExceptionFilter());await app.listen(0,'127.0.0.1');origin=`http://127.0.0.1:${(app.getHttpServer().address()as AddressInfo).port}`;});
 afterAll(async()=>{await app?.close();});beforeEach(()=>{admitted=true;calls.length=0;serviceFailure=undefined;});
 const request=(path:string,token?:string,body?:unknown)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'content-type':'application/json'}),[EXECUTION_BUDGET_GRANT_HEADER]:'synthetic-not-a-real-grant'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 it('requires login and independent read/write scopes rather than possession of a UUID',async()=>{
  expect((await request(base)).status).toBe(401);expect((await request(base,'outsider')).status).toBe(403);
  for(const[path,body]of [[prepare,{intentId}],[base+'/execute',{intentDigest:view.intentDigest}],[base+'/recover',{}]]as const)
   expect((await request(path,'reader',body)).status).toBe(403);
  expect((await request(base,'reader')).status).toBe(200);expect(calls.map(x=>x.name)).toEqual(['get']);
 });
 it('normalizes the closed prepare body and binds actor/workspace only from authenticated context',async()=>{
  const offeringId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const response=await request(prepare,'writer',{intentId,offeringIds:[offeringId.toUpperCase(),offeringId]});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({data:view});
  expect(calls[0]).toMatchObject({name:'prepare',args:[{workspaceId,userId},companyId,{intentId,offeringIds:[offeringId]}]});
 });
 it('routes execute with the exact intent digest and grant header, returning 202 only for pending domain states',async()=>{
  const response=await request(base+'/execute','writer',{intentDigest:view.intentDigest});expect(response.status).toBe(202);
  expect(calls[0]).toMatchObject({name:'execute',args:[{workspaceId,userId},generationId,{intentDigest:view.intentDigest},'synthetic-not-a-real-grant']});
  expect((await response.json()).data.phase).toBe('RUNNING');
 });
 it('routes recovery as a write-scoped zero-dispatch operation without a grant parameter',async()=>{
  const response=await request(base+'/recover','writer',{});expect(response.status).toBe(202);
  expect(calls[0]).toMatchObject({name:'recover',args:[{workspaceId,userId},generationId]});expect(calls[0].args).toHaveLength(2);
 });
 it.each([{intentId,userId},{intentId,workspaceId},{intentId,candidates:[]},{intentId,offeringIds:['bad']},{intentId,claimIds:null}])('rejects an unknown or malformed prepare field before calling the service: %j',async body=>{
  expect((await request(prepare,'writer',body)).status).toBe(400);expect(calls).toEqual([]);
 });
 it.each([{}, {intentDigest:'b'}, {intentDigest:'A'.repeat(64)}, {intentDigest:view.intentDigest,authorityId:intentId},{intentDigest:view.intentDigest,actor:userId}])('rejects altered execute material rather than stripping it: %j',async body=>{
  expect((await request(base+'/execute','writer',body)).status).toBe(400);expect(calls).toEqual([]);
 });
 it('does not give recover a control-plane or recovery exemption when global write admission is closed',async()=>{
  admitted=false;
  for(const[path,body]of [[prepare,{intentId}],[base+'/execute',{intentDigest:view.intentDigest}],[base+'/recover',{}]]as const){const response=await request(path,'writer',body);expect(response.status).toBe(503);expect((await response.json()).error.code).toBe('RUNTIME_ADMISSION_CLOSED');}
  expect(calls).toEqual([]);expect((await request(base,'reader')).status).toBe(200);
 });
 it('rejects invalid paths and recovery bodies without granting a hidden mutation entry',async()=>{
  expect((await request('/api/v1/market-candidate-generations/not-uuid','reader')).status).toBe(400);
  expect((await request(base+'/recover','writer',{retry:true})).status).toBe(400);expect(calls).toEqual([]);
 });
 it('maps an unavailable trusted execution reader to controlled 503 on every domain entry, never internal 500 or fake empty data',async()=>{
  serviceFailure=new ExecutionControlError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  for(const[path,body]of [[prepare,{intentId}],[base,undefined],[base+'/execute',{intentDigest:view.intentDigest}],[base+'/recover',{}]]as const){
   const response=await request(path,'writer',body);expect(response.status).toBe(503);expect((await response.json()).error.code).toBe('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  }
 });
 it('reports full required-context rejection as a precondition error rather than a model failure or silent truncation',async()=>{
  serviceFailure=new Error('required context segments exceed the model context budget');
  const response=await request(prepare,'writer',{intentId});expect(response.status).toBe(400);expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
 });

});
