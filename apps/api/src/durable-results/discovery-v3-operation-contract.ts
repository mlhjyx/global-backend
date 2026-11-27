import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { DiscoveryV3GatewayEvidence, DiscoveryV3GatewayReadbackBinding } from '../model-gateway/discovery-v3-gateway-contract';
import type { NewApiSettlementReadbackProbe } from '../model-gateway/settlement-readback-contract';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { canonicalJson } from '../tools/budget-operation-result';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';

export const DISCOVERY_V3_ROBOTS_PROOF = 'discovery-v3-robots/v1';

export interface DiscoveryV3OperationInput {
  readonly step: string;
  readonly kind: 'MODEL' | 'TOOL';
  readonly ordinal: number;
  readonly requestSha256: string;
  readonly provider: string;
  readonly action: string;
  readonly method: string;
  readonly maxDurationMs: number;
}

export type DiscoveryV3Cost =
  | { readonly basis: 'UNKNOWN' }
  | { readonly basis: 'ESTIMATED'; readonly amountMicros: number; readonly currency: 'USD'; readonly source: 'token' | 'tariff' }
  | { readonly basis: 'PROVIDER_REPORTED' | 'CONFIRMED_ZERO'; readonly amountMicros: number;
      readonly currency: string; readonly evidenceSha256: string };

export type DiscoveryV3WireUsage = { readonly inputTokens?: number; readonly outputTokens?: number };

export interface DiscoveryV3WireReceipt {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  // A registered projection or artifact reference supplied by the domain.
  readonly result?: GenericOperationProjection;
  readonly usage?: DiscoveryV3WireUsage;
  readonly model?: string;
  readonly cost: DiscoveryV3Cost;
}

export type DiscoveryV3OperationClaim =
  | DiscoveryV3ClaimedOperation
  | { status: 'UNKNOWN' | 'IN_FLIGHT' | 'FAILED'; operationId: string }
  | { status: 'REPLAY'; operationId: string; result: GenericOperationProjection | null; resultSha256: string | null };

export interface DiscoveryV3ClaimedOperation {
  readonly status: 'CLAIMED';
  readonly operationId: string;
  readonly deadline: Date;
  readonly proof: string;
}

export interface DiscoveryV3ReadbackProbeResult {
  readonly probeId: string;
  readonly probe: NewApiSettlementReadbackProbe;
  readonly observedAt: Date;
  readonly evidence?: DiscoveryV3GatewayEvidence;
}

/** The Worker supplies the tenant-scoped journal to the transport layer. */
export interface DiscoveryV3WireStore {
  claim(command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, workerAttempt?: number): Promise<DiscoveryV3OperationClaim>;
  authorizeSend(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, claim: DiscoveryV3ClaimedOperation, workerAttempt: number,
    readback?: DiscoveryV3GatewayReadbackBinding,
  ): Promise<number>;
  finish(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, claim: DiscoveryV3ClaimedOperation, receipt: DiscoveryV3WireReceipt,
    commitArtifact?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void>;
  claimModelReadbackProbe(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, operationId: string,
    binding: DiscoveryV3GatewayReadbackBinding, sequence: 1 | 2,
  ): Promise<string | null>;
  recordModelReadbackProbe(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, operationId: string,
    binding: DiscoveryV3GatewayReadbackBinding, result: DiscoveryV3ReadbackProbeResult,
  ): Promise<void>;
}

export type DiscoveryV3OperationErrorCode = 'DISCOVERY_V3_OPERATION_BINDING_MISMATCH'
  | 'DISCOVERY_V3_OPERATION_CONFLICT'
  | 'DISCOVERY_V3_OPERATION_UNRESOLVED'
  | 'DISCOVERY_V3_OPERATION_DEADLINE'
  | 'DISCOVERY_V3_OPERATION_LIMIT'
  | 'DISCOVERY_V3_OPERATION_INVALID'
  | 'DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT';

export class DiscoveryV3OperationError extends Error {
  constructor(readonly code: DiscoveryV3OperationErrorCode) {
    super(code);
    this.name = 'DiscoveryV3OperationError';
  }
}

export function discoveryV3Digest(value: Prisma.InputJsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
