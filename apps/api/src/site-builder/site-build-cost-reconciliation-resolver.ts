import { createHash } from 'node:crypto';
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  NewApiRequestBoundSettlementResolver,
  type NewApiRequestBoundSettlementInput,
  type NewApiRequestBoundSettlement,
} from '../model-gateway/new-api-request-bound-settlement';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import type { SiteBuildReconciliationObservation } from './site-build-cost-ledger';

const CATALOG_SCHEMA = 'site-build-cost-reconciliation-catalog/v1' as const;
const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_CATALOG_ENTRIES = 256;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,190}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROTOCOLS = new Set([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
]);

export interface SiteBuildReconciliationCandidate {
  spendId: string;
  operationKey: string;
  meta: Record<string, unknown> | null;
}

export interface SiteBuildCostReconciliationResolver {
  resolve(
    candidate: SiteBuildReconciliationCandidate,
  ): Promise<SiteBuildReconciliationObservation>;
}

type RequestBoundResolver = {
  resolve(
    input: NewApiRequestBoundSettlementInput,
  ): Promise<NewApiRequestBoundSettlement>;
};

export interface SiteBuildSettlementContext {
  schemaVersion: typeof CATALOG_SCHEMA;
  catalogId: string;
  catalogSha256: string;
  pricingAuthority: 'openox_model_marketplace';
  pricingSnapshotSha256: string;
  pricingCurrency: 'USD';
  providerId: 'gateway';
  taskId: string;
  resolverId: string;
  alias: string;
  protocol: string;
  expectedChannelId: number;
  maxOutputTokensPerCall: number;
  gatewayCredentialQuotaCapPoints: number;
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
}

type StoredSiteBuildSettlementContext = SiteBuildSettlementContext;

interface TrustedContext extends SiteBuildSettlementContext {
  requestId: string;
}

export interface SiteBuildCostReconciliationCatalog {
  resolveContext(input: {
    providerId: string;
    taskId: string;
    alias: string;
    maxOutputTokens: number | undefined;
  }): StoredSiteBuildSettlementContext | null;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trustedContext(
  meta: Record<string, unknown> | null,
): TrustedContext | null {
  const preflight = meta?.settlementContext;
  const settlements = meta?.gatewaySettlements;
  if (
    !preflight ||
    typeof preflight !== 'object' ||
    Array.isArray(preflight) ||
    !Array.isArray(settlements)
  ) {
    return null;
  }
  const proof = preflight as Record<string, unknown>;
  const pending = settlements.find(
    (value) =>
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).status === 'unknown',
  ) as Record<string, unknown> | undefined;
  const requestId = pending?.requestId;
  const resolverId = proof.resolverId;
  const alias = proof.alias;
  const protocol = proof.protocol;
  const catalogId = proof.catalogId;
  const catalogSha256 = proof.catalogSha256;
  const pricingSnapshotSha256 = proof.pricingSnapshotSha256;
  const taskId = proof.taskId;
  if (
    proof.schemaVersion !== CATALOG_SCHEMA ||
    typeof catalogId !== 'string' ||
    !BOUNDED_ID.test(catalogId) ||
    typeof catalogSha256 !== 'string' ||
    !SHA256.test(catalogSha256) ||
    proof.pricingAuthority !== 'openox_model_marketplace' ||
    typeof pricingSnapshotSha256 !== 'string' ||
    !SHA256.test(pricingSnapshotSha256) ||
    proof.pricingCurrency !== 'USD' ||
    proof.providerId !== 'gateway' ||
    typeof taskId !== 'string' ||
    !BOUNDED_ID.test(taskId) ||
    typeof requestId !== 'string' ||
    typeof resolverId !== 'string' ||
    pending?.resolverId !== resolverId ||
    typeof alias !== 'string' ||
    !BOUNDED_ID.test(alias) ||
    typeof protocol !== 'string' ||
    !PROTOCOLS.has(protocol) ||
    protocol !==
      (VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ??
        'openai-chat-completions') ||
    !positiveSafeInteger(proof.expectedChannelId) ||
    !positiveSafeInteger(proof.maxOutputTokensPerCall) ||
    !positiveSafeInteger(proof.gatewayCredentialQuotaCapPoints) ||
    !nonNegativeSafeInteger(proof.inputPriceMicrounitsPerMillionTokens) ||
    !nonNegativeSafeInteger(proof.outputPriceMicrounitsPerMillionTokens) ||
    proof.ledgerMicrousdPerPricingUnit !== 1_000_000
  ) {
    return null;
  }
  return {
    schemaVersion: CATALOG_SCHEMA,
    catalogId,
    catalogSha256,
    pricingAuthority: 'openox_model_marketplace',
    pricingSnapshotSha256,
    pricingCurrency: 'USD',
    providerId: 'gateway',
    taskId,
    requestId,
    resolverId,
    alias,
    protocol,
    expectedChannelId: proof.expectedChannelId,
    maxOutputTokensPerCall: proof.maxOutputTokensPerCall,
    gatewayCredentialQuotaCapPoints:
      proof.gatewayCredentialQuotaCapPoints,
    inputPriceMicrounitsPerMillionTokens:
      proof.inputPriceMicrounitsPerMillionTokens,
    outputPriceMicrounitsPerMillionTokens:
      proof.outputPriceMicrounitsPerMillionTokens,
    ledgerMicrousdPerPricingUnit: proof.ledgerMicrousdPerPricingUnit,
  };
}

function pricedCostMicrousd(
  context: TrustedContext,
  inputTokens: number,
  outputTokens: number,
): string | null {
  const numerator =
    BigInt(inputTokens) *
      BigInt(context.inputPriceMicrounitsPerMillionTokens) +
    BigInt(outputTokens) *
      BigInt(context.outputPriceMicrounitsPerMillionTokens);
  const denominator = 1_000_000_000_000n;
  const value =
    (numerator * BigInt(context.ledgerMicrousdPerPricingUnit) +
      denominator -
      1n) /
    denominator;
  return value <= 9_223_372_036_854_775_807n ? value.toString(10) : null;
}

function parseCatalog(
  raw: string,
): SiteBuildCostReconciliationCatalog | undefined {
  if (
    raw !== raw.trim() ||
    Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES
  ) {
    return undefined;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const entries = parsed?.entries;
  const catalogId = parsed?.catalogId;
  const resolverId = parsed?.resolverId;
  const pricingSnapshotSha256 = parsed?.pricingSnapshotSha256;
  if (
    parsed?.schemaVersion !== CATALOG_SCHEMA ||
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > MAX_CATALOG_ENTRIES ||
    typeof catalogId !== 'string' ||
    !BOUNDED_ID.test(catalogId) ||
    typeof resolverId !== 'string' ||
    !BOUNDED_ID.test(resolverId) ||
    // 目录声明的 resolver 身份必须就是 provider 写入 unknown 观测、且
    // sweep resolver 使用的同一身份；否则 trustedContext 会永久拒绝
    // spend meta，对账只能在 24 小时后 EXPIRED——部署期 fail closed。
    resolverId !== NEW_API_REQUEST_BOUND_RESOLVER_ID ||
    parsed.pricingAuthority !== 'openox_model_marketplace' ||
    parsed.pricingCurrency !== 'USD' ||
    typeof pricingSnapshotSha256 !== 'string' ||
    !SHA256.test(pricingSnapshotSha256) ||
    parsed.ledgerMicrousdPerPricingUnit !== 1_000_000
  ) {
    return undefined;
  }
  const catalogSha256 = createHash('sha256').update(raw).digest('hex');
  const contexts = new Map<string, StoredSiteBuildSettlementContext>();
  for (const value of entries) {
    const entry = record(value);
    if (!entry) return undefined;
    const providerId = entry?.providerId;
    const taskId = entry?.taskId;
    const alias = entry?.alias;
    const protocol = entry?.protocol;
    if (
      providerId !== 'gateway' ||
      typeof taskId !== 'string' ||
      !BOUNDED_ID.test(taskId) ||
      typeof alias !== 'string' ||
      !BOUNDED_ID.test(alias) ||
      typeof protocol !== 'string' ||
      !PROTOCOLS.has(protocol) ||
      protocol !==
        (VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ??
          'openai-chat-completions') ||
      !positiveSafeInteger(entry.expectedChannelId) ||
      !positiveSafeInteger(entry.maxOutputTokensPerCall) ||
      !positiveSafeInteger(entry.gatewayCredentialQuotaCapPoints) ||
      !nonNegativeSafeInteger(entry.inputPriceMicrounitsPerMillionTokens) ||
      !nonNegativeSafeInteger(entry.outputPriceMicrounitsPerMillionTokens)
    ) {
      return undefined;
    }
    const key = `${providerId}\0${taskId}\0${alias}`;
    if (contexts.has(key)) return undefined;
    contexts.set(
      key,
      Object.freeze({
        schemaVersion: CATALOG_SCHEMA,
        catalogId,
        catalogSha256,
        pricingAuthority: 'openox_model_marketplace' as const,
        pricingSnapshotSha256,
        pricingCurrency: 'USD' as const,
        providerId,
        taskId,
        resolverId,
        alias,
        protocol,
        expectedChannelId: entry.expectedChannelId,
        maxOutputTokensPerCall: entry.maxOutputTokensPerCall,
        gatewayCredentialQuotaCapPoints:
          entry.gatewayCredentialQuotaCapPoints,
        inputPriceMicrounitsPerMillionTokens:
          entry.inputPriceMicrounitsPerMillionTokens,
        outputPriceMicrounitsPerMillionTokens:
          entry.outputPriceMicrounitsPerMillionTokens,
        ledgerMicrousdPerPricingUnit: 1_000_000,
      }),
    );
  }
  const catalog: SiteBuildCostReconciliationCatalog = {
    resolveContext(input: {
      providerId: string;
      taskId: string;
      alias: string;
      maxOutputTokens: number | undefined;
    }) {
      if (!positiveSafeInteger(input.maxOutputTokens)) return null;
      const context = contexts.get(
        `${input.providerId}\0${input.taskId}\0${input.alias}`,
      );
      if (
        !context ||
        input.maxOutputTokens > context.maxOutputTokensPerCall
      ) {
        return null;
      }
      return context;
    },
  };
  return Object.freeze(catalog);
}

export function createSiteBuildCostReconciliationCatalogFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SiteBuildCostReconciliationCatalog | undefined {
  const raw = env.SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON;
  return raw ? parseCatalog(raw) : undefined;
}

export class NewApiSiteBuildCostReconciliationResolver
  implements SiteBuildCostReconciliationResolver
{
  constructor(private readonly resolver: RequestBoundResolver) {}

  async resolve(
    candidate: SiteBuildReconciliationCandidate,
  ): Promise<SiteBuildReconciliationObservation> {
    const context = trustedContext(candidate.meta);
    if (!context) {
      return {
        status: 'UNRESOLVED',
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        observedAt: new Date(),
        meta: { reason: 'trusted_settlement_context_unavailable' },
      };
    }
    const settlement = await this.resolver.resolve({
      requestId: context.requestId,
      alias: context.alias,
      protocol: context.protocol,
      expectedChannelId: context.expectedChannelId,
      maxOutputTokens: context.maxOutputTokensPerCall,
      maximumQuotaPoints: context.gatewayCredentialQuotaCapPoints,
    });
    if (settlement.status === 'unknown') {
      return {
        status: 'UNRESOLVED',
        resolverId: settlement.resolverId,
        requestId: settlement.requestId ?? undefined,
        observedAt: new Date(),
        meta: { reason: settlement.reason },
      };
    }
    if (settlement.resolverId !== context.resolverId) {
      return {
        status: 'UNRESOLVED',
        resolverId: context.resolverId,
        requestId: context.requestId,
        observedAt: new Date(),
        meta: { reason: 'resolver_identity_mismatch' },
      };
    }
    const exactCostMicrousd = pricedCostMicrousd(
      context,
      settlement.inputTokens,
      settlement.outputTokens,
    );
    if (exactCostMicrousd === null) {
      return {
        status: 'UNRESOLVED',
        resolverId: context.resolverId,
        requestId: context.requestId,
        observedAt: new Date(),
        meta: { reason: 'trusted_price_mapping_invalid' },
      };
    }
    return {
      status: 'RESOLVED',
      resolverId: settlement.resolverId,
      requestId: settlement.requestId,
      receiptDigest: settlement.receiptDigest,
      costBasis: 'token_pricing',
      exactCostMicrousd,
      inputTokens: settlement.inputTokens,
      outputTokens: settlement.outputTokens,
      observedAt: new Date(),
      meta: {
        alias: settlement.alias,
        protocol: settlement.protocol,
        channelId: settlement.channelId,
        quota: settlement.quota,
      },
    };
  }
}

export function createSiteBuildCostReconciliationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SiteBuildCostReconciliationResolver | undefined {
  const gatewayUrl = env.MODEL_GATEWAY_URL;
  const apiKey = env.MODEL_GATEWAY_KEY;
  if (!gatewayUrl || !apiKey) return undefined;
  try {
    const origin = new URL(gatewayUrl).origin;
    const rawPoll = Number(env.SITE_BUILD_COST_RECONCILIATION_POLL_MS ?? 5_000);
    const maximumPollDurationMs = Number.isSafeInteger(rawPoll)
      ? Math.max(1, Math.min(30_000, rawPoll))
      : 5_000;
    return new NewApiSiteBuildCostReconciliationResolver(
      new NewApiRequestBoundSettlementResolver({
        gatewayOrigin: origin,
        apiKey,
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        maximumPollDurationMs,
      }),
    );
  } catch {
    return undefined;
  }
}
