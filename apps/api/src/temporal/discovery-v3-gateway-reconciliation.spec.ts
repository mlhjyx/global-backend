import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryV3GatewayEvidence } from '../model-gateway/discovery-v3-gateway-contract';
import type { DiscoveryV3GatewayReadbackRuntime } from '../model-gateway/discovery-v3-gateway-readback';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { createDiscoveryV3GatewayReconciler, createDiscoveryV3GatewayTerminalSweep } from './discovery-v3-gateway-reconciliation';

const store = vi.hoisted(() => ({
  listPendingModelReadbacks: vi.fn(), getPendingModelReadback: vi.fn(), recordCostEvidence: vi.fn(),
}));
const reader = vi.hoisted(() => ({ readDiscoveryV3GatewayEvidence: vi.fn() }));
vi.mock('../discovery/discovery-v3-operations', () => ({
  DiscoveryV3OperationStore: class {
    listPendingModelReadbacks = store.listPendingModelReadbacks;
    getPendingModelReadback = store.getPendingModelReadback;
    recordCostEvidence = store.recordCostEvidence;
  },
}));
vi.mock('../model-gateway/discovery-v3-gateway-readback', () => reader);

const command: DiscoveryV3Dispatch = {
  executionContractVersion: 3,
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  planId: '33333333-3333-4333-8333-333333333333',
  icpId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
  requestSha256: 'b'.repeat(64),
  taskQueue: 'batch-discovery',
  dispatchExpiresAt: '2026-11-27T00:00:00.000Z',
};
const runtime = {} as DiscoveryV3GatewayReadbackRuntime;
const operation = {
  kind: 'MODEL', step: 'fit/example', ordinal: 1, action: 'discovery.qualify_fit', provider: 'gateway', method: 'generateStructured',
  requestSha256: 'c'.repeat(64), maxDurationMs: 5_000,
} as const;
const evidence: DiscoveryV3GatewayEvidence = {
  requestId: 'R'.repeat(43), alias: 'fixture', protocol: 'openai-chat-completions', channelId: 17, quotaPoints: 42,
  inputTokens: 120, outputTokens: 30, upstreamIdState: 'observed', receiptSha256: 'd'.repeat(64),
  actualCharge: { currency: 'USD', amountMicros: 1_283 },
};

function pending(n: number, observed: DiscoveryV3GatewayEvidence | undefined = evidence) {
  return { operation, operationId: `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`, evidence: observed };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Discovery v3 gateway reconciliation', () => {
  it('scans past the first sixteen durable receipts and advances despite a failed accounting write', async () => {
    const ops = Array.from({ length: 18 }, (_, index) => pending(index + 1));
    store.listPendingModelReadbacks.mockResolvedValueOnce(ops.slice(0, 16)).mockResolvedValueOnce(ops.slice(16));
    store.recordCostEvidence.mockRejectedValueOnce(new Error('fixture unavailable'));

    const reconcile = createDiscoveryV3GatewayReconciler({} as never);
    await expect(reconcile(command, new AbortController().signal)).rejects.toThrow('DISCOVERY_V3_GATEWAY_RECONCILIATION_PENDING');

    expect(store.listPendingModelReadbacks).toHaveBeenNthCalledWith(1, command, 16, undefined);
    expect(store.listPendingModelReadbacks).toHaveBeenNthCalledWith(2, command, 16, ops[15]!.operationId);
    expect(store.recordCostEvidence.mock.calls.map((call) => call[2])).toEqual(ops.map(({ operationId }) => operationId));
    expect(reader.readDiscoveryV3GatewayEvidence).not.toHaveBeenCalled();
  });

  it('stops selecting rows when the original activity is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const reconcile = createDiscoveryV3GatewayReconciler({} as never);
    await reconcile(command, controller.signal);
    expect(store.listPendingModelReadbacks).not.toHaveBeenCalled();
    expect(reader.readDiscoveryV3GatewayEvidence).not.toHaveBeenCalled();
  });

  it('reserves the second gateway probe when a new terminal run only has pending evidence', async () => {
    store.listPendingModelReadbacks.mockResolvedValue([{ ...pending(1), evidence: undefined }]);
    reader.readDiscoveryV3GatewayEvidence.mockResolvedValue(undefined);
    const reconcile = createDiscoveryV3GatewayReconciler({} as never);
    await reconcile(command, new AbortController().signal);
    expect(reader.readDiscoveryV3GatewayEvidence).not.toHaveBeenCalled();
    expect(store.recordCostEvidence).not.toHaveBeenCalled();
  });

  it('isolates each recovered terminal scope and uses only the original second probe', async () => {
    const terminal = { ...command, workspaceId: '77777777-7777-4777-8777-777777777777' };
    const recovered = { ...pending(2), evidence: undefined };
    const select = vi.fn().mockResolvedValue([
      { operation_id: pending(1).operationId, command },
      { operation_id: recovered.operationId, command: terminal },
      { operation_id: pending(3).operationId, command: { ...command, requestSha256: 'unbound' } },
      { operation_id: pending(4).operationId, command },
    ]);
    store.getPendingModelReadback.mockImplementation(async (_command, operationId: string) =>
      operationId === recovered.operationId ? recovered : { ...pending(1), operationId });
    store.recordCostEvidence.mockRejectedValueOnce(new Error('fixture accounting conflict'));
    reader.readDiscoveryV3GatewayEvidence.mockResolvedValue(evidence);

    const sweep = createDiscoveryV3GatewayTerminalSweep({ $queryRaw: select } as never, runtime);
    await expect(sweep(new AbortController().signal)).rejects.toThrow('DISCOVERY_V3_GATEWAY_RECONCILIATION_PENDING');

    expect(select).toHaveBeenCalledTimes(1);
    expect(store.getPendingModelReadback.mock.calls).toEqual([
      [command, pending(1).operationId], [terminal, recovered.operationId], [command, pending(4).operationId],
    ]);
    expect(reader.readDiscoveryV3GatewayEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      command: terminal, operationId: recovered.operationId, probeSequence: 2, signal: expect.any(AbortSignal),
    }));
    expect(store.recordCostEvidence.mock.calls).toEqual(expect.arrayContaining([
      [terminal, operation, recovered.operationId,
        { basis: 'PROVIDER_REPORTED', amountMicros: 1_283, currency: 'USD', evidenceSha256: evidence.receiptSha256 },
        { inputTokens: 120, outputTokens: 30 }],
    ]));
    expect(store.recordCostEvidence).toHaveBeenCalledTimes(3);
  });
});
