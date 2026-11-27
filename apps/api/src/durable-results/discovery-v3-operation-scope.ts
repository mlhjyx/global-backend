import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import {
  DiscoveryV3OperationError,
  type DiscoveryV3ClaimedOperation,
  type DiscoveryV3OperationInput,
  type DiscoveryV3WireReceipt,
  type DiscoveryV3WireStore,
} from './discovery-v3-operation-contract';

interface ScopeInput {
  readonly command: DiscoveryV3Dispatch;
  readonly step: string;
  readonly store: DiscoveryV3WireStore;
  readonly signal: AbortSignal;
  readonly workerAttempt?: number;
  readonly onResult?: (receipt: DiscoveryV3ResultLink) => void;
}

export interface DiscoveryV3ResultLink {
  readonly operation: DiscoveryV3OperationInput;
  readonly operationId: string;
  readonly resultSha256: string;
}

interface NativeOperationScope extends ScopeInput {
  nextModel: number;
  nextTool: number;
}

const scope = new AsyncLocalStorage<NativeOperationScope>();

/** Installed by the claimed Customer Worker activity for one logical step. */
export function withDiscoveryV3OperationScope<T>(input: ScopeInput, invoke: () => Promise<T>): Promise<T> {
  return scope.run({ ...input, nextModel: 0, nextTool: 0 }, invoke);
}

export function currentDiscoveryV3OperationScope(context: { workspaceId: string; runId?: string }): NativeOperationScope | undefined {
  const active = scope.getStore();
  if (active && (active.command.workspaceId !== context.workspaceId || active.command.runId !== context.runId)) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  return active;
}

export async function persistDiscoveryV3WireReceipt(
  active: NativeOperationScope, operation: DiscoveryV3OperationInput, claim: DiscoveryV3ClaimedOperation, receipt: DiscoveryV3WireReceipt,
  commitArtifact?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await active.store.finish(active.command, operation, claim, receipt, commitArtifact);
  } catch (error) {
    if (error instanceof DiscoveryV3OperationError) throw error;
    // Retry only persistence with the same evidence. An ambiguous commit
    // never authorizes another provider request.
    await active.store.finish(active.command, operation, claim, receipt, commitArtifact);
  }
}

export function discoveryV3WireSignal(
  scopeSignal: AbortSignal, remainingAtAuthorizationMs: number, authorizationStarted: number, callerSignal?: AbortSignal,
): AbortSignal {
  scopeSignal.throwIfAborted();
  callerSignal?.throwIfAborted();
  const remaining = remainingAtAuthorizationMs - Math.ceil(performance.now() - authorizationStarted);
  if (remaining <= 0) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_DEADLINE');
  return AbortSignal.any([scopeSignal, AbortSignal.timeout(remaining), ...(callerSignal ? [callerSignal] : [])]);
}
