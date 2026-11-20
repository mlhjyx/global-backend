import 'reflect-metadata';
import { ConflictException, NotFoundException, Global, Module, ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { RuntimeWorkAdmissionGuard } from '../runtime/runtime-work-admission.guard';
import type { RuntimeAdmissionService } from '../runtime/runtime-admission';
import type { RuntimeReadinessService } from '../health/runtime-readiness.service';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { createRolesToScopesPolicy, ROLES_TO_SCOPES_POLICY } from '../auth/scopes';
import type { RequestContext } from '../auth/request-context';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { MarketCandidateSetsController } from './market-candidate-sets.controller';
import { MarketCandidateSetsService } from './market-candidate-sets.service';

const companyId = '00000000-0000-4000-8000-000000000001', setId = '00000000-0000-4000-8000-000000000002';
const candidateId = '00000000-0000-4000-8000-000000000003', actorId = '00000000-0000-4000-8000-000000000004';
const workspaceId = '00000000-0000-4000-8000-000000000005', idempotencyKey = '00000000-0000-4000-8000-000000000006';
const calls: Array<{ method: string; ctx: RequestContext; input?: unknown; key?: string }> = [];
const service = {
  getLatest: async (ctx: RequestContext) => { calls.push({ method: 'getLatest', ctx }); return { status: 'NOT_ANALYZED', result: null }; },
  getCurrent: async (ctx: RequestContext, requested: string) => {
    if (requested.endsWith('0099')) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'SYNTHETIC missing set' } });
    calls.push({ method: 'getCurrent', ctx }); return { historical: false };
  },
  listRevisions: async (ctx: RequestContext) => { calls.push({ method: 'listRevisions', ctx }); return { revisions: [], nextCursor: null }; },
  getRevision: async (ctx: RequestContext) => { calls.push({ method: 'getRevision', ctx }); return { historical: true }; },
  recordFeedback: async (ctx: RequestContext, _set: string, _candidate: string, input: unknown, key: string) => {
    if ((input as { expectedRevision: number }).expectedRevision === 99) throw new ConflictException({ error: { code: 'VERSION_CONFLICT', message: 'SYNTHETIC stale revision' } });
    calls.push({ method: 'recordFeedback', ctx, input, key }); return { recordedRevision: 2, replayed: false };
  },
};

@Global()
@Module({ providers: [AuthGuard, ScopesGuard,
  { provide: TokenVerifier, useValue: { verify: async (token: string) => ({ workspaceId, userId: actorId, roles: [token] }) } },
  { provide: ROLES_TO_SCOPES_POLICY, useValue: createRolesToScopesPolicy({ AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({ editor: ['acquisition:read','acquisition:review'], reader: ['acquisition:read'], outsider: [] }) }, 'development') },
] , exports: [AuthGuard, ScopesGuard, TokenVerifier, ROLES_TO_SCOPES_POLICY] })
class AuthTestPorts {}
let admitted = true;
@Module({ imports: [AuthTestPorts], controllers: [MarketCandidateSetsController], providers: [
  { provide: MarketCandidateSetsService, useValue: service },
  { provide: APP_GUARD, inject: [Reflector], useFactory: (reflector: Reflector) => new RuntimeWorkAdmissionGuard(
    { current: () => ({ admitted }) } as unknown as RuntimeAdmissionService,
    { current: () => ({ status: 'ready' }) } as unknown as RuntimeReadinessService,
    reflector,
  ) },
] })
class HttpTestApp {}

describe('market candidate ordinary-user HTTP boundary', () => {
  let app: INestApplication, origin: string;
  const base = `/api/v1/market-candidate-sets/${setId}`;
  const feedback = `${base}/candidates/${candidateId}/feedback`;
  beforeAll(async () => {
    app = await NestFactory.create(HttpTestApp, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api'); app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, '127.0.0.1'); origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app?.close(); });
  const request = (path: string, token?: string, body?: unknown, key: string | undefined = idempotencyKey) => fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key === undefined ? {} : { 'idempotency-key': key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  it('requires login, then independent read or review scopes', async () => {
    expect((await request(base)).status).toBe(401);
    expect((await request(base, 'outsider')).status).toBe(403);
    expect((await request(feedback, 'reader', { expectedRevision: 1, action: 'CONFIRM' })).status).toBe(403);
    expect((await request(base, 'reader')).status).toBe(200);
  });
  it('binds actor/workspace from verified context and passes a normalized, closed intention', async () => {
    const response = await request(feedback, 'editor', { expectedRevision: 1, action: 'KEEP_PENDING', reason: ' \t ' });
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: 'recordFeedback', ctx: { userId: actorId, workspaceId }, input: { expectedRevision: 1, action: 'KEEP_PENDING', reason: null }, key: idempotencyKey });
    expect(await (await request(`/api/v1/companies/${companyId}/market-candidate-sets/latest`, 'reader')).json()).toEqual({ data: { status: 'NOT_ANALYZED', result: null } });
  });
  it.each([
    {}, { expectedRevision: null, action: 'CONFIRM' }, { expectedRevision: 0, action: 'CONFIRM' }, { expectedRevision: 1.2, action: 'CONFIRM' },
    { expectedRevision: '1', action: 'CONFIRM' }, { expectedRevision: 1, action: 'INVALID' },
    { expectedRevision: 1, action: 'CONFIRM', actorId }, { expectedRevision: 1, action: 'CONFIRM', workspaceId },
    { expectedRevision: 1, action: 'CORRECT', correction: {} }, { expectedRevision: 1, action: 'CORRECT', correction: { application: null } },
    { expectedRevision: 1, action: 'CORRECT', correction: { verified: true } }, { expectedRevision: 1, action: 'CORRECT', correction: { application: 'ok', nested: { actorId } } },
    { expectedRevision: 1, action: 'CONFIRM', correction: { application: 'x' } }, { expectedRevision: 1, action: 'CONFIRM', reason: 'x'.repeat(2001) },
  ])('rejects malformed and deep unknown fields before any service invocation: %j', async body => {
    const count = calls.length; const response = await request(feedback, 'editor', body);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('VALIDATION_ERROR'); expect(calls).toHaveLength(count);
  });
  it.each(['', 'not-a-uuid', '1'.repeat(200)])('rejects an invalid idempotency header %s', async key => {
    const count = calls.length; expect((await request(feedback, 'editor', { expectedRevision: 1, action: 'CONFIRM' }, key)).status).toBe(400); expect(calls).toHaveLength(count);
  });
  it('rejects invalid identifiers and page inputs before reading, while keeping history read-only', async () => {
    for (const path of [`${base}/revisions/0`, `${base}/revisions/1.1`, `${base}/revisions?limit=101`, `${base}/revisions?cursor=garbage`, '/api/v1/market-candidate-sets/not-uuid']) {
      const count = calls.length; expect((await request(path, 'reader')).status).toBe(400); expect(calls).toHaveLength(count);
    }
    expect((await request(`${base}/revisions/1`, 'reader')).status).toBe(200);
    expect((await fetch(`${origin}${base}/revisions/1`, { method: 'PATCH', headers: { authorization: 'Bearer editor' } })).status).toBe(404);
  });
  it('preserves explicit 404 and 409 errors rather than converting them into an empty result', async () => {
    const missing = await request('/api/v1/market-candidate-sets/00000000-0000-4000-8000-000000000099', 'reader');
    expect(missing.status).toBe(404); expect((await missing.json()).error.code).toBe('NOT_FOUND');
    const stale = await request(feedback, 'editor', { expectedRevision: 99, action: 'CONFIRM' });
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
  });
  it('rejects a missing idempotency header and unknown pagination keys before invoking a service', async () => {
    const count = calls.length;
    const response = await fetch(`${origin}${feedback}`, { method: 'POST', headers: { authorization: 'Bearer editor', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, action: 'CONFIRM' }) });
    expect(response.status).toBe(400);
    expect((await request(`${base}/revisions?workspaceId=${workspaceId}`, 'reader')).status).toBe(400);
    expect(calls).toHaveLength(count);
  });
  it('inherits the real global write-admission guard without read-only or recovery bypass', async () => {
    const count = calls.length; admitted = false;
    try {
      const response = await request(feedback, 'editor', { expectedRevision: 1, action: 'CONFIRM' });
      expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('RUNTIME_ADMISSION_CLOSED');
      expect(calls).toHaveLength(count);
      expect((await request(base, 'reader')).status).toBe(200);
    } finally { admitted = true; }
  });
  it('has no create/import/generate or activation route', async () => {
    for (const path of ['/api/v1/market-candidate-sets', `${base}/import`, `${base}/generate`, `${base}/activate`]) {
      expect((await request(path, 'editor', {})).status).toBe(404);
    }
  });
});
