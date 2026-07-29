import type { AiContext, ModelOp, ModelUsage } from './types';

export const PAID_MODEL_PROTOCOLS = [
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

export type PaidModelProtocol = (typeof PAID_MODEL_PROTOCOLS)[number];

export interface PaidModelCallPlan {
  taskId: string;
  op: ModelOp;
  alias: string;
  promptUtf8BytesPerCall: number;
  maxOutputTokens: number;
  maximumWireCalls: number;
  reservationMicrousd: number;
}

export interface PaidModelPreflightRequest {
  taskId: PaidModelCallPlan['taskId'];
  op: PaidModelCallPlan['op'];
  providerId: string;
  gatewayOrigin: string;
  credentialSha256: string;
  alias: PaidModelCallPlan['alias'];
  protocol: PaidModelProtocol;
  promptUtf8BytesPerCall: PaidModelCallPlan['promptUtf8BytesPerCall'];
  maxOutputTokens: PaidModelCallPlan['maxOutputTokens'];
  maximumWireCalls: PaidModelCallPlan['maximumWireCalls'];
  reservationMicrousd: PaidModelCallPlan['reservationMicrousd'];
}

/**
 * Redacted evidence copied into the paid-operation record. It contains no
 * bearer token, prompt, response body, or reversible credential material.
 */
export interface PaidModelPreflightEvidence {
  schemaVersion: 'site-builder-paid-model-preflight-evidence/v2';
  attestationId: string;
  snapshotSha256: string;
  resolverId: string;
  taskId: string;
  alias: string;
  protocol: PaidModelProtocol;
  expectedChannelId: number;
  pricingAuthority: 'openox_model_marketplace';
  pricingSourceUrl: string;
  pricingSnapshotSha256: string;
  pricingCurrency: 'USD' | 'CNY';
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
  gatewayCredentialQuotaCapPoints: number;
  gatewayCredentialRemainingPoints: number;
  pricedMaximumMicrousd: number;
}

export type GatewaySettlementObservation =
  | {
      status: 'settled';
      requestId: string;
      resolverId: string;
      alias: string;
      protocol: PaidModelProtocol;
      channelId: number;
      basis: 'openox_catalog_token_pricing';
      quota: number;
      costMicrousd: number;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: 'unknown';
      requestId: string | null;
      resolverId: string;
      reason:
        | 'request_id_missing'
        | 'log_unavailable'
        | 'log_ambiguous'
        | 'log_invalid'
        | 'model_mismatch'
        | 'channel_mismatch';
    };

export interface PaidModelSettlementController {
  preflight(
    request: PaidModelPreflightRequest,
    ctx: AiContext,
  ): Promise<PaidModelPreflightEvidence>;
  resolve(input: {
    requestId: string | null;
    evidence: PaidModelPreflightEvidence;
    usage?: Pick<ModelUsage, 'inputTokens' | 'outputTokens'>;
  }): Promise<GatewaySettlementObservation>;
}

export class PaidModelPreflightError extends Error {
  constructor(public readonly code: string) {
    super(`paid model preflight denied: ${code}`);
    this.name = 'PaidModelPreflightError';
  }
}
