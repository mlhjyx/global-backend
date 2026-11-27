import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../model-gateway/model-router';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import { PrismaService } from '../prisma/prisma.service';
import { parseDiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { claimDiscoveryV3Dispatch } from '../temporal/discovery-v3.worker-activities';
import { formatTenantWorkflowId } from '../temporal/tenant-workflow-id';
import { searxngSearchTool } from '../tools/builtin-tools';
import { RateLimiter } from '../tools/rate-limiter';
import { serperSearchTool } from '../tools/search-provider-tools';
import { ToolBroker } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import { admitDiscoveryV3 } from './discovery-v3-admission';
import { DiscoveryV3OperationStore } from './discovery-v3-operations';
import { createDiscoveryV3PublicWebSource } from './discovery-v3-public-web';
import type { CompanyDiscoveryQuery } from './provider-contract';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (adminUrl && appUrl) {
  for (const value of [adminUrl, appUrl]) {
    const url = new URL(value);
    if (url.hostname !== '127.0.0.1' || url.port === '15433' || !url.pathname.endsWith('_test')) {
      throw new Error('DISCOVERY_V3_PUBLIC_WEB_REQUIRES_FIXTURE_DATABASE');
    }
  }
}

async function fixture(includeSerper: boolean, interruptAfterFirstModel = false) {
  const owner = new PrismaClient({ datasourceUrl: adminUrl });
  const app = new PrismaService();
  try {
    for (const variable of ['SERPER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'EXA_API_KEY', 'GOOGLE_MAPS_API_KEY']) {
      vi.stubEnv(variable, undefined);
    }
    if (includeSerper) vi.stubEnv('SERPER_API_KEY', 'fixture-only');
    const workspaceId = randomUUID();
    const actor = randomUUID();
    const domain = `public-web-v3-${workspaceId.slice(0, 8)}.example`;
    const evidenceUrl = `https://${domain}/industrial-pumps`;
    const unresolvedDomain = `unresolved-${domain}`;
    const query: CompanyDiscoveryQuery = {
      sourceClass: 'public_intelligence', keywords: ['industrial pumps'], filters: { country: 'DE', source_hint: 'public_web' }, limit: 5,
    };
    await owner.workspace.create({ data: { id: workspaceId, name: 'Public web v3 fixture' } });
    const seller = await owner.companyProfile.create({ data: { workspaceId, name: 'Fixture seller' } });
    const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: seller.id, name: 'Fixture ICP' } });
    const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, status: 'READY', queries: [{
      source_class: query.sourceClass, filters: query.filters as { country: string; source_hint: string }, keywords: query.keywords,
    }] } });
    await owner.dataProvider.upsert({ where: { key: 'public_web' }, create: {
      key: 'public_web', class: 'public_intelligence', status: 'ENABLED',
    }, update: { status: 'ENABLED' } });
    const fixtureDomains = interruptAfterFirstModel ? [domain, unresolvedDomain] : [domain];
    await owner.sourcePolicy.createMany({ data: fixtureDomains.map((domain) => ({
      domain, sourceType: 'official_website', accessMode: 'crawl', allowedPurpose: ['discovery'],
      reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', retentionDays: 30,
    })) });
    const admitted = await admitDiscoveryV3(app, { workspaceId, userId: actor, roles: ['saas-admin'] }, plan.id, {},
      { taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true } });
    const outbox = await owner.outboxEvent.findFirstOrThrow({ where: { workspaceId, aggregateId: admitted.runId, eventType: 'DiscoveryRunRequested' } });
    const command = parseDiscoveryV3Dispatch(outbox.payload);
    const workflow = formatTenantWorkflowId(workspaceId, 'discovery', command.runId);
    expect(await claimDiscoveryV3Dispatch(app, command, workflow, true)).toBe(true);
    await app.withWorkspace(workspaceId, (tx) => tx.discoveryRun.update({ where: { id: command.runId }, data: { v3SourceRoutes: [['public_web']] } }));

    const results = [{ url: `${evidenceUrl}?trace=sample`, title: 'Acme industrial pumps' }];
    if (interruptAfterFirstModel) results.push({ url: `https://${unresolvedDomain}/catalog`, title: 'Synthetic pump catalog' });
    const searx = vi.fn(async () => ({ data: { results: includeSerper ? [] : results }, costCents: 0 }));
    const serper = vi.fn(async () => ({ data: { results: [{ url: `${evidenceUrl}?trace=sample`, title: 'Acme industrial pumps' }] }, costCents: 1 }));
    const tools = new ToolRegistry();
    tools.register({ ...searxngSearchTool, executeDiscoveryV3: (_, context) => context.dispatchDiscoveryV3Wire!(searx) });
    tools.register({ ...serperSearchTool, executeDiscoveryV3: (_, context) => context.dispatchDiscoveryV3Wire!(serper) });
    const broker = new ToolBroker({ registry: tools, limiter: new RateLimiter(), legacyBudgetMode: 'enforce' });
    const generateStructured = vi.fn(async (input: { prompt: string }) => {
      if (interruptAfterFirstModel && input.prompt.includes(unresolvedDomain)) throw new Error('FIXTURE_MODEL_CONNECTION_LOST');
      return {
        data: { is_company_site: true, name: 'Acme Pumps GmbH', country: 'Germany', products: [], keywords: [] },
        provider: 'fixture-model', model: 'fixture-model',
      };
    });
    const gateway = new RouterModelGateway({ route: () => [{ id: 'fixture-model', generateStructured }] } as unknown as ModelRouter);
    const execute = createDiscoveryV3PublicWebSource({ prisma: app, gateway, broker, operationStore: new DiscoveryV3OperationStore(app) });
    const invoke = (attempt: number) => execute(command, query, 0, new AbortController().signal, attempt, async () => true);

    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'fixture-only');
    await expect(invoke(1)).rejects.toThrow('DISCOVERY_V3_PUBLIC_WEB_SEARCH_ROUTE_UNAVAILABLE');
    expect(searx).not.toHaveBeenCalled();
    expect(serper).not.toHaveBeenCalled();
    vi.stubEnv('BRAVE_SEARCH_API_KEY', undefined);

    if (interruptAfterFirstModel) {
      await expect(invoke(1)).rejects.toThrow('FIXTURE_MODEL_CONNECTION_LOST');
      expect(await owner.discoveryV3Operation.count({ where: { workspaceId, action: 'discovery.extract_company', status: 'UNKNOWN' } })).toBe(1);
    } else {
      await invoke(1);
    }
    const before = { searx: searx.mock.calls.length, serper: serper.mock.calls.length, model: generateStructured.mock.calls.length };
    expect(before.searx).toBeGreaterThan(0);
    expect(before.serper).toBe(includeSerper ? before.searx : 0);
    expect(before.model).toBe(interruptAfterFirstModel ? 2 : 1);
    expect(await claimDiscoveryV3Dispatch(app, command, workflow, true, 2)).toBe(true);
    // Optional provider configuration no longer matters to an already consumed scope.
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'fixture-only');
    vi.stubEnv('SERPER_API_KEY', includeSerper ? undefined : 'fixture-only');
    if (interruptAfterFirstModel) {
      await expect(invoke(2)).rejects.toThrow('DISCOVERY_V3_PUBLIC_WEB_INTERRUPTED');
    } else {
      await invoke(2);
    }
    expect({ searx: searx.mock.calls.length, serper: serper.mock.calls.length, model: generateStructured.mock.calls.length }).toEqual(before);

    const link = await owner.discoveryV3RawLink.findFirstOrThrow({ where: { workspaceId }, include: { raw: true, operation: true } });
    expect(link.raw).toMatchObject({ sourceUrl: evidenceUrl, externalId: domain, providerKey: 'public_web', parserVersion: 'public_web/v3', ingestStatus: 'ACCEPTED' });
    expect(link.operation).toMatchObject({ action: 'discovery.extract_company', status: 'SUCCEEDED' });
    expect(link.operation.ack).toMatch(/^[a-f0-9]{64}$/u);
    expect(await owner.identityLink.count({ where: { workspaceId, rawRecordId: link.rawRecordId } })).toBe(1);
    const search = await owner.discoveryV3Operation.findFirstOrThrow({ where: { workspaceId, action: includeSerper ? 'serper.search' : 'searxng.search' } });
    expect(search.ack).toBe(link.operation.ack);
    await expect(app.withWorkspace(workspaceId, (tx) => tx.discoveryV3RawLink.create({ data: {
      workspaceId, rawRecordId: link.rawRecordId, queryOrdinal: 0, recordIndex: 0,
      operationId: search.id, rawPayloadSha256: link.rawPayloadSha256,
    } }))).rejects.toThrow('DISCOVERY_V3_RAW_LINK_MISMATCH');
    expect(await owner.discoveryV3RawLink.count({ where: { workspaceId } })).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
}

describe.runIf(Boolean(adminUrl && appUrl))('Discovery v3 public web with isolated PostgreSQL', () => {
  it('accepts only the checked SearXNG-to-model proof and replays without provider requests', () => fixture(false), 45_000);
  it('pins the optional Serper route and binds an original Serper evidence URL', () => fixture(true), 45_000);
  it('keeps prior proven Raw results and leaves the later unknown wire parked across Workers', () => fixture(false, true), 45_000);
});
