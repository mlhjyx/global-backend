import type { DiscoveryV3Cost } from '../durable-results/discovery-v3-operation-contract';
import type { PaidModelProtocol } from './paid-model-settlement';
import type { NewApiReportedMonetaryCharge } from './settlement-readback-contract';
import type { DurableSettlementWireIdentity } from './settlement-wire-identity';

export interface DiscoveryV3GatewayRoute {
  readonly gatewayOrigin: string;
  readonly credentialSha256: string;
  readonly alias: string;
  readonly protocol: PaidModelProtocol;
  readonly maxOutputTokens: number;
}

/** Redacted context persisted with the original send fence. */
export interface DiscoveryV3GatewayReadbackBinding extends DiscoveryV3GatewayRoute {
  readonly identity: DurableSettlementWireIdentity;
}

export interface DiscoveryV3GatewayEvidence {
  readonly requestId: string;
  readonly alias: string;
  readonly protocol: PaidModelProtocol;
  readonly channelId: number;
  readonly quotaPoints: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly upstreamIdState: 'observed' | 'absent';
  readonly receiptSha256: string;
  readonly actualCharge?: Readonly<NewApiReportedMonetaryCharge>;
}

export function discoveryV3GatewayReportedCost(evidence: DiscoveryV3GatewayEvidence):
  Extract<DiscoveryV3Cost, { basis: 'PROVIDER_REPORTED' | 'CONFIRMED_ZERO' }> | undefined {
  const charge = evidence.actualCharge;
  if (!charge) return undefined;
  return {
    ...charge,
    basis: charge.amountMicros === 0 ? 'CONFIRMED_ZERO' : 'PROVIDER_REPORTED',
    evidenceSha256: evidence.receiptSha256,
  };
}
