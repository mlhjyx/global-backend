import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('suppression external-action and PII projection topology', () => {
  it('threads one optional authorization callback through acquisition, tool, and model contexts', () => {
    const providerContract = read('apps/api/src/discovery/provider-contract.ts');
    const toolContract = read('apps/api/src/tools/tool-contract.ts');
    const modelContract = read('apps/api/src/model-gateway/types.ts');
    expect(providerContract).toContain('authorizeExternalAction?:');
    expect(toolContract).toContain('authorizeExternalAction?:');
    expect(modelContract).toContain('authorizeExternalAction?:');
  });

  it('enforces the callback at ToolBroker and RouterModelGateway physical-call boundaries', () => {
    const broker = read('apps/api/src/tools/tool-broker.ts');
    const router = read('apps/api/src/model-gateway/router-model-gateway.ts');
    expect(broker).toContain('await ctx.authorizeExternalAction()');
    expect(router).toContain('await ctx.authorizeExternalAction()');
    expect(router).toContain('suppression_action_gate');
  });

  it('threads the callback through multi-wire acquisition providers instead of rebuilding a narrower context', () => {
    for (const provider of [
      'bigquery-patents.provider.ts',
      'companies-house.provider.ts',
      'decision-maker.provider.ts',
      'public-web.provider.ts',
      'structured-harvest.provider.ts',
      'digital-footprint.provider.ts',
      'inpi-rne.provider.ts',
      'openfda.provider.ts',
      'osm.provider.ts',
      'ted.provider.ts',
      'wikidata.provider.ts',
    ]) {
      const source = read(`apps/api/src/discovery/providers/${provider}`);
      expect(source).toMatch(/\.\.\.ctx[,}\s]/);
    }
  });

  it('manual email guessing authorizes each candidate while backlog is parked before any candidate', () => {
    const service = read('apps/api/src/discovery/discovery.service.ts');
    const manual = service.slice(service.indexOf('async guessEmailsForCompany'), service.indexOf('async verifyContactPoint'));
    const backlogSource = read('apps/api/src/temporal/backlog.activities.ts');
    const backlog = backlogSource.slice(
      backlogSource.indexOf('async guessEmailsBacklog'),
      backlogSource.indexOf('export type BacklogActivities'),
    );
    expect(manual).toContain('authorizeCandidate:');
    expect(backlog).toContain('return authorityHold()');
    expect(backlog).not.toContain('authorizeCandidate:');
  });

  it('multi-wire source adapters recheck authorization inside pagination, retry, and fallback loops', () => {
    for (const adapter of [
      'bigquery-patents.ts',
      'companies-house.ts',
      'gleif.ts',
      'inpi-rne.ts',
      'openfda-api.ts',
      'openstreetmap.ts',
      'ted-api.ts',
      'trade-fair-algolia.ts',
      'wikidata.ts',
    ]) {
      const source = read(`apps/api/src/adapters/${adapter}`);
      expect(source).toContain('beforeRequest');
      expect(source).toContain('await beforeRequest?.()');
    }
    expect(read('apps/api/src/tools/source-tools.ts')).toContain(
      'beforeExternalRequest(ctx)',
    );
    expect(read('apps/api/src/tools/builtin-tools.ts')).toContain(
      'beforeExternalRequest(ctx)',
    );
  });

  it('the acquisition-read company list cannot project named contacts or contact points', () => {
    const service = read('apps/api/src/discovery/discovery.service.ts');
    const list = service.slice(service.indexOf('listCanonicalCompanies'), service.indexOf('async getCanonicalCompany'));
    expect(list).not.toContain('contacts');
    expect(list).not.toContain('contactPoints');
  });
});
