import { randomBytes, randomUUID } from 'node:crypto';
import { writeChannelRecordReview } from '../channels/channel-record-review';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Client, Connection } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { describe, expect, it, vi } from 'vitest';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import { ModelRouter } from '../model-gateway/model-router';
import { ModelProviderRegistry } from '../model-gateway/model-provider.registry';
import { NewApiRequestBoundSettlementResolver, NEW_API_SETTLEMENT_READBACK_CONTRACT } from '../model-gateway/new-api-request-bound-settlement';
import { SettlementDerivationKeyring } from '../model-gateway/settlement-wire-identity';
import { createPrismaTenantDailyCostReader } from '../model-gateway/tenant-daily-cost-breaker';
import { ProviderOutputError } from '../model-gateway/providers/provider-output-error';
import { OpenAICompatibleProvider } from '../model-gateway/providers/openai-compatible.provider';
import { projectModelResultForReplay } from '../durable-results/model-result-replay';
import { createSerperSearchTool } from '../tools/search-provider-tools';
import { ToolBroker } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import { RateLimiter } from '../tools/rate-limiter';
import { serperSearch } from '../adapters/search-providers';
import { crawl4aiFetchTool, osmOverpassTool, searxngSearchTool, wikidataTool } from '../tools/builtin-tools';
import { httpGetTool } from '../tools/source-tools';
import { DiscoveryProviderRegistry } from './provider.registry';
import { createNativeDiscoveryV3Executor } from '../temporal/discovery-v3-native-executor';
import type { Prisma } from '@prisma/client';
import { withDiscoveryV3OperationScope } from './discovery-v3-operation-scope';
import { PrismaService } from '../prisma/prisma.service';
import { formatTenantWorkflowId } from '../temporal/tenant-workflow-id';
import { claimDiscoveryV3Dispatch, createDiscoveryV3WorkerActivities } from '../temporal/discovery-v3.worker-activities';
import { DISCOVERY_V3_WORKFLOW, parseDiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { admitDiscoveryV3, type DiscoveryV3AdmissionRequest } from './discovery-v3-admission';
import { finalizeDiscoveryV3, readDiscoveryV3RunForUpdate } from './discovery-v3-terminal';
import { DISCOVERY_V3_ROBOTS_PROOF, DiscoveryV3OperationStore } from './discovery-v3-operations';
import { COMPANY_INPUT, CONFIG, SPAN, TEXT } from './manufacturer-network.test-fixture';
import { companyIdentity } from './identity';
import { ArtifactSubjectBindingContract } from '../durable-results/artifact/artifact-subject-binding.contract';
import { DiscoveryV3ArtifactExecution } from '../durable-results/artifact/discovery-v3-artifact.execution';
import { DiscoveryV3ArtifactRepository } from '../durable-results/artifact/discovery-v3-artifact.repository';
import { createDiscoveryV3ArtifactExecutionFromEnv, productArtifactMaterializerRegistry } from '../durable-results/artifact/generic-operation-artifact.runtime';
import { S3GenericOperationArtifactStore } from '../durable-results/artifact/generic-operation-artifact.store';
import { BUCKET, MemoryS3Client } from '../durable-results/artifact/generic-operation-artifact.store.spec-helper';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const temporalAddress = process.env.DISCOVERY_V3_TEST_TEMPORAL;
if (temporalAddress && !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(temporalAddress)) {
  throw new Error('discovery v3 test requires a loopback Temporal server');
}
if (temporalAddress) Runtime.install({ logger: new DefaultLogger('ERROR') });
if (adminUrl && process.env.APP_DATABASE_URL) {
  for (const url of [adminUrl, process.env.APP_DATABASE_URL]) {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.port === '15433' || !parsed.pathname.endsWith('_test')) {
      throw new Error('discovery v3 operations require a loopback test database');
    }
  }
}
const options = { taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true } };
const operation = {
  step: 'fit/company-a', kind: 'MODEL', ordinal: 1, requestSha256: 'b'.repeat(64),
  provider: 'model-fixture', action: 'discovery.qualify_fit', method: 'generateStructured',
  maxDurationMs: 5_000,
} as const;

async function fixture<T>(test: (input: {
  owner: PrismaClient;
  app: PrismaService;
  store: DiscoveryV3OperationStore;
  command: ReturnType<typeof parseDiscoveryV3Dispatch>;
}) => Promise<T>, queries: Prisma.InputJsonArray = [], deferClaim = false, admission: DiscoveryV3AdmissionRequest = {}): Promise<T> {
  const owner = new PrismaClient({ datasourceUrl: adminUrl });
  const app = new PrismaService();
  try {
    const workspaceId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'V3 operation fixture' } });
    const company = await owner.companyProfile.create({ data: { workspaceId, name: 'Fixture seller' } });
    const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: company.id, name: 'Fixture ICP' } });
    const plan = await owner.discoveryQueryPlan.create({ data: {
      workspaceId, icpId: icp.id, status: 'READY', queries,
    } });
    const run = await admitDiscoveryV3(app, { workspaceId, userId: randomUUID(), roles: ['saas-admin'] }, plan.id, admission, options);
    const event = await owner.outboxEvent.findFirstOrThrow({ where: {
      workspaceId, aggregateId: run.runId, eventType: 'DiscoveryRunRequested',
    } });
    const command = parseDiscoveryV3Dispatch(event.payload);
    if (!deferClaim) {
      expect(await claimDiscoveryV3Dispatch(app, command, formatTenantWorkflowId(workspaceId, 'discovery', run.runId), true)).toBe(true);
    }
    return await test({ owner, app, command, store: new DiscoveryV3OperationStore(app) });
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
}

async function runV3Worker(
  address: string, command: ReturnType<typeof parseDiscoveryV3Dispatch>,
  activities: ReturnType<typeof createDiscoveryV3WorkerActivities>,
): Promise<void> {
  const [workerConnection, clientConnection] = await Promise.all([
    NativeConnection.connect({ address }), Connection.connect({ address }),
  ]);
  try {
    const namespace = `discovery-v3-fixture-${randomUUID()}`;
    const client = new Client({ connection: clientConnection, namespace });
    await client.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86400 } });
    const worker = await Worker.create({
      connection: workerConnection, namespace, taskQueue: command.taskQueue,
      workflowsPath: fileURLToPath(new URL('../temporal/customer-workflows.ts', import.meta.url)), activities,
    });
    await worker.runUntil(() => client.workflow.execute(DISCOVERY_V3_WORKFLOW, {
      taskQueue: command.taskQueue, args: [command],
      workflowId: formatTenantWorkflowId(command.workspaceId, 'discovery', command.runId),
    }));
  } finally {
    await Promise.all([workerConnection.close(), clientConnection.close()]);
  }
}

function discoveryGatewayFixture(workspaceId: string) {
  const origin = 'http://127.0.0.1:18462';
  const alias = 'deepseek-v4-flash';
  const requests = new Map<string, string>();
  const readbacks = new Set<string>();
  const fitRequest = vi.fn();
  const fetchFixture: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error('unexpected discovery fixture destination');
    if (url.pathname === '/v1/chat/completions') {
      const id = request.headers.get('x-new-api-settlement-request-id');
      if (!id || requests.has(id) || !request.headers.get('x-new-api-settlement-nonce')) throw new Error('invalid fixture request binding');
      const body = await request.json() as { model: string; response_format?: unknown; messages: unknown };
      requests.set(id, body.model);
      const role = JSON.stringify(body.response_format ?? {}).includes('"trade_role"') ||
        JSON.stringify(body.messages).includes('品类上下文');
      if (!role) fitRequest(JSON.stringify(body.messages));
      const data = role ? { trade_role: 'distributor', confidence: 0.9, own_manufacturing: false,
        carried_brands: [], evidence: ['Authorized distributor'] } :
        { verdict: 'match', material_gate: 'pass', role_gate: 'pass', process_gate: 'pass',
          business_model_gate: 'pass', reasons: ['Synthetic buyer evidence'] };
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, cost: 890, currency: 'USD' } });
    }
    if (url.pathname === '/api/settlement-readback/v1') {
      const id = url.searchParams.get('request_id');
      if (!id || !requests.has(id) || readbacks.has(id)) throw new Error('invalid fixture readback');
      readbacks.add(id);
      return Response.json({ data: [{
        request_id: id, type: 'consume', model_name: requests.get(id), channel_id: 91, quota: '1250',
        prompt_tokens: 120, completion_tokens: 30, usage_semantic: 'openai',
        cache_creation_tokens: 0, cache_read_tokens: 0, upstream_id_state: 'observed',
        actual_charge: { currency: 'USD', amount_micros: '3871' },
      }] }, { headers: { 'cache-control': 'no-store', 'x-new-api-settlement-contract': NEW_API_SETTLEMENT_READBACK_CONTRACT } });
    }
    throw new Error('unexpected discovery fixture endpoint');
  };
  const registry = new ModelProviderRegistry();
  registry.register(new OpenAICompatibleProvider({
    id: 'gateway', baseUrl: `${origin}/v1`, apiKey: 'fixture-generation', model: alias,
    tenantApiKeys: new Map([[workspaceId, 'fixture-tenant-generation']]),
  }));
  const runtime = { gatewayOrigin: origin, keyring: new SettlementDerivationKeyring([
    { id: 'discovery-fixture', status: 'ACTIVE', material: Buffer.alloc(32, 45) },
  ]), resolver: new NewApiRequestBoundSettlementResolver({
    gatewayOrigin: origin, readerCredential: `srb1.${'D'.repeat(16)}.${'R'.repeat(43)}`,
    resolverId: 'new-api-request-bound-reconciliation-v1', maximumProbeDurationMs: 500,
  }, { fetch: fetchFixture, wait: async () => undefined }) };
  return {
    gateway: Object.assign(new RouterModelGateway(new ModelRouter(registry)), { discoveryV3SettlementReadback: runtime }),
    fetchFixture, requests, readbacks, fitRequest,
  };
}

describe.skipIf(!adminUrl || !process.env.APP_DATABASE_URL)('discovery v3 operations on PostgreSQL', () => {
  const catalogTerm = `v3catalogfixture${randomBytes(6).toString('hex')}`;

  it('freezes the original public-web search selection without creating a billable wire', () => fixture(async ({ command, owner, store }) => {
    const first = await store.publicWebSearchPlan(command, 0, 1, true);
    expect(first.includeSerper).toBe(true);
    await expect(store.publicWebSearchPlan(command, 0, 1, false)).resolves.toEqual(first);
    const row = await owner.discoveryV3Operation.findUniqueOrThrow({ where: { id: first.link.operationId } });
    expect(row).toMatchObject({ step: 'query/0/public_web/plan', method: 'local-query', status: 'SUCCEEDED', sendAuthorizedAt: null });
    expect(await owner.usageLedger.findUnique({ where: { id: row.id } })).toBe(null);
  }));

  it('freezes channel catalog Raw proof without registering a physical send or provider usage', () => fixture(async ({
    app, owner, command,
  }) => {
    const channel = await owner.sourceChannel.create({ data: {
      name: 'Synthetic catalog fixture', category: 'trade_fair', mode: 'crawl', config: {}, status: 'ENABLED',
    } });
    const source = await owner.sourceChannelRecord.create({ data: {
      channelId: channel.id, crawlRunId: randomUUID(), dedupeKey: randomUUID(), name: 'Synthetic catalog buyer',
      country: 'Italy', industry: catalogTerm, sourceUrl: 'https://synthetic-catalog.example/directory',
      contentHash: '1'.repeat(64),
    } });
    await owner.$transaction((tx) => writeChannelRecordReview(tx, {
      channelId: channel.id, recordIds: [source.id], versions: [{ id: source.id, content_hash: source.contentHash! }],
      verdict: 'APPROVED', reviewedBy: randomUUID(),
    }));
    await owner.sourceChannelRecord.createMany({ data: [
      { channelId: channel.id, crawlRunId: randomUUID(), dedupeKey: randomUUID(), name: 'Synthetic unreviewed buyer',
        country: 'Italy', industry: catalogTerm, sourceUrl: source.sourceUrl, contentHash: '2'.repeat(64) },
      { channelId: channel.id, crawlRunId: randomUUID(), dedupeKey: randomUUID(), name: 'Synthetic changed buyer',
        country: 'Italy', industry: catalogTerm, sourceUrl: source.sourceUrl, reviewStatus: 'APPROVED',
        reviewedBy: randomUUID(), reviewedAt: new Date(), contentHash: '3'.repeat(64), reviewedContentHash: '4'.repeat(64) },
    ] });
    await owner.dataProvider.upsert({ where: { key: 'channel_catalog' }, create: {
      key: 'channel_catalog', class: 'industry_data', status: 'ENABLED',
    }, update: { status: 'ENABLED' } });
    await owner.sourcePolicy.upsert({ where: { domain: 'synthetic-catalog.example' }, create: {
      domain: 'synthetic-catalog.example', sourceType: 'directory', accessMode: 'api', reviewStatus: 'APPROVED',
      termsStatus: 'REVIEWED_OK', allowedPurpose: ['discovery'], retentionDays: 30,
    }, update: { reviewStatus: 'APPROVED' } });
    const providers = new DiscoveryProviderRegistry({ prisma: app });
    const model = vi.fn().mockImplementation(async (request) => ({ data: {
      verdict: 'weak', material_gate: 'unclear', role_gate: 'unclear', process_gate: 'unclear', business_model_gate: 'unclear',
      reasons: ['Synthetic'],
    }, provider: 'fixture-model', model: request.model }));
    const gateway = new RouterModelGateway({ route: () => [{ id: 'fixture-model', generateStructured: model }] } as unknown as ModelRouter);
    const executor = createNativeDiscoveryV3Executor({ prisma: app, providers, gateway });
    const first = await executor.execute(command, new AbortController().signal, 1);
    expect(first.summary).toMatchObject({ queriesSucceeded: 1, rawCount: 1, canonicalCount: 1 });
    const newlyEnabled = vi.fn(async () => { throw new Error('a replay must not include a newly enabled source'); });
    const current = providers.routeCompanyDiscovery.bind(providers);
    vi.spyOn(providers, 'routeCompanyDiscovery').mockImplementation(async (tx, sourceClass) => [
      ...await current(tx, sourceClass), { key: 'channel_catalog_later', classes: ['industry_data'], discoverCompanies: newlyEnabled },
    ]);
    await expect(executor.execute(command, new AbortController().signal, 1)).resolves.toEqual(first);
    expect(newlyEnabled).not.toHaveBeenCalled();
    const link = await owner.discoveryV3RawLink.findFirstOrThrow({ where: { workspaceId: command.workspaceId }, include: { raw: true, operation: true } });
    expect(link.raw).toMatchObject({ externalId: `channel_catalog:${channel.id}:${source.id}`, ingestStatus: 'ACCEPTED' });
    expect(link.operation).toMatchObject({ action: 'channel_catalog.query', sendAuthorizedAt: null, status: 'SUCCEEDED' });
    expect(await owner.usageLedger.count({ where: { id: link.operationId } })).toBe(0);
  }, [{ source_class: 'industry_data', filters: { source_hint: 'channel_catalog', country: 'IT', industry: catalogTerm },
    keywords: [catalogTerm], priority: 1 }]), 30_000);

  it('bounds readback by its original model wire and keeps late exact cost evidence recoverable', () => fixture(async ({ command, app, owner, store }) => {
    const original = await store.claim(command, operation);
    if (original.status !== 'CLAIMED') throw new Error('expected original claim');
    const binding = {
      identity: { schemaVersion: 'site-build-settlement-wire-identity/v1', physicalWireAttempt: 1,
        requestId: randomBytes(32).toString('base64url'), derivationKeyId: 'fixture', nonceSha256: 'a'.repeat(64) },
      alias: 'fixture-model', protocol: 'openai-chat-completions', maxOutputTokens: 120,
      gatewayOrigin: 'https://gateway.example', credentialSha256: 'e'.repeat(64),
    } as const;
    await store.authorizeSend(command, operation, original, 1, binding);
    await expect(store.claimModelReadbackProbe(command, operation, original.operationId, { ...binding, alias: 'other' }, 1))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT' });
    const probeId = await store.claimModelReadbackProbe(command, operation, original.operationId, binding, 1);
    expect(probeId).toBeTypeOf('string');
    await expect(store.claimModelReadbackProbe(command, operation, original.operationId, binding, 1)).resolves.toBe(null);
    const observedAt = new Date();
    await store.recordModelReadbackProbe(command, operation, original.operationId, binding, {
      probeId: probeId!, probe: { sequence: 1, phase: 'gateway_log_pending', httpStatusClass: 2 }, observedAt,
    });
    const unverifiedPayment = {
      basis: 'PROVIDER_REPORTED', currency: 'USD', amountMicros: 1810, evidenceSha256: '7'.repeat(64),
    } as const;
    await expect(store.finish(command, operation, original, {
      outcome: 'FAILED', cost: unverifiedPayment, usage: { inputTokens: 20, outputTokens: 4 },
    })).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT' });
    await store.finish(command, operation, original, { outcome: 'UNKNOWN', cost: { basis: 'UNKNOWN' } });
    await expect(store.recordCostEvidence(command, operation, original.operationId, unverifiedPayment))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT' });
    const lateProbe = await store.claimModelReadbackProbe(command, operation, original.operationId, binding, 2);
    expect(lateProbe).toBeTypeOf('string');
    const evidence = {
      requestId: binding.identity.requestId, alias: binding.alias, protocol: binding.protocol,
      channelId: 7, quotaPoints: 91, inputTokens: 20, outputTokens: 4,
      upstreamIdState: 'observed', receiptSha256: '7'.repeat(64), actualCharge: { currency: 'USD', amountMicros: 1810 },
    } as const;
    const result = { probeId: lateProbe!, probe: { sequence: 2, phase: 'gateway_log_observed', httpStatusClass: 2 },
      observedAt: new Date(), evidence } as const;
    await store.recordModelReadbackProbe(command, operation, original.operationId, binding, result);
    await store.recordModelReadbackProbe(command, operation, original.operationId, binding, result);
    await expect(store.listPendingModelReadbacks(command)).resolves.toMatchObject([{ operationId: original.operationId, binding, evidence }]);
    await expect(store.recordModelReadbackProbe(command, operation, original.operationId, binding, {
      ...result, evidence: { ...evidence, actualCharge: { currency: 'USD', amountMicros: 1820 } },
    })).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT' });
    await expect(store.recordCostEvidence(command, operation, original.operationId, unverifiedPayment, {
      inputTokens: 21, outputTokens: 4,
    })).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT' });
    await store.recordCostEvidence(command, operation, original.operationId, unverifiedPayment);
    await store.recordCostEvidence(command, operation, original.operationId, unverifiedPayment);
    const ledger = await owner.usageLedger.findUniqueOrThrow({ where: { id: original.operationId } });
    expect(Number(ledger.costUsd)).toBe(0.00181);
    expect(Number(ledger.quantity)).toBe(24);
    expect(await owner.discoveryV3CostRevision.count({ where: { operationId: original.operationId } })).toBe(2);
    await expect(store.listPendingModelReadbacks(command)).resolves.toEqual([]);
    await owner.usageLedger.createMany({ data: [
      { workspaceId: command.workspaceId, resourceType: 'ai_tokens', quantity: 20, costUsd: 90, meta: { executionContractVersion: 3, costSource: 'token_estimate' } },
      { workspaceId: command.workspaceId, resourceType: 'provider_call', quantity: 1, costUsd: 80, meta: { executionContractVersion: 3, costSource: 'provider' } },
      { workspaceId: command.workspaceId, resourceType: 'ai_tokens', quantity: 10, costUsd: 1 },
    ] });
    const reader = createPrismaTenantDailyCostReader(app);
    expect(await reader.readDailySpendUsd(command.workspaceId, new Date(0))).toBeCloseTo(1.00181);
  }), 30_000);

  it('runs source, website, manufacturer, qualification, contacts and the original gateway receipt through native v3', () => fixture(async ({
    app, owner, command,
  }) => {
    const siteDomain = COMPANY_INPUT.domain;
    const manufacturerDomain = `v3-manufacturer-${command.workspaceId.slice(0, 8)}.example`;
    const manufacturerUrl = `https://${manufacturerDomain}/en/locations/europe/de/acme`;
    const priorCompany = await owner.canonicalCompany.create({ data: {
      workspaceId: command.workspaceId, name: COMPANY_INPUT.name, domain: siteDomain, country: 'DE',
      dedupeKey: companyIdentity(COMPANY_INPUT).dedupeKey,
    } });
    const reviewDates = { reviewedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const config = {
      schemaVersion: CONFIG.schemaVersion,
      sources: [{ ...CONFIG.sources[0]!, domain: manufacturerDomain, knownCorporateDomains: [manufacturerDomain], ...reviewDates }],
      independenceAttestations: [{ ...CONFIG.independenceAttestations[0]!, workspaceId: command.workspaceId, companyId: priorCompany.id, ...reviewDates }],
    };
    await owner.dataProvider.upsert({ where: { key: 'manufacturer_network' }, create: {
      key: 'manufacturer_network', class: 'industry_data', status: 'ENABLED', config,
    }, update: { status: 'ENABLED', config } });
    await owner.sourcePolicy.create({ data: { domain: manufacturerDomain, sourceType: 'official_website',
      reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', allowedPurpose: ['enrichment'], retentionDays: 1,
      allowedPaths: ['/en/locations/europe/de'],
    } });
    await owner.dataProvider.upsert({ where: { key: 'public_web' }, create: {
      key: 'public_web', class: 'public_intelligence', status: 'ENABLED',
    }, update: { status: 'ENABLED' } });
    await owner.dataProvider.upsert({ where: { key: 'openstreetmap' }, create: {
      key: 'openstreetmap', class: 'industry_data', status: 'ENABLED',
    }, update: { status: 'ENABLED' } });
    await owner.dataProvider.upsert({ where: { key: 'website_profile' }, create: {
      key: 'website_profile', class: 'company_registry', status: 'ENABLED',
    }, update: { status: 'ENABLED' } });
    for (const domain of ['overpass-api.de', 'www.openstreetmap.org']) {
      await owner.sourcePolicy.upsert({ where: { domain }, create: {
        domain, sourceType: 'directory', accessMode: 'api', reviewStatus: 'APPROVED',
        termsStatus: 'REVIEWED_OK', allowedPurpose: ['discovery'], retentionDays: 30,
      }, update: { reviewStatus: 'APPROVED', allowedPurpose: ['discovery'] } });
    }
    const transport = vi.fn(async (_signal: AbortSignal) => ({ places: [{
      osmId: 'node/910000123', name: COMPANY_INPUT.name, latitude: 49, longitude: 11,
      website: `https://${siteDomain}`, countryCode: 'DE', tags: { craft: 'metal_construction' },
    }] }));
    const registry = new ToolRegistry();
    registry.register({ ...osmOverpassTool, discoveryV3SingleWireTimeoutMs: 30_000, executeDiscoveryV3: async (_input, ctx) => ({
      data: await ctx.dispatchDiscoveryV3Wire!(transport), costCents: 0, provenance: {
        sourceUrl: 'https://overpass-api.de/api/interpreter', fetchedAt: '2026-11-26T12:00:00.000Z', parserVersion: 'osm/1',
      },
    }) });
    const site = vi.fn(async (url: string) => ({ url, contentHash: 'e'.repeat(24),
      text: url === manufacturerUrl ? TEXT : url.endsWith('/impressum') ? 'Acme Pumps GmbH, Amtsgericht Nürnberg HRB 12345' :
        'We are an authorized distributor and wholesale supplier of industrial motion and automation components.',
    }));
    const robots = vi.fn(async () => true);
    registry.register({ ...crawl4aiFetchTool, discoveryV3SingleWireTimeoutMs: 30_000,
      executeDiscoveryV3: async (request, context) => {
        await context.checkDiscoveryV3Robots!(request.url, async () => robots);
        return { data: await context.dispatchDiscoveryV3Wire(() => site(request.url)), costCents: 0 };
      },
    });
    const findManufacturer = vi.fn(async () => ({ results: [{ url: manufacturerUrl }] }));
    registry.register({ ...searxngSearchTool, executeDiscoveryV3: async (_input, context) => ({
      data: await context.dispatchDiscoveryV3Wire!(findManufacturer), costCents: 0,
    }) });
    const contactWire = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      const text = pathname === '/robots.txt' ? 'User-agent: *\nDisallow: /private' :
        pathname === '/' ? '<a href="/contact">Contact</a>' :
        pathname === '/contact' ? `Sales: sales@${siteDomain}\nDirect: fixture.person@${siteDomain}` : '';
      return { finalUrl: url, text, status: 200, ok: true, mediaType: 'text/plain' };
    });
    registry.register({ ...httpGetTool, executeDiscoveryV3: async ({ url }, context) => ({
      data: await context.dispatchDiscoveryV3Wire!(() => contactWire(url)), costCents: 0,
    }) });
    const artifactEndpoint = process.env.GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT;
    const realS3 = process.env.DISCOVERY_V3_TEST_ARTIFACT === '1';
    if (realS3 && (!artifactEndpoint || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(artifactEndpoint) ||
      process.env.GENERIC_OPERATION_ARTIFACT_S3_BUCKET !== 'discovery-v3-test')) {
      throw new Error('discovery v3 Artifact test requires an isolated loopback bucket');
    }
    const artifact = realS3 ? createDiscoveryV3ArtifactExecutionFromEnv(app) : new DiscoveryV3ArtifactExecution({
      withWorkspace: (id, fn, options) => app.withWorkspace(id, fn, options),
      binding: new ArtifactSubjectBindingContract(), repository: new DiscoveryV3ArtifactRepository(),
      materializers: productArtifactMaterializerRegistry(),
      storage: new S3GenericOperationArtifactStore({ bucket: BUCKET, client: new MemoryS3Client() }),
    });
    if (!artifact) throw new Error('discovery v3 Artifact fixture unavailable');
    const broker = new ToolBroker({ registry, discoveryV3ArtifactExecution: artifact, limiter: new RateLimiter(), sourcePolicyReader: async () => ({
      suspended: false, allowedPurpose: ['discovery', 'enrichment'],
    }) });
    const { gateway, fetchFixture, requests, readbacks, fitRequest } = discoveryGatewayFixture(command.workspaceId);
    const providers = new DiscoveryProviderRegistry({ prisma: app, broker, gateway });
    const executor = createNativeDiscoveryV3Executor({ prisma: app, providers, gateway, broker });
    const stats = { queriesSucceeded: 1, rawCount: 1, canonicalCount: 1, fitEvaluated: 1, websiteProfiles: 1,
      manufacturerEvidenceCount: 1, companiesWithContactDiscovery: 1, contactsFound: 2 };
    vi.stubGlobal('fetch', fetchFixture);
    vi.stubEnv('CONTACT_DISCOVERY_RUN_LAWFUL_BASIS', '{"basis":"legitimate_interest","ref":"fixture-lia"}');
    try {
      if (temporalAddress) {
        await runV3Worker(temporalAddress, command, createDiscoveryV3WorkerActivities(app, {
          execute: async (dispatch, signal, attempt) => {
            const outcome = await executor.execute(dispatch, signal, attempt);
            if (attempt === 1) throw new Error('fixture interruption after all receipts committed');
            return outcome;
          },
        }));
        expect(await owner.discoveryRun.findUniqueOrThrow({ where: { id: command.runId } })).toMatchObject({
          status: 'PARTIAL', v3WorkerAttempt: 2, stats,
        });
        const events = await owner.outboxEvent.findMany({ where: { aggregateId: command.runId, eventType: 'DiscoveryRunCompleted' } });
        expect(events).toMatchObject([{ payload: { executionContractVersion: 3, status: 'PARTIAL', cost: 0.007742 } }]);
      } else {
        const result = await executor.execute(command, new AbortController().signal, 1);
        expect(result.summary).toMatchObject(stats);
        await expect(executor.execute(command, new AbortController().signal, 1)).resolves.toEqual(result);
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    expect(transport).toHaveBeenCalledTimes(1);
    const link = await owner.discoveryV3RawLink.findFirstOrThrow({ where: { workspaceId: command.workspaceId }, include: { raw: true } });
    expect(link.raw).toMatchObject({ providerKey: 'openstreetmap', externalId: 'osm:node/910000123' });
    expect(link.rawPayloadSha256).toBe(link.raw.payloadHash);
    const company = await owner.canonicalCompany.findFirstOrThrow({ where: { workspaceId: command.workspaceId } });
    expect(company.attributes).toMatchObject({ website_profile: { trade_role: 'distributor' } });
    expect(site).toHaveBeenCalledTimes(3);
    expect(robots).toHaveBeenCalledTimes(3);
    expect(findManufacturer).toHaveBeenCalledTimes(1);
    expect(contactWire.mock.calls.filter(([url]) => url.endsWith('/robots.txt'))).toHaveLength(1);
    expect(contactWire.mock.calls.filter(([url]) => url.endsWith('/contact'))).toHaveLength(1);
    expect(fitRequest).toHaveBeenCalledWith(expect.stringContaining(SPAN));
    expect(requests.size).toBe(2);
    expect(readbacks).toEqual(new Set(requests.keys()));
    expect(await owner.discoveryV3GatewayProbe.count({ where: { workspaceId: command.workspaceId, phase: 'gateway_log_observed' } })).toBe(2);
    expect(await owner.discoveryV3Operation.count({ where: { workspaceId: command.workspaceId, method: 'robots',
      result: { path: ['schema'], equals: DISCOVERY_V3_ROBOTS_PROOF } } })).toBe(3);
    expect(await owner.canonicalContact.count({ where: { workspaceId: command.workspaceId, companyId: company.id } })).toBe(2);
    expect(await owner.discoveryV3Operation.count({ where: {
      runId: command.runId, action: 'crawl4ai.fetch', method: 'invoke', ack: { not: null },
    } })).toBe(3);
  }, [{ source_class: 'industry_data', filters: { source_hint: 'openstreetmap', country: 'DE',
    _osmTags: [{ k: 'craft', v: 'metal_construction' }], procurement_scenario: 'distribution' }, keywords: ['machine buyer'], priority: 1 }],
  Boolean(temporalAddress), { manufacturerNetworkRevision: 'manufacturer-network/v1' }), 90_000);

  it('claims one physical request across workers, recovers its verified result, and rejects changed or foreign identity', () => fixture(async ({
    app, owner, command, store,
  }) => {
    const otherWorker = new DiscoveryV3OperationStore(app);
    const claims = await Promise.all([store.claim(command, operation), otherWorker.claim(command, operation)]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(['CLAIMED', 'IN_FLIGHT']);
    const owned = claims.find((claim) => claim.status === 'CLAIMED')!;
    expect(owned).toMatchObject({ deadline: expect.any(Date) });
    const result = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' }, provider: 'model-fixture', model: 'model-v1',
    });
    const receipt = { outcome: 'SUCCEEDED', result, usage: { inputTokens: 12, outputTokens: 4 }, model: 'model-v1',
      cost: { basis: 'PROVIDER_REPORTED', amountMicros: 15_000, currency: 'USD', evidenceSha256: 'c'.repeat(64) } } as const;
    if (owned.status !== 'CLAIMED') throw new Error('test expected claim ownership');
    await store.finish(command, operation, owned, receipt);
    await otherWorker.finish(command, operation, owned, receipt);
    await expect(otherWorker.claim(command, operation)).resolves.toMatchObject({
      status: 'REPLAY', operationId: owned.operationId, result,
    });
    await expect(otherWorker.claim(command, { ...operation, requestSha256: 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_CONFLICT' });
    const replay = await otherWorker.claim(command, operation);
    expect(replay.status).toBe('REPLAY');
    if (replay.status !== 'REPLAY') throw new Error('test expected a verified replay');
    const consumer = 'f'.repeat(64);
    let writes = 0;
    await expect(store.acknowledge(command, operation, owned.operationId, '0'.repeat(64), consumer, async () => { writes++; }))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_CONFLICT' });
    await expect(store.acknowledge(command, operation, owned.operationId, replay.resultSha256!, consumer, async () => { writes++; }))
      .resolves.toBe(true);
    await expect(otherWorker.acknowledge(command, operation, owned.operationId, replay.resultSha256!, consumer, async () => { writes++; }))
      .resolves.toBe(false);
    expect(writes).toBe(1);
    await expect(app.withWorkspace(command.workspaceId, (tx) => tx.discoveryV3Operation.update({
      where: { id: owned.operationId }, data: { step: 'changed' },
    }))).rejects.toThrow('DISCOVERY_V3_OPERATION_IMMUTABLE');
    await expect(otherWorker.claim({ ...command, workspaceId: randomUUID() }, operation))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH' });
    const usage = await owner.usageLedger.findMany({ where: { workspaceId: command.workspaceId, refId: owned.operationId } });
    expect(usage).toMatchObject([{ quantity: 16, costUsd: 0.015, resourceType: 'ai_tokens',
      meta: { runId: command.runId, operationId: owned.operationId, costSource: 'provider' } }]);
    expect(await owner.aiTrace.count({ where: { workspaceId: command.workspaceId, id: owned.operationId } })).toBe(1);
    await expect(app.withWorkspace(randomUUID(), (tx) => tx.discoveryV3Operation.count({
      where: { id: owned.operationId },
    }))).resolves.toBe(0);
  }));

  it('holds an unknown dispatch without charging zero or opening another wire and books late evidence to the original operation', () => fixture(async ({
    app, owner, command, store,
  }) => {
    const claim = await store.claim(command, operation);
    if (claim.status !== 'CLAIMED') throw new Error('test expected claim ownership');
    await store.finish(command, operation, claim, { outcome: 'UNKNOWN', cost: { basis: 'UNKNOWN' } });
    await expect(store.claim(command, operation)).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(store.claim(command, { ...operation, step: 'fit/company-b' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_UNRESOLVED' });
    const before = await owner.usageLedger.findUniqueOrThrow({ where: { id: claim.operationId } });
    expect(before).toMatchObject({ costUsd: null, quantity: 0, meta: { usageKnown: false } });
    await app.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
      await finalizeDiscoveryV3(tx, run!, new Date(), 'FAILED', 'DISCOVERY_V3_OPERATION_UNRESOLVED');
    });
    const cost = { basis: 'PROVIDER_REPORTED', amountMicros: 5_000, currency: 'USD', evidenceSha256: 'c'.repeat(64) } as const;
    const tokens = { inputTokens: 7, outputTokens: 3 };
    await store.recordCostEvidence(command, operation, claim.operationId, cost, tokens);
    await store.recordCostEvidence(command, operation, claim.operationId, cost, tokens);
    expect(await owner.usageLedger.findUniqueOrThrow({ where: { id: claim.operationId } })).toMatchObject({
      createdAt: before.createdAt, quantity: 10, costUsd: 0.005,
    });
    expect(await owner.discoveryV3CostRevision.count({ where: { operationId: claim.operationId } })).toBe(2);
    const events = await owner.outboxEvent.findMany({ where: { aggregateId: command.runId, eventType: 'DiscoveryRunCompleted' } });
    expect(events).toMatchObject([{ payload: { cost: 0, costBasis: 'usage_ledger-runid/v1', status: 'FAILED' } }]);
  }));

  it('fits each wire inside the original window and checks the admitted resource before claiming', () => fixture(async ({
    command, store,
  }) => {
    await expect(store.claim(command, { ...operation, maxDurationMs: 180 * 60_000 }))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_DEADLINE' });
    await expect(store.claim({ ...command, icpId: randomUUID() }, operation))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH' });
  }));

  it('lets a higher Temporal activity attempt take over without reopening the old outbound slot', () => fixture(async ({
    app, command, store,
  }) => {
    const workflowId = formatTenantWorkflowId(command.workspaceId, 'discovery', command.runId);
    const open = await store.claim(command, operation);
    expect(open.status).toBe('CLAIMED');
    if (open.status !== 'CLAIMED') throw new Error('test expected claim ownership');
    const permissions = await Promise.allSettled([
      store.authorizeSend(command, operation, open, 1),
      store.authorizeSend(command, operation, open, 1),
    ]);
    expect(permissions.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(claimDiscoveryV3Dispatch(app, command, workflowId, true, 2)).resolves.toBe(true);
    await expect(claimDiscoveryV3Dispatch(app, command, workflowId, true, 2)).resolves.toBe(false);
    await expect(store.claim(command, { ...operation, step: 'new-work' }, 1))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH' });
    await expect(store.claim(command, operation, 2)).resolves.toMatchObject({ status: 'UNKNOWN', operationId: open.operationId });
    await expect(store.claim(command, { ...operation, step: 'new-work' }, 2))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_UNRESOLVED' });
    await expect(store.authorizeSend(command, operation, open, 1))
      .rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH' });
  }));

  it('finishes a successful v3 run and plan with the AI snapshot in a single completion event', () => fixture(async ({
    owner, app, command, store,
  }) => {
    const claim = await store.claim(command, operation);
    if (claim.status !== 'CLAIMED') throw new Error('test expected claim ownership');
    await store.finish(command, operation, claim, {
      outcome: 'SUCCEEDED', cost: { basis: 'PROVIDER_REPORTED', amountMicros: 3_000, currency: 'USD', evidenceSha256: 'f'.repeat(64) },
    });
    const finish = () => app.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
      return finalizeDiscoveryV3(tx, run!, new Date(), 'DONE', undefined, { queriesTotal: 3, queriesSucceeded: 3 });
    });
    const outcomes = await Promise.all([finish(), finish()]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await owner.discoveryQueryPlan.findUniqueOrThrow({ where: { id: command.planId } })).toMatchObject({ status: 'EXECUTED' });
    const finished = await owner.discoveryRun.findUniqueOrThrow({ where: { id: command.runId } });
    expect(finished).toMatchObject({ status: 'DONE', stats: { queriesTotal: 3, queriesSucceeded: 3 } });
    expect(finished.stats).not.toHaveProperty('failure');
    const events = await owner.outboxEvent.findMany({ where: { aggregateId: command.runId, eventType: 'DiscoveryRunCompleted' } });
    expect(events).toMatchObject([{ payload: { cost: 0.003, costBasis: 'usage_ledger-runid/v1', status: 'DONE' } }]);
  }));

  it('persists loss of the original Worker and reconciles its expired claim without dispatch', () => fixture(async ({
    command, owner, store,
  }) => {
    const abandoned = { ...operation, maxDurationMs: 1 };
    const claim = await store.claim(command, abandoned);
    expect(claim.status).toBe('CLAIMED');
    const other = await store.claim(command, abandoned);
    expect(other).toMatchObject({ status: 'UNKNOWN', operationId: claim.operationId });
    expect(await owner.discoveryV3Operation.findUniqueOrThrow({ where: { id: claim.operationId } })).toMatchObject({ status: 'UNKNOWN' });
    await store.recordCostEvidence(command, abandoned, claim.operationId, {
      basis: 'PROVIDER_REPORTED', amountMicros: 2_000, currency: 'USD', evidenceSha256: '9'.repeat(64),
    });
    expect(await owner.usageLedger.findUniqueOrThrow({ where: { id: claim.operationId } })).toMatchObject({
      costUsd: 0.002,
    });
    const correction = { basis: 'PROVIDER_REPORTED', amountMicros: 3_000, currency: 'USD', evidenceSha256: '8'.repeat(64) } as const;
    await store.recordCostEvidence(command, abandoned, claim.operationId, correction, { inputTokens: 5 }, '9'.repeat(64));
    await expect(store.recordCostEvidence(command, abandoned, claim.operationId, {
      basis: 'PROVIDER_REPORTED', amountMicros: 2_000, currency: 'USD', evidenceSha256: '9'.repeat(64),
    })).resolves.toBeUndefined();
    if (claim.status !== 'CLAIMED') throw new Error('test expected claim ownership');
    const result = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' }, provider: 'model-fixture', model: 'model-v1',
    });
    await expect(store.finish(command, abandoned, { ...claim, proof: randomUUID() }, {
      outcome: 'SUCCEEDED', result, cost: { basis: 'UNKNOWN' },
    })).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH' });
    await store.finish(command, abandoned, claim, {
      outcome: 'SUCCEEDED', result, cost: { basis: 'UNKNOWN' }, usage: { inputTokens: 11, outputTokens: 3 },
    });
    expect(await store.claim(command, abandoned)).toMatchObject({ status: 'REPLAY', result });
    expect(await owner.usageLedger.findUniqueOrThrow({ where: { id: claim.operationId } })).toMatchObject({ costUsd: 0.003, quantity: 8 });
  }));

  it.each(['enforce', 'bypass'] as const)('runs and replays the real Gateway without the old ledger in %s mode', (mode) => fixture(async ({
    command, owner, store,
  }) => {
    const generateStructured = vi.fn().mockResolvedValue({
      data: { code: 'CPV-123' }, provider: 'fixture-model', model: 'fixture',
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.000032 },
    });
    const gateway = new RouterModelGateway({ route: () => [{ id: 'fixture-model', generateStructured }] } as unknown as ModelRouter);
    gateway.legacyBudgetMode = mode;
    const input = {
      task: 'taxonomy.normalize', model: 'fixture', prompt: 'classify fixture', maxTokens: 64,
      schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
    };
    const ctx = { workspaceId: command.workspaceId, runId: command.runId, durableResultSchema: 'taxonomy-code/v1' as const };
    const run = (step: string) => withDiscoveryV3OperationScope({
      command, step, store, signal: new AbortController().signal,
    }, () => gateway.generateStructured(input, ctx));
    await expect(run('taxonomy/cpv')).resolves.toMatchObject({ data: { code: 'CPV-123' } });
    await expect(run('taxonomy/cpv')).resolves.toMatchObject({ data: { code: 'CPV-123' } });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    generateStructured.mockRejectedValueOnce(new ProviderOutputError('FIXTURE_INVALID', {
      inputTokens: 15, outputTokens: 8, costUsd: 0.000057,
    }));
    await expect(run('taxonomy/invalid')).rejects.toMatchObject({ name: 'ProviderOutputError' });
    const costs = await owner.usageLedger.findMany({
      where: { workspaceId: command.workspaceId, resourceType: 'ai_tokens' }, orderBy: { createdAt: 'asc' },
    });
    expect(costs).toMatchObject([
      { costUsd: 0.000032, quantity: 12, meta: { outcome: 'SUCCEEDED', costSource: 'provider' } },
      { costUsd: 0.000057, quantity: 23, meta: { outcome: 'FAILED', costSource: 'provider' } },
    ]);
  }));

  it('binds a real model adapter 429 response to one transport attempt without an implicit resend', () => fixture(async ({
    command, owner, store,
  }) => {
    const provider = new OpenAICompatibleProvider({
      id: 'native-model-fixture', baseUrl: 'https://model-gateway.example/v1', apiKey: 'fixture-key', model: 'fixture',
    });
    const gateway = new RouterModelGateway({ route: () => [provider] } as unknown as ModelRouter);
    const fetchFixture = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'fixture', choices: [{ message: { content: '{"code":"CPV-123"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })));
    vi.stubGlobal('fetch', fetchFixture);
    try {
      await expect(withDiscoveryV3OperationScope({
        command, store, step: 'taxonomy/429', signal: new AbortController().signal,
      }, () => gateway.generateStructured({
        task: 'taxonomy.normalize', prompt: 'Fixture', model: 'fixture', maxTokens: 64,
        schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      }, { workspaceId: command.workspaceId, runId: command.runId, durableResultSchema: 'taxonomy-code/v1' })))
        .rejects.toMatchObject({ status: 429 });
      expect(fetchFixture).toHaveBeenCalledTimes(1);
      expect(await owner.discoveryV3Operation.count({ where: { runId: command.runId } })).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  }));

  it('retains the amount of a rejected model projection and does not quote or regenerate the same output', () => fixture(async ({
    command, owner, store,
  }) => {
    const generateStructured = vi.fn().mockResolvedValue({
      data: { unsupported: true }, provider: 'fixture-model', model: 'fixture',
      usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.000058 },
    });
    const gateway = new RouterModelGateway({ route: () => [{ id: 'fixture-model', generateStructured }] } as unknown as ModelRouter);
    const run = () => withDiscoveryV3OperationScope({
      command, store, step: 'taxonomy/invalid-projection', signal: new AbortController().signal,
    }, () => gateway.generateStructured({
      task: 'taxonomy.normalize', prompt: 'Fixture', model: 'fixture', maxTokens: 64,
      schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }, { workspaceId: command.workspaceId, runId: command.runId, durableResultSchema: 'taxonomy-code/v1' }));
    await expect(run()).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_INVALID' });
    await expect(run()).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_UNRESOLVED' });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(await owner.usageLedger.findMany({ where: { workspaceId: command.workspaceId, resourceType: 'ai_tokens' } }))
      .toMatchObject([{ quantity: 5, costUsd: 0.000058, meta: { outcome: 'FAILED', costSource: 'provider' } }]);
  }));

  it('counts one paid search wire in the ToolBroker and replays an ACK without a new provider charge', () => fixture(async ({
    command, owner, store,
  }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      organic: [{ link: 'https://example.test/company', title: 'Synthetic company' }],
    })));
    const registry = new ToolRegistry();
    registry.register(createSerperSearchTool({
      resolveApiKey: () => 'fixture-key',
      serperSearch: (input, deps) => serperSearch(input, { ...deps, fetchImpl }),
    }));
    const broker = new ToolBroker({ registry, limiter: new RateLimiter(), legacyBudgetMode: 'enforce' });
    const run = (step: string) => withDiscoveryV3OperationScope({
      command, step, store, signal: new AbortController().signal,
    }, () => broker.invoke('serper.search', { query: 'synthetic query' }, {
      workspaceId: command.workspaceId, runId: command.runId, purpose: 'discovery',
    }));
    await expect(run('query/0')).resolves.toMatchObject({ data: { results: [{ url: 'https://example.test/company' }] } });
    await expect(run('query/0')).resolves.toMatchObject({ data: { results: [{ url: 'https://example.test/company' }] }, costCents: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await owner.usageLedger.findMany({ where: { workspaceId: command.workspaceId, resourceType: 'provider_call' } }))
      .toMatchObject([{ quantity: 1, costUsd: 0.01, meta: { costSource: 'tariff_estimate' } }]);
    fetchImpl.mockRejectedValueOnce(new DOMException('test timeout', 'TimeoutError'));
    await expect(run('query/1')).rejects.toThrow();
    await expect(run('query/2')).rejects.toMatchObject({ code: 'DISCOVERY_V3_OPERATION_UNRESOLVED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }));

  it('denies a native source whose approval changes while waiting for the ToolBroker limiter', () => fixture(async ({
    command, store,
  }) => {
    const registry = new ToolRegistry();
    registry.register(wikidataTool);
    let suspended = false;
    const broker = new ToolBroker({
      registry,
      limiter: { configure: () => {}, acquire: async () => {
        suspended = true;
        return () => {};
      }, respectDomainDelay: async () => {} },
      sourcePolicyReader: async () => ({ suspended, allowedPurpose: ['discovery'] }),
    });
    const fetchFixture = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: { bindings: [] } })));
    vi.stubGlobal('fetch', fetchFixture);
    try {
      await expect(withDiscoveryV3OperationScope({
        command, step: 'query/wikidata', store, signal: new AbortController().signal,
      }, () => broker.invoke('wikidata.sparql', { phase: 'exact', industryQids: ['Q192127'] }, {
        workspaceId: command.workspaceId, runId: command.runId, purpose: 'discovery',
      }))).rejects.toMatchObject({ name: 'ToolPolicyDenied' });
      expect(fetchFixture).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }));

  it('runs a frozen Wikidata query through the native executor, replays both wires, and links the original Raw and canonical evidence', () => fixture(async ({
    command, owner, app,
  }) => {
    await owner.discoveryQueryPlan.update({ where: { id: command.planId }, data: { queries: [], version: { increment: 1 } } });
    await owner.dataProvider.upsert({
      where: { key: 'wikidata' }, create: { key: 'wikidata', class: 'company_registry', status: 'ENABLED' },
      update: { status: 'ENABLED' },
    });
    for (const domain of ['query.wikidata.org', 'www.wikidata.org', 'wikidata.org']) {
      await owner.sourcePolicy.upsert({ where: { domain }, create: {
        domain, sourceType: 'gov_registry', accessMode: 'api', allowedPurpose: ['discovery'], reviewStatus: 'APPROVED',
        termsStatus: 'REVIEWED_OK', retentionDays: 365,
      }, update: { reviewStatus: 'APPROVED', allowedPurpose: ['discovery'] } });
    }
    const fetchFixture = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { bindings: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { bindings: [{
        company: { type: 'uri', value: 'http://www.wikidata.org/entity/Q910000123' },
        companyLabel: { type: 'literal', value: 'Synthetic machine buyer' },
        website: { type: 'uri', value: 'https://synthetic-v3-buyer.example' },
        countryCode: { type: 'literal', value: 'DE' },
      }] } })));
    const registry = new ToolRegistry();
    registry.register(wikidataTool);
    const broker = new ToolBroker({
      registry, limiter: new RateLimiter(), legacyBudgetMode: 'enforce',
      sourcePolicyReader: async (domain) => {
        const policy = await owner.sourcePolicy.findUnique({ where: { domain } });
        return policy ? { suspended: policy.reviewStatus === 'SUSPENDED', allowedPurpose: ['discovery'] } : null;
      },
    });
    const providers = new DiscoveryProviderRegistry({ prisma: app, broker });
    const model = vi.fn().mockImplementation(async (request) => ({
      data: {
        verdict: 'weak', material_gate: 'unclear', role_gate: 'unclear', process_gate: 'unclear',
        business_model_gate: 'unclear', reasons: ['Registry evidence alone does not confirm the buyer role.'],
      },
      provider: 'fixture-model', model: request.model,
      usage: { inputTokens: 500, outputTokens: 15, costUsd: 0.000711 },
    }));
    const gateway = new RouterModelGateway({ route: () => [{ id: 'fixture-model', generateStructured: model }] } as unknown as ModelRouter);
    const executor = createNativeDiscoveryV3Executor({ prisma: app, providers, gateway });
    vi.stubGlobal('fetch', fetchFixture);
    try {
      if (temporalAddress) {
        await runV3Worker(temporalAddress, command, createDiscoveryV3WorkerActivities(app, {
          execute: async (dispatch, signal, attempt) => {
            const outcome = await executor.execute(dispatch, signal, attempt);
            if (attempt === 1) throw new Error('fixture process interruption before completing activity');
            return outcome;
          },
        }));
        expect(await owner.discoveryRun.findUniqueOrThrow({ where: { id: command.runId } })).toMatchObject({
          status: 'PARTIAL', v3WorkerAttempt: 2, stats: { queriesSucceeded: 1, rawCount: 1, canonicalCount: 1, fitEvaluated: 1 },
        });
        expect(await owner.outboxEvent.findMany({ where: { aggregateId: command.runId, eventType: 'DiscoveryRunCompleted' } }))
          .toMatchObject([{ payload: { executionContractVersion: 3, status: 'PARTIAL', cost: 0.000711 } }]);
      } else {
        const completed = await executor.execute(command, new AbortController().signal, 1);
        expect(completed).toMatchObject({ status: 'PARTIAL', summary: { queriesSucceeded: 1, rawCount: 1, canonicalCount: 1, fitEvaluated: 1 } });
        await expect(executor.execute(command, new AbortController().signal, 1)).resolves.toEqual(completed);
      }
      expect(fetchFixture).toHaveBeenCalledTimes(2);
      expect(fetchFixture.mock.calls.every((call) => call[1]?.redirect === 'error' && call[1]?.signal)).toBe(true);
      const links = await owner.discoveryV3RawLink.findMany({
        where: { workspaceId: command.workspaceId },
        include: { operation: true, raw: true },
      });
      expect(links).toMatchObject([{ queryOrdinal: 0, operation: { status: 'SUCCEEDED' },
        raw: { ingestStatus: 'ACCEPTED', providerKey: 'wikidata', externalId: 'wikidata:Q910000123' } }]);
      expect(links[0].rawPayloadSha256).toBe(links[0].raw.payloadHash);
      const emptyWire = await owner.discoveryV3Operation.findFirstOrThrow({ where: {
        workspaceId: command.workspaceId, runId: command.runId, provider: 'wikidata.sparql',
        id: { not: links[0].operationId },
      } });
      await expect(app.withWorkspace(command.workspaceId, (tx) => tx.discoveryV3RawLink.create({ data: {
        workspaceId: command.workspaceId, operationId: emptyWire.id, rawRecordId: links[0].rawRecordId,
        queryOrdinal: 0, recordIndex: 0, rawPayloadSha256: links[0].rawPayloadSha256,
      } }))).rejects.toThrow('DISCOVERY_V3_RAW_LINK_MISMATCH');
      const identity = await owner.identityLink.findFirstOrThrow({ where: { rawRecordId: links[0].rawRecordId } });
      expect(await owner.fieldEvidence.count({ where: { rawRecordId: links[0].rawRecordId, entityId: identity.canonicalId } })).toBeGreaterThan(0);
      expect(await owner.lead.count({ where: { workspaceId: command.workspaceId, icpId: command.icpId, canonicalCompanyId: identity.canonicalId } })).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);
      expect(await owner.usageLedger.findMany({ where: { workspaceId: command.workspaceId, resourceType: 'ai_tokens' } }))
        .toMatchObject([{ quantity: 515, costUsd: 0.000711, meta: { costSource: 'provider', runId: command.runId } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, [{
    source_class: 'company_registry', filters: { source_hint: 'wikidata', _industryQids: ['Q192127'], _countryQid: 'Q183' },
    keywords: ['machine buyer'], priority: 1,
  }], Boolean(temporalAddress)), 90_000);
});
