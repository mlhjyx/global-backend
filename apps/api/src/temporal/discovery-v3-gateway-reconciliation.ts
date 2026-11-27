import { DiscoveryV3OperationStore } from '../discovery/discovery-v3-operations';
import { discoveryV3GatewayReportedCost, type DiscoveryV3GatewayEvidence } from '../model-gateway/discovery-v3-gateway-contract';
import { createDiscoveryV3GatewayReadbackRuntimeFromEnv, readDiscoveryV3GatewayEvidence,
  type DiscoveryV3GatewayReadbackRuntime } from '../model-gateway/discovery-v3-gateway-readback';
import type { RouterModelGateway } from '../model-gateway/router-model-gateway';
import type { PrismaService } from '../prisma/prisma.service';
import { discoveryV3Uuid, parseDiscoveryV3Dispatch, type DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';

const READBACK_PAGE_SIZE = 16;
const TERMINAL_SWEEP_CONCURRENCY = 4;
const RECONCILIATION_TIMEOUT_MS = 20_000;
const RECONCILIATION_PENDING = 'DISCOVERY_V3_GATEWAY_RECONCILIATION_PENDING';

type PendingReadback = Awaited<ReturnType<DiscoveryV3OperationStore['listPendingModelReadbacks']>>[number];

export async function configureDiscoveryV3GatewayWorker(prisma: PrismaService, gateway: RouterModelGateway) {
  const runtime = await createDiscoveryV3GatewayReadbackRuntimeFromEnv().catch(() => {
    console.warn('[worker] DISCOVERY_V3_GATEWAY_READBACK_UNAVAILABLE');
    return undefined;
  });
  gateway.discoveryV3SettlementReadback = runtime;
  return runtime ? {
    reconcile: createDiscoveryV3GatewayReconciler(prisma),
    sweep: createDiscoveryV3GatewayTerminalSweep(prisma, runtime),
  } : {};
}

async function applyObservedGatewayEvidence(
  store: DiscoveryV3OperationStore, command: DiscoveryV3Dispatch,
  pending: PendingReadback, evidence: DiscoveryV3GatewayEvidence | undefined,
): Promise<void> {
  if (!evidence) return;
  const cost = discoveryV3GatewayReportedCost(evidence);
  if (!cost) return;
  await store.recordCostEvidence(command, pending.operation, pending.operationId, cost, {
    inputTokens: evidence.inputTokens, outputTokens: evidence.outputTokens,
  });
}

/** Applies already journaled evidence. A pending amount keeps its second read for the watchdog. */
export function createDiscoveryV3GatewayReconciler(
  prisma: Pick<PrismaService, 'withWorkspace'>,
) {
  const store = new DiscoveryV3OperationStore(prisma);
  return async (command: DiscoveryV3Dispatch, callerSignal: AbortSignal): Promise<void> => {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS)]);
    let afterOperationId: string | undefined;
    let failed = false;
    while (!signal.aborted) {
      const page = await store.listPendingModelReadbacks(command, READBACK_PAGE_SIZE, afterOperationId);
      for (const pending of page) {
        if (signal.aborted) break;
        try {
          await applyObservedGatewayEvidence(store, command, pending, pending.evidence);
        } catch {
          failed = true;
        }
      }
      if (page.length < READBACK_PAGE_SIZE) break;
      afterOperationId = page.at(-1)!.operationId;
    }
    if (failed) throw new Error(RECONCILIATION_PENDING);
  };
}

/** A watchdog tick selects only terminal operations, then re-enters each workspace independently. */
export function createDiscoveryV3GatewayTerminalSweep(
  prisma: Pick<PrismaService, '$queryRaw' | 'withWorkspace'>,
  runtime: DiscoveryV3GatewayReadbackRuntime,
) {
  const store = new DiscoveryV3OperationStore(prisma);
  return async (callerSignal: AbortSignal): Promise<void> => {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS)]);
    if (signal.aborted) return;
    const selected = await prisma.$queryRaw<Array<{ operation_id: string; command: unknown }>>`
      SELECT operation_id, command FROM public.claim_discovery_v3_terminal_gateway_readbacks_v1(${READBACK_PAGE_SIZE}::integer)
    `;
    let failed = false;
    for (let index = 0; index < selected.length && !signal.aborted; index += TERMINAL_SWEEP_CONCURRENCY) {
      const group = selected.slice(index, index + TERMINAL_SWEEP_CONCURRENCY);
      const outcomes = await Promise.allSettled(group.map(async (row) => {
        const command = parseDiscoveryV3Dispatch(row.command);
        const pending = await store.getPendingModelReadback(command, discoveryV3Uuid(row.operation_id));
        if (!pending || signal.aborted) return;
        const evidence = pending.evidence ?? await readDiscoveryV3GatewayEvidence({
          ...pending, command, runtime, store, signal, probeSequence: 2,
        });
        await applyObservedGatewayEvidence(store, command, pending, evidence);
      }));
      failed ||= outcomes.some((outcome) => outcome.status === 'rejected');
    }
    if (failed) throw new Error(RECONCILIATION_PENDING);
  };
}
