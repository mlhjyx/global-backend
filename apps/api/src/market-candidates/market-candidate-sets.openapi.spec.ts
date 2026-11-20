import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Schema = { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../packages/contracts/openapi/openapi.json'), 'utf8'));
const base = '/api/v1/market-candidate-sets/{setId}';
const operations = [
  ['get', '/api/v1/companies/{companyId}/market-candidate-sets/latest', 'getLatest', 'acquisition:read'],
  ['get', base, 'getCurrent', 'acquisition:read'],
  ['get', `${base}/revisions`, 'listRevisions', 'acquisition:read'],
  ['get', `${base}/revisions/{revision}`, 'getRevision', 'acquisition:read'],
  ['post', `${base}/candidates/{candidateId}/feedback`, 'recordFeedback', 'acquisition:review'],
];

describe('MarketCandidateSets code-first contract', () => {
  it.each(operations)('publishes %s %s with exact operation identity and existing user scope', (method, path, operation, scope) => {
    const op = spec.paths[path]?.[method];
    expect(op).toBeDefined();
    expect(op.operationId).toBe(`MarketCandidateSetsController_${operation}_v1`);
    expect(op['x-required-scopes']).toEqual([scope]);
    expect(op.security).toEqual([{ bearer: [] }]);
    for (const status of ['200','400','401','403','404']) expect(op.responses[status]).toBeDefined();
    if (method === 'post') expect(op.responses['409']).toBeDefined();
  });
  it('does not register any production initial-write/import/generate or history mutation endpoint', () => {
    const entries = Object.entries(spec.paths as Record<string, Record<string, unknown>>).filter(([path]) => path.includes('market-candidate'));
    expect(entries).toHaveLength(5);
    const mutations = entries.flatMap(([path, methods]) => Object.keys(methods).filter(m => ['post','put','patch','delete'].includes(m)).map(m => `${m} ${path}`));
    expect(mutations).toEqual([`post ${base}/candidates/{candidateId}/feedback`]);
  });
  it('requires exactly one lowercase UUID idempotency-key header and a closed feedback body', () => {
    const operation = spec.paths[`${base}/candidates/{candidateId}/feedback`]?.post;
    expect(operation).toBeDefined();
    const headers = operation.parameters.filter((p: {in: string; name: string}) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
    expect(headers).toEqual([{ name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' }, description: '同一意图重试沿用原 UUID；不同意图使用新 key。' }]);
    expect(operation.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/MarketCandidateFeedbackInputDto');
    const schema = spec.components.schemas.MarketCandidateFeedbackInputDto;
    expect(schema.required).toEqual(expect.arrayContaining(['expectedRevision','action']));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.expectedRevision).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schema.properties.action.enum).toEqual(['CONFIRM','CORRECT','KEEP_PENDING','REJECT']);
    expect(schema.properties.reason.nullable).toBe(true);
  });
  it('closes all nested domain schemas without invented identity or fact overrides', () => {
    const schemas = Object.entries(spec.components.schemas as Record<string, Schema>).filter(([name]) => name.startsWith('MarketCandidate'));
    expect(schemas.length).toBeGreaterThan(15);
    for (const [name, schema] of schemas) expect(schema.additionalProperties, name).toBe(false);
    const correction = spec.components.schemas.MarketCandidateCorrectionDto.properties;
    expect(Object.keys(correction).sort()).toEqual(['application','buyerOrganizationCountry','entryConditions','fitExplanation','gaps','nextVerification','organizationRole','projectCountry','supplyDescription']);
    const proposal = spec.components.schemas.MarketCandidateProposalDto.properties;
    expect(proposal.buyerOrganizationCountry.nullable).toBe(true); expect(proposal.projectCountry.nullable).toBe(true);
    expect(spec.components.schemas.MarketCandidateLatestDto.properties.result.nullable).toBe(true);
    expect(spec.components.schemas.MarketCandidateFeedbackResultDto.properties.reason.nullable).toBe(true);
  });
});
