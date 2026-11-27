import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactSubjectBindingContract } from '../durable-results/artifact/artifact-subject-binding.contract';
import { DiscoveryV3ArtifactExecution } from '../durable-results/artifact/discovery-v3-artifact.execution';
import { DiscoveryV3ArtifactRepository } from '../durable-results/artifact/discovery-v3-artifact.repository';
import { productArtifactMaterializerRegistry } from '../durable-results/artifact/generic-operation-artifact.runtime';
import { S3GenericOperationArtifactStore } from '../durable-results/artifact/generic-operation-artifact.store';
import { BUCKET, MemoryS3Client } from '../durable-results/artifact/generic-operation-artifact.store.spec-helper';
import { PrismaService } from '../prisma/prisma.service';
import { parseDiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { claimDiscoveryV3Dispatch } from '../temporal/discovery-v3.worker-activities';
import { formatTenantWorkflowId } from '../temporal/tenant-workflow-id';
import { crawl4aiFetchTool, searxngSearchTool } from '../tools/builtin-tools';
import { RateLimiter } from '../tools/rate-limiter';
import { ToolBroker } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import { admitDiscoveryV3 } from './discovery-v3-admission';
import { DiscoveryV3OperationStore } from './discovery-v3-operations';
import { CONFIG, COMPANY_INPUT, SPAN, TEXT } from './manufacturer-network.test-fixture';
import { createDiscoveryV3ManufacturerEvidence } from './manufacturer-network-v3';

const ownerUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const appUrl = process.env.APP_DATABASE_URL;
for (const uri of ownerUrl && appUrl ? [ownerUrl, appUrl] : []) {
  const url = new URL(uri);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.pathname !== '/global_test' || url.port === '15433') {
    throw new Error('MANUFACTURER_V3_DISPOSABLE_DATABASE_REQUIRED');
  }
}

async function fixture(matches: boolean) {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const prisma = new PrismaService();
  const provider = await owner.dataProvider.findUnique({ where: { key: 'manufacturer_network' } });
  const workspaceId = randomUUID();
  const domain = `manufacturer-${randomUUID().slice(0, 8)}.example`;
  const sourceUrl = `https://${domain}/en/locations/europe/de/acme`;
  try {
    await owner.workspace.create({ data: { id: workspaceId, name: 'Manufacturer v3 fixture' } });
    const company = await owner.canonicalCompany.create({ data: {
      workspaceId, name: COMPANY_INPUT.name, domain: COMPANY_INPUT.domain, country: 'DE', dedupeKey: `domain:${COMPANY_INPUT.domain}`,
    } });
    const seller = await owner.companyProfile.create({ data: { workspaceId, name: 'Fixture seller' } });
    const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: seller.id, name: 'Fixture ICP' } });
    const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, status: 'READY', queries: [{
      source_class: 'public_intelligence', keywords: ['fixture distributor'], priority: 1, filters: { procurement_scenario: 'distribution' },
    }] } });
    const config = {
      schemaVersion: CONFIG.schemaVersion,
      sources: [{ ...CONFIG.sources[0]!, domain, knownCorporateDomains: [domain],
        reviewedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
      independenceAttestations: [{ ...CONFIG.independenceAttestations[0]!, workspaceId, companyId: company.id,
        reviewedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
    };
    await owner.dataProvider.upsert({ where: { key: 'manufacturer_network' },
      create: { key: 'manufacturer_network', class: 'industry_data', status: 'ENABLED', config }, update: { status: 'ENABLED', config } });
    const policy = await owner.sourcePolicy.create({ data: { domain, sourceType: 'official_website', reviewStatus: 'APPROVED',
      termsStatus: 'REVIEWED_OK', allowedPurpose: ['enrichment'], allowedPaths: ['/en/locations/europe/de'], retentionDays: 1 } });
    const { runId } = await admitDiscoveryV3(prisma, { workspaceId, userId: randomUUID(), roles: ['saas-admin'] },
      plan.id, { manufacturerNetworkRevision: 'manufacturer-network/v1' },
      { taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true } });
    const event = await owner.outboxEvent.findFirstOrThrow({ where: { workspaceId, aggregateId: runId, eventType: 'DiscoveryRunRequested' } });
    const command = parseDiscoveryV3Dispatch(event.payload);
    const workflowId = formatTenantWorkflowId(workspaceId, 'discovery', runId);
    await expect(claimDiscoveryV3Dispatch(prisma, command, workflowId, true)).resolves.toBe(true);

    const search = vi.fn(async () => ({ results: matches ? [{ url: sourceUrl }] : [{ url: `https://${domain}/directory` }] }));
    const fetch = vi.fn(async (url: string) => ({ url, text: TEXT, contentHash: createHash('sha256').update(TEXT).digest('hex').slice(0, 24) }));
    const registry = new ToolRegistry();
    registry.register({ ...searxngSearchTool,
      execute: async () => { throw new Error('legacy search must not run'); },
      executeDiscoveryV3: async (_request, ctx) => ({ data: await ctx.dispatchDiscoveryV3Wire(search), costCents: 0 }) });
    registry.register({ ...crawl4aiFetchTool,
      execute: async () => { throw new Error('legacy crawl must not run'); },
      executeDiscoveryV3: async (request, ctx) => {
        if (!await ctx.checkDiscoveryV3Robots!(request.url, async () => async () => true)) {
          throw new Error('fixture robots denial');
        }
        return { data: await ctx.dispatchDiscoveryV3Wire(() => fetch(request.url)), costCents: 0 };
      } });
    const artifacts = new DiscoveryV3ArtifactExecution({
      withWorkspace: (id, invoke, options) => prisma.withWorkspace(id, invoke, options),
      binding: new ArtifactSubjectBindingContract(), repository: new DiscoveryV3ArtifactRepository(),
      materializers: productArtifactMaterializerRegistry(),
      storage: new S3GenericOperationArtifactStore({ bucket: BUCKET, client: new MemoryS3Client() }),
    });
    const broker = new ToolBroker({ registry, discoveryV3ArtifactExecution: artifacts, limiter: new RateLimiter(),
      sourcePolicyReader: async (host) => {
        const current = await owner.sourcePolicy.findUnique({ where: { domain: host } });
        return current ? { suspended: current.reviewStatus === 'SUSPENDED', allowedPurpose: ['enrichment'] } : null;
      },
    });
    const run = createDiscoveryV3ManufacturerEvidence({ prisma, broker, operationStore: new DiscoveryV3OperationStore(prisma) });
    const resolve = (attempt: number) => run(command, company.id, new AbortController().signal, attempt);
    const evidence = await resolve(1);
    const allOperations = await owner.discoveryV3Operation.findMany({ where: { workspaceId, runId }, orderBy: { step: 'asc' } });
    const operations = allOperations.filter((row) => row.method === 'invoke');
    expect(allOperations.filter((row) => row.method === 'robots')).toMatchObject(matches ? [{ status: 'SUCCEEDED', ack: null }] : []);
    expect(operations.map((op) => op.action)).toEqual(matches ? ['searxng.search', 'crawl4ai.fetch'] : ['searxng.search']);
    expect(operations.every((op) => op.status === 'SUCCEEDED' && op.ack === operations[0]!.ack && op.ack !== null)).toBe(true);
    const proofs = await owner.discoveryV3ManufacturerEvidence.findMany({ where: { workspaceId, runId } });
    if (matches) {
      expect(evidence).toMatchObject({ sourceUrl, spans: [SPAN], companyId: company.id, workspaceId });
      expect(proofs).toMatchObject([{ evidence, lookupOperationId: operations[0]!.id, lookupResultSha256: operations[0]!.resultSha256,
        fetchOperationId: operations[1]!.id, fetchResultSha256: operations[1]!.resultSha256, consumerSha256: operations[0]!.ack }]);
      expect(await owner.fieldEvidence.count({ where: { workspaceId, entityId: company.id, field: 'manufacturer_network.evidence' } })).toBe(0);
      await expect(prisma.withWorkspace(workspaceId, (tx) => tx.$queryRaw`
        SELECT evidence FROM public.discovery_v3_manufacturer_evidence WHERE workspace_id=${workspaceId}::uuid
      `)).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
      await expect(prisma.withWorkspace(randomUUID(), (tx) => tx.$queryRaw`
        SELECT evidence FROM public.read_discovery_v3_manufacturer_evidence_v1(
          ${workspaceId}::uuid, ${company.id}::uuid, ${runId}::uuid, ${command.requestSha256}::text)
      `)).resolves.toEqual([]);
    } else {
      expect(evidence).toBeUndefined();
      expect(proofs).toEqual([]);
    }
    await expect(claimDiscoveryV3Dispatch(prisma, command, workflowId, true, 2)).resolves.toBe(true);
    await expect(resolve(2)).resolves.toEqual(evidence);
    await owner.sourcePolicy.update({ where: { id: policy.id }, data: { reviewStatus: 'SUSPENDED' } });
    await expect(resolve(2)).resolves.toBeUndefined();
    if (matches) {
      await owner.sourcePolicy.update({ where: { id: policy.id }, data: { reviewStatus: 'APPROVED' } });
      await expect(resolve(2)).resolves.toEqual(evidence);
      await owner.genericOperationArtifactSubjectTombstone.create({ data: { workspaceId, subjectType: 'company', subjectId: company.id } });
      await expect(resolve(2)).resolves.toBeUndefined();
    }
    expect(search).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(matches ? 1 : 0);
  } finally {
    if (provider) await owner.dataProvider.update({ where: { key: 'manufacturer_network' }, data: {
      status: provider.status, config: provider.config === null ? Prisma.DbNull : provider.config,
    } });
    await Promise.all([owner.$disconnect(), prisma.$disconnect()]);
  }
}

describe.runIf(Boolean(ownerUrl && appUrl))('manufacturer v3 native proof with isolated PostgreSQL', () => {
  it('acknowledges the exact search and artifact, replays the proof, and honors later source suspension', () => fixture(true), 30_000);
  it('acknowledges a lookup miss once without fetching or inventing proof', () => fixture(false), 30_000);
});
