import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { isEncryptedPii } from '../compliance/pii-crypto';
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
import { RateLimiter } from '../tools/rate-limiter';
import { ToolBroker } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import type { HttpGetInput, HttpGetOutput } from '../tools/source-tools';
import type { Tool } from '../tools/tool-contract';
import { admitDiscoveryV3 } from './discovery-v3-admission';
import { createDiscoveryV3ContactDiscovery } from './discovery-v3-contact';
import { DiscoveryV3OperationStore } from './discovery-v3-operations';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const appUrl = process.env.APP_DATABASE_URL;
const domain = 'contact-proof.example.invalid';

describe.skipIf(!adminUrl || !appUrl)('Discovery v3 public-web contact collection', () => {
  it.each(['allow', 'deny'] as const)('checks the site rules before persisting protected points from verified artifacts (%s)', async (robots) => {
    for (const url of [adminUrl!, appUrl!]) {
      const parsed = new URL(url);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
        throw new Error('discovery v3 contact test requires an isolated loopback test database');
      }
    }
    const owner = new PrismaClient({ datasourceUrl: adminUrl });
    const app = new PrismaService();
    const workspaceId = randomUUID();
    const wires: string[] = [];
    let routeEnabled = true;
    const registry = new ToolRegistry();
    const tool: Tool<HttpGetInput, HttpGetOutput> = {
      id: 'http.get', version: '1.0.0', category: 'fetch',
      cost: { unit: 'request', estimatedCents: 0, external: false },
      rateLimit: { concurrency: 1, rps: 20 },
      capabilities: { produces: ['contact'], accepts: ['domain'] },
      compliance: {
        personalData: true, allowedPurpose: ['discovery', 'enrichment'], sourcePolicy: 'advisory',
        respectsRobots: true, reversible: true, authRequired: false, risk: 'low',
      },
      durableResultStrategy: {
        kind: 'artifact_reference', schema: 'http-get/v1', maxBytes: 3_000_000,
        mediaTypes: ['text/plain'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
      },
      idempotencyKey: ({ url }) => url,
      healthCheck: async () => ({ healthy: true }),
      execute: async () => { throw new Error('legacy execution was attempted'); },
      discoveryV3ChargeFree: true,
      discoveryV3SingleWireTimeoutMs: 5_000,
      executeDiscoveryV3: ({ url }, context) => context.dispatchDiscoveryV3Wire(async () => {
        wires.push(url);
        const pathname = new URL(url).pathname;
        const text = pathname === '/robots.txt' ?
          (robots === 'deny' ? 'User-agent: GlobalBot\nDisallow: /' : 'User-agent: *\nDisallow: /private') :
          pathname === '/' ? '<a href="/contact">Contact</a><a href="/private/impressum">Private notice</a>' :
          pathname === '/contact' ? [
            `Sales: sales@${domain}`,
            `Direct: alex.fixture@${domain}`,
            `Suppressed: dana.fixture@${domain}`,
          ].join('\n') : '';
        return { data: { finalUrl: url, text, status: 200, ok: true, mediaType: 'text/plain' }, costCents: 0 };
      }),
    };
    registry.register(tool as Tool);
    const operationStore = new DiscoveryV3OperationStore(app);
    const broker = new ToolBroker({
      registry, limiter: new RateLimiter(), legacyBudgetMode: 'enforce',
      discoveryV3ArtifactExecution: new DiscoveryV3ArtifactExecution({
        withWorkspace: (id, fn, options) => app.withWorkspace(id, fn, options),
        binding: new ArtifactSubjectBindingContract(),
        repository: new DiscoveryV3ArtifactRepository(),
        storage: new S3GenericOperationArtifactStore({ bucket: BUCKET, client: new MemoryS3Client() }),
        materializers: productArtifactMaterializerRegistry(),
      }),
    });
    const discover = createDiscoveryV3ContactDiscovery({
      prisma: app, operationStore, broker,
      providers: {
        routeContactDiscovery: async () => routeEnabled ? [{
          key: 'public_web',
          discoverContacts: async () => { throw new Error('legacy renderer path was attempted'); },
        }] : [],
      },
    });
    try {
      await owner.workspace.create({ data: { id: workspaceId, name: 'Contact proof fixture' } });
      const seller = await owner.companyProfile.create({ data: { workspaceId, name: 'Seller fixture' } });
      const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: seller.id, name: 'ICP fixture' } });
      const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, queries: [], status: 'READY' } });
      const run = await admitDiscoveryV3(app, { workspaceId, userId: randomUUID(), roles: ['saas-admin'] }, plan.id, {}, {
        taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true },
      });
      const event = await owner.outboxEvent.findFirstOrThrow({
        where: { workspaceId, aggregateId: run.runId, eventType: 'DiscoveryRunRequested' },
      });
      const command = parseDiscoveryV3Dispatch(event.payload);
      expect(await claimDiscoveryV3Dispatch(app, command, formatTenantWorkflowId(workspaceId, 'discovery', run.runId), true)).toBe(true);
      const company = await owner.canonicalCompany.create({
        data: { workspaceId, name: 'Contact target fixture', domain, country: 'US', dedupeKey: domain },
      });
      const job = await owner.discoveryCompanyJob.create({
        data: { workspaceId, runId: run.runId, canonicalCompanyId: company.id, stage: 'done', verdictDeep: 'weak' },
      });
      const runContactStage = () => discover(command, company.id, new AbortController().signal, 1);

      vi.stubEnv('CONTACT_DISCOVERY_RUN_LAWFUL_BASIS', '{"basis":"legitimate_interest","ref":"fixture-lia"}');
      await expect(runContactStage()).resolves.toEqual({ status: 'SKIPPED', contactsFound: 0 });
      await owner.discoveryCompanyJob.update({ where: { id: job.id }, data: { verdictDeep: 'match' } });
      vi.stubEnv('CONTACT_DISCOVERY_RUN_LAWFUL_BASIS', 'invalid');
      await expect(runContactStage()).resolves.toEqual({ status: 'PENDING', contactsFound: 0 });
      expect(wires).toEqual([]);

      vi.stubEnv('CONTACT_DISCOVERY_RUN_LAWFUL_BASIS', '{"basis":"legitimate_interest","ref":"fixture-lia"}');
      if (robots === 'deny') {
        await expect(runContactStage()).resolves.toEqual({ status: 'PENDING', contactsFound: 0 });
        await expect(runContactStage()).resolves.toEqual({ status: 'PENDING', contactsFound: 0 });
        expect(wires).toEqual([`https://${domain}/robots.txt`]);
        expect(await owner.canonicalContact.count({ where: { workspaceId, companyId: company.id } })).toBe(0);
        return;
      }
      await owner.suppressionRecord.create({
        data: { workspaceId, type: 'email', value: `dana.fixture@${domain}`, reason: 'fixture' },
      });
      const acknowledge = operationStore.acknowledgeBatch.bind(operationStore);
      vi.spyOn(operationStore, 'acknowledgeBatch').mockImplementationOnce(async (...args) => {
        routeEnabled = false;
        try {
          return await acknowledge(...args);
        } finally {
          routeEnabled = true;
        }
      });
      await expect(runContactStage()).resolves.toEqual({ status: 'PENDING', contactsFound: 0 });
      expect(wires[0]).toBe(`https://${domain}/robots.txt`);
      expect(wires).toContain(`https://${domain}/contact`);
      expect(wires).not.toContain(`https://${domain}/private/impressum`);
      expect(await owner.canonicalContact.count({ where: { workspaceId, companyId: company.id } })).toBe(0);
      expect(await owner.discoveryV3Operation.count({ where: { workspaceId, runId: run.runId, ack: { not: null } } })).toBe(0);
      const initialWires = wires.length;
      await expect(runContactStage()).resolves.toEqual({ status: 'DONE', contactsFound: 2 });
      await expect(runContactStage()).resolves.toEqual({ status: 'DONE', contactsFound: 2 });
      expect(wires).toHaveLength(initialWires);

      const operations = await owner.discoveryV3Operation.findMany({ where: { workspaceId, runId: run.runId } });
      expect(operations).toHaveLength(initialWires);
      expect(operations.every((operation) => operation.ack !== null && operation.status === 'SUCCEEDED')).toBe(true);
      expect(JSON.stringify(operations.map(({ result }) => result))).not.toMatch(/sales@|alex\.fixture|dana\.fixture/);
      const contacts = await owner.canonicalContact.findMany({ where: { workspaceId, companyId: company.id }, include: { contactPoints: true } });
      expect(contacts).toHaveLength(2);
      expect(contacts.every((contact) => isEncryptedPii(contact.fullName) &&
        contact.contactPoints.length === 1 && isEncryptedPii(contact.contactPoints[0]!.value))).toBe(true);
      expect(await owner.companyContactChannel.findMany({ where: { workspaceId, companyId: company.id, channel: 'email' } }))
        .toMatchObject([{ value: `sales@${domain}`, sourceType: 'contact_page', emailType: 'generic_sales' }]);
      expect(await owner.personalDataAccessAudit.findMany({ where: { workspaceId, correlationId: run.runId } }))
        .toMatchObject([{ lawfulBasisRef: 'fixture-lia', subjectCount: 2, purpose: 'contact_discovery' }]);
      expect(await owner.discoveryCompanyJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        streamingL2ContactsCreated: 2, contactEnrichmentStatus: null,
      });
    } finally {
      vi.unstubAllEnvs();
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  }, 25_000);
});
