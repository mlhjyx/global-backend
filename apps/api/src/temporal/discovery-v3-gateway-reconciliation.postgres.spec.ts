import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { admitDiscoveryV3 } from '../discovery/discovery-v3-admission';
import { DiscoveryV3OperationStore, type DiscoveryV3OperationInput } from '../discovery/discovery-v3-operations';
import { discoveryV3WatchdogReason, finalizeDiscoveryV3 } from '../discovery/discovery-v3-terminal';
import { prepareDiscoveryV3GatewayWire, type DiscoveryV3GatewayReadbackRuntime } from '../model-gateway/discovery-v3-gateway-readback';
import { SettlementDerivationKeyring } from '../model-gateway/settlement-wire-identity';
import { NEW_API_REQUEST_BOUND_RESOLVER_ID, type NewApiRequestBoundSettlementResolverPort } from '../model-gateway/settlement-readback-contract';
import { PrismaService } from '../prisma/prisma.service';
import { parseDiscoveryV3Dispatch, type DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { createDiscoveryV3GatewayTerminalSweep } from './discovery-v3-gateway-reconciliation';
import { claimDiscoveryV3Dispatch } from './discovery-v3.worker-activities';
import { formatTenantWorkflowId } from './tenant-workflow-id';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const appUrl = process.env.APP_DATABASE_URL;
for (const uri of adminUrl && appUrl ? [adminUrl, appUrl] : []) {
  const url = new URL(uri);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.pathname !== '/global_test' || url.port === '15433') {
    throw new Error('DISCOVERY_V3_GATEWAY_SWEEP_DISPOSABLE_DATABASE_REQUIRED');
  }
}

describe.runIf(Boolean(adminUrl && appUrl))('discovery gateway terminal reconciliation on isolated PostgreSQL', () => {
  it('rotates pending rows after a watchdog termination and books one late observed charge', async () => {
    const owner = new PrismaClient({ datasourceUrl: adminUrl });
    const app = new PrismaService();
    try {
      const workspaceId = randomUUID();
      await owner.workspace.create({ data: { id: workspaceId, name: 'Gateway sweep fixture' } });
      const seller = await owner.companyProfile.create({ data: { workspaceId, name: 'Fixture seller' } });
      const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: seller.id, name: 'Fixture ICP' } });
      const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, status: 'READY', queries: [] } });
      const { runId } = await admitDiscoveryV3(app, { workspaceId, userId: randomUUID(), roles: ['saas-admin'] }, plan.id, {}, {
        taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true },
      });
      const event = await owner.outboxEvent.findFirstOrThrow({ where: { workspaceId, aggregateId: runId, eventType: 'DiscoveryRunRequested' } });
      const command = parseDiscoveryV3Dispatch(event.payload);
      await expect(claimDiscoveryV3Dispatch(app, command, formatTenantWorkflowId(workspaceId, 'discovery', runId), true)).resolves.toBe(true);

      const store = new DiscoveryV3OperationStore(app);
      const resolve = vi.fn<NewApiRequestBoundSettlementResolverPort['resolve']>(async (request) => {
        const probe = { sequence: 1, phase: 'gateway_log_observed', httpStatusClass: 2 } as const;
        const probeId = await request.probeAuthority.claim(1);
        if (!probeId || !request.requestId) throw new Error('fixture reader lacks original probe authority');
        const receipt = { status: 'settled', requestId: request.requestId, alias: request.alias, protocol: request.protocol,
          channelId: 17, inputTokens: 120, outputTokens: 30, quota: 71, upstreamIdState: 'observed',
          physicalCallCount: 0, readbackProbes: [probe], receiptDigest: 'd'.repeat(64),
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID, actualCharge: { currency: 'USD', amountMicros: 1283 } } as const;
        await request.probeAuthority.record({ probeId, probe, observedAt: new Date(), receipt });
        return receipt;
      });
      const runtime: DiscoveryV3GatewayReadbackRuntime = {
        gatewayOrigin: 'https://synthetic-gateway.example',
        keyring: new SettlementDerivationKeyring([{ id: 'synthetic', status: 'ACTIVE', material: Buffer.alloc(32, 39) }]),
        resolver: { resolve, checkCapability: async () => ({ ready: true, resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID }) },
      };
      const startOperation = async (ordinal: number) => {
        const operation: DiscoveryV3OperationInput = { kind: 'MODEL', step: 'fixture/sweep', ordinal,
          requestSha256: 'a'.repeat(64), provider: 'gateway', action: 'discovery.qualify_fit', method: 'generateStructured', maxDurationMs: 30_000 };
        const claim = await store.claim(command, operation);
        if (claim.status !== 'CLAIMED') throw new Error('fixture claim missing');
        const wire = prepareDiscoveryV3GatewayWire(runtime, { command, operation, operationId: claim.operationId }, (fingerprintCredential) => ({
          gatewayOrigin: runtime.gatewayOrigin, alias: 'fixture', protocol: 'openai-chat-completions',
          maxOutputTokens: 150, credentialSha256: fingerprintCredential('synthetic-fixture-credential'),
        }));
        await store.authorizeSend(command, operation, claim, 1, wire.binding);
        const probeId = await store.claimModelReadbackProbe(command, operation, claim.operationId, wire.binding, 1);
        if (!probeId) throw new Error('fixture probe missing');
        await store.recordModelReadbackProbe(command, operation, claim.operationId, wire.binding, { probeId,
          probe: { sequence: 1, phase: 'gateway_log_pending', httpStatusClass: 2 }, observedAt: new Date() });
        return { operation, claim };
      };
      const replied = await startOperation(1);
      await store.finish(command, replied.operation, replied.claim, { outcome: 'SUCCEEDED', cost: { basis: 'UNKNOWN' } });
      const interrupted = await startOperation(2);
      const select = (limit: number) => app.$queryRaw<Array<{ operation_id: string; command: DiscoveryV3Dispatch }>>`
        SELECT operation_id, command FROM public.claim_discovery_v3_terminal_gateway_readbacks_v1(${limit}::integer)`;
      expect((await select(32)).some((row) => row.command.runId === runId)).toBe(false);

      await owner.discoveryRun.update({ where: { id: runId }, data: { createdAt: new Date(Date.now() - 216 * 60_000) } });
      await app.withWorkspace(workspaceId, async (tx) => {
        const run = await tx.discoveryRun.findUniqueOrThrow({ where: { id: runId } });
        const now = new Date();
        expect(discoveryV3WatchdogReason(run, now)).toBe('DISCOVERY_RUN_STALE');
        expect(await finalizeDiscoveryV3(tx, run, now, 'FAILED', 'DISCOVERY_RUN_STALE')).toBe(true);
      });
      expect((await select(32)).some((row) => row.command.runId === runId)).toBe(false);
      await owner.discoveryRun.update({ where: { id: runId }, data: { completedAt: new Date(Date.now() - 120_000) } });
      const before = await owner.usageLedger.findUniqueOrThrow({ where: { id: interrupted.claim.operationId } });
      const selected: string[] = [];
      for (let page = 0; page < 12 && selected.length < 2; page++) {
        const [row] = await select(1);
        if (row?.command.runId === runId) {
          expect(row.command).toEqual(command);
          selected.push(row.operation_id);
        }
      }
      expect(selected.sort()).toEqual([replied.claim.operationId, interrupted.claim.operationId].sort());
      await expect(app.withWorkspace(workspaceId, (tx) => tx.$queryRaw`
        SELECT operation_id FROM public.claim_discovery_v3_terminal_gateway_readbacks_v1(1)
      `)).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });

      const sweep = createDiscoveryV3GatewayTerminalSweep({
        $queryRaw: async () => (await select(32)).filter((row) => row.command.runId === runId),
        withWorkspace: app.withWorkspace.bind(app),
      } as Pick<PrismaService, '$queryRaw' | 'withWorkspace'>, runtime);
      await sweep(new AbortController().signal);
      await sweep(new AbortController().signal);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(await owner.discoveryV3GatewayProbe.count({ where: { workspaceId, operationId: interrupted.claim.operationId } })).toBe(2);
      expect(await owner.usageLedger.findUniqueOrThrow({ where: { id: interrupted.claim.operationId } })).toMatchObject({
        createdAt: before.createdAt, quantity: 150, costUsd: 0.001283, meta: { outcome: 'UNKNOWN', costSource: 'provider' },
      });
      expect(await owner.outboxEvent.findMany({ where: { aggregateId: runId, eventType: 'DiscoveryRunCompleted' } }))
        .toMatchObject([{ payload: { status: 'FAILED', cost: 0 } }]);
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  }, 30_000);
});
