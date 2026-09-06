import { createHash } from "node:crypto";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  NewApiRequestBoundSettlementResolver,
  type NewApiRequestBoundSettlementInput,
  type NewApiRequestBoundSettlement,
} from "../model-gateway/new-api-request-bound-settlement";
import {
  loadSettlementDerivationKeyring,
  settlementWireNonce,
  type SettlementDerivationKeyring,
} from "../model-gateway/settlement-wire-identity";
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from "../model-gateway/model-transports";
import type { PaidModelProtocol } from "../model-gateway/paid-model-settlement";
import { createProviderTransportObservation } from "../model-gateway/provider-transport-observation";
import {
  canonicalGatewayCredential,
  gatewayCredentialsAreDistinct,
} from "../model-gateway/gateway-credential-boundary";
import type {
  SiteBuildProviderReconciliationCandidate,
  SiteBuildReconciliationObservation,
} from "./site-build-cost-ledger";

const CATALOG_SCHEMA = "site-build-cost-reconciliation-catalog/v1" as const;
const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_CATALOG_ENTRIES = 256;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,190}$/;
const DURABLE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const DURABLE_MODEL_NUMERIC_MAXIMUM = 1_000_000_000;
const MAX_PRICE_MICROUNITS_PER_MILLION = 500_000_000_000;
const MAX_DURABLE_COST_MICROUSD = 1_000_000_000_000_000n;
const SHA256 = /^[0-9a-f]{64}$/;
const PROTOCOLS = new Set([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

export type SiteBuildReconciliationCandidate =
  SiteBuildProviderReconciliationCandidate;

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

type ProviderWireAuthority = {
  claimModelReadbackProbe(input: {
    workspaceId: string;
    wireAttemptId: string;
    sequence: 1 | 2;
  }): Promise<string | null>;
  recordModelReadbackProbe(input: {
    workspaceId: string;
    probeId: string;
    probe: import("../model-gateway/new-api-request-bound-settlement").NewApiSettlementReadbackProbe;
    observedAt: Date;
  }): Promise<void>;
  recordModelPhysicalWireReceipt(input: {
    workspaceId: string;
    wireAttemptId: string;
    observation: import("../model-gateway/paid-model-settlement").GatewaySettlementObservation & {
      status: "settled";
    };
    receiptDigest: string;
    observedAt: Date;
  }): Promise<void>;
  finalizeModelPhysicalWire(input: {
    workspaceId: string;
    wireAttemptId: string;
    observation: import("../model-gateway/paid-model-settlement").GatewaySettlementObservation;
    observedAt: Date;
  }): Promise<void>;
  finalizeModelPhysicalWireFromReceipt(input: {
    workspaceId: string;
    wireAttemptId: string;
  }): Promise<void>;
  completeProviderSpendReconciliation(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    spendId: string;
    resolverId: string;
    observedAt: Date;
  }): Promise<SiteBuildReconciliationObservation>;
};

export interface SiteBuildSettlementContext {
  schemaVersion: typeof CATALOG_SCHEMA;
  catalogId: string;
  catalogSha256: string;
  pricingAuthority: "openox_model_marketplace";
  pricingSnapshotSha256: string;
  pricingCurrency: "USD";
  providerId: "gateway";
  taskId: string;
  resolverId: string;
  alias: string;
  protocol: PaidModelProtocol;
  expectedChannelId: number;
  maxOutputTokensPerCall: number;
  gatewayCredentialQuotaCapPoints: number;
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
}

type StoredSiteBuildSettlementContext = SiteBuildSettlementContext;

export interface SiteBuildCostReconciliationCatalog {
  resolveContext(input: {
    providerId: string;
    taskId: string;
    alias: string;
    maxOutputTokens: number | undefined;
  }): StoredSiteBuildSettlementContext | null;
}

export interface SiteBuildCostReconciliationRouteRequirement {
  readonly taskId: string;
  readonly alias: string;
  readonly maxOutputTokens: number;
}

export function costReconciliationCatalogCoversRoutes(
  catalog: SiteBuildCostReconciliationCatalog | undefined,
  requirements: readonly SiteBuildCostReconciliationRouteRequirement[],
): boolean {
  return (
    catalog !== undefined &&
    requirements.length > 0 &&
    requirements.every(
      (requirement) =>
        catalog.resolveContext({
          providerId: "gateway",
          taskId: requirement.taskId,
          alias: requirement.alias,
          maxOutputTokens: requirement.maxOutputTokens,
        }) !== null,
    )
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveDurableModelInteger(value: unknown): value is number {
  return (
    positiveSafeInteger(value) && Number(value) <= DURABLE_MODEL_NUMERIC_MAXIMUM
  );
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedPrice(value: unknown): value is number {
  return (
    nonNegativeSafeInteger(value) &&
    Number(value) <= MAX_PRICE_MICROUNITS_PER_MILLION
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pricedCostMicrousd(
  context: Pick<
    SiteBuildReconciliationCandidate,
    | "inputPriceMicrounitsPerMillionTokens"
    | "outputPriceMicrounitsPerMillionTokens"
    | "ledgerMicrousdPerPricingUnit"
  >,
  inputTokens: number,
  outputTokens: number,
): string | null {
  const numerator =
    BigInt(inputTokens) * BigInt(context.inputPriceMicrounitsPerMillionTokens) +
    BigInt(outputTokens) *
      BigInt(context.outputPriceMicrounitsPerMillionTokens);
  const denominator = 1_000_000_000_000n;
  const value =
    (numerator * BigInt(context.ledgerMicrousdPerPricingUnit) +
      denominator -
      1n) /
    denominator;
  return value <= MAX_DURABLE_COST_MICROUSD ? value.toString(10) : null;
}

function parseCatalog(
  raw: string,
): SiteBuildCostReconciliationCatalog | undefined {
  if (
    raw !== raw.trim() ||
    Buffer.byteLength(raw, "utf8") > MAX_CATALOG_BYTES
  ) {
    return undefined;
  }
  let parsed: Record<string, unknown> | null;
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
    typeof catalogId !== "string" ||
    !BOUNDED_ID.test(catalogId) ||
    typeof resolverId !== "string" ||
    !BOUNDED_ID.test(resolverId) ||
    // 目录声明的 resolver 身份必须就是 provider 写入 unknown 观测、且
    // sweep resolver 使用的同一身份；否则 trustedContext 会永久拒绝
    // spend meta，对账只能在 24 小时后 EXPIRED——部署期 fail closed。
    resolverId !== NEW_API_REQUEST_BOUND_RESOLVER_ID ||
    parsed.pricingAuthority !== "openox_model_marketplace" ||
    parsed.pricingCurrency !== "USD" ||
    typeof pricingSnapshotSha256 !== "string" ||
    !SHA256.test(pricingSnapshotSha256) ||
    parsed.ledgerMicrousdPerPricingUnit !== 1_000_000
  ) {
    return undefined;
  }
  const catalogSha256 = createHash("sha256").update(raw).digest("hex");
  const contexts = new Map<string, StoredSiteBuildSettlementContext>();
  for (const value of entries) {
    const entry = record(value);
    if (!entry) return undefined;
    const providerId = entry?.providerId;
    const taskId = entry?.taskId;
    const alias = entry?.alias;
    const protocol = entry?.protocol;
    if (
      providerId !== "gateway" ||
      typeof taskId !== "string" ||
      !BOUNDED_ID.test(taskId) ||
      typeof alias !== "string" ||
      !DURABLE_MODEL_ID.test(alias) ||
      typeof protocol !== "string" ||
      !PROTOCOLS.has(protocol) ||
      protocol !==
        (VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ??
          "openai-chat-completions") ||
      !positiveDurableModelInteger(entry.expectedChannelId) ||
      !positiveDurableModelInteger(entry.maxOutputTokensPerCall) ||
      !positiveDurableModelInteger(entry.gatewayCredentialQuotaCapPoints) ||
      !boundedPrice(entry.inputPriceMicrounitsPerMillionTokens) ||
      !boundedPrice(entry.outputPriceMicrounitsPerMillionTokens)
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
        pricingAuthority: "openox_model_marketplace" as const,
        pricingSnapshotSha256,
        pricingCurrency: "USD" as const,
        providerId,
        taskId,
        resolverId,
        alias,
        protocol: protocol as PaidModelProtocol,
        expectedChannelId: entry.expectedChannelId,
        maxOutputTokensPerCall: entry.maxOutputTokensPerCall,
        gatewayCredentialQuotaCapPoints: entry.gatewayCredentialQuotaCapPoints,
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
      if (!context || input.maxOutputTokens > context.maxOutputTokensPerCall) {
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

export class NewApiSiteBuildCostReconciliationResolver implements SiteBuildCostReconciliationResolver {
  constructor(
    private readonly resolver: RequestBoundResolver,
    private readonly keyring: SettlementDerivationKeyring,
    private readonly authority: ProviderWireAuthority,
  ) {}

  async resolve(
    candidate: SiteBuildReconciliationCandidate,
  ): Promise<SiteBuildReconciliationObservation> {
    if (
      !SHA256.test(candidate.operationKey) ||
      !SHA256.test(candidate.settlementNonceSha256) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(candidate.settlementRequestId) ||
      !BOUNDED_ID.test(candidate.derivationKeyId) ||
      candidate.resolverId !== NEW_API_REQUEST_BOUND_RESOLVER_ID ||
      !DURABLE_MODEL_ID.test(candidate.alias) ||
      !PROTOCOLS.has(candidate.protocol) ||
      !positiveSafeInteger(candidate.physicalWireAttempt) ||
      candidate.physicalWireAttempt > 2 ||
      !positiveDurableModelInteger(candidate.expectedChannelId) ||
      !positiveDurableModelInteger(candidate.actualMaxOutputTokens) ||
      !positiveDurableModelInteger(candidate.maximumQuotaPoints) ||
      !boundedPrice(candidate.inputPriceMicrounitsPerMillionTokens) ||
      !boundedPrice(candidate.outputPriceMicrounitsPerMillionTokens) ||
      candidate.ledgerMicrousdPerPricingUnit !== 1_000_000 ||
      !new Set([
        "ALLOCATED",
        "DISPATCH_STARTED",
        "OBSERVED",
        "UNKNOWN",
        "NOT_DISPATCHED",
      ]).has(candidate.wireState) ||
      typeof candidate.receiptRecorded !== "boolean" ||
      (candidate.wireState === "OBSERVED" && !candidate.receiptRecorded)
    ) {
      return {
        status: "UNRESOLVED",
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        observedAt: new Date(),
        meta: { reason: "trusted_provider_wire_context_unavailable" },
      };
    }
    if (candidate.wireState === "ALLOCATED") {
      return {
        status: "UNRESOLVED",
        resolverId: candidate.resolverId,
        observedAt: new Date(),
        meta: { reason: "provider_wire_not_dispatched" },
      };
    }
    if (candidate.wireState === "NOT_DISPATCHED") {
      try {
        return await this.authority.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: candidate.resolverId,
          observedAt: new Date(),
        });
      } catch {
        return {
          status: "UNRESOLVED",
          resolverId: candidate.resolverId,
          observedAt: new Date(),
          meta: { reason: "database_ack_unknown" },
        };
      }
    }
    if (candidate.receiptRecorded) {
      try {
        if (candidate.wireState === "DISPATCH_STARTED") {
          await this.authority.finalizeModelPhysicalWireFromReceipt({
            workspaceId: candidate.workspaceId,
            wireAttemptId: candidate.wireAttemptId,
          });
        }
        return await this.authority.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: candidate.resolverId,
          observedAt: new Date(),
        });
      } catch {
        return {
          status: "UNRESOLVED",
          resolverId: candidate.resolverId,
          observedAt: new Date(),
          meta: { reason: "database_ack_unknown" },
        };
      }
    }
    const nonce = settlementWireNonce(this.keyring, {
      operationKey: candidate.operationKey,
      physicalWireAttempt: candidate.physicalWireAttempt,
      derivationKeyId: candidate.derivationKeyId,
      nonceSha256: candidate.settlementNonceSha256,
    });
    if (!nonce) {
      return {
        status: "UNRESOLVED",
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        observedAt: new Date(),
        meta: { reason: "settlement_nonce_unavailable" },
      };
    }
    const settlement = await this.resolver.resolve({
      requestId: candidate.settlementRequestId,
      nonce,
      alias: candidate.alias,
      protocol: candidate.protocol,
      expectedChannelId: candidate.expectedChannelId,
      maxOutputTokens: candidate.actualMaxOutputTokens,
      maximumQuotaPoints: candidate.maximumQuotaPoints,
      maximumProbeCount: 2,
      probeAuthority: {
        claim: (sequence) =>
          this.authority.claimModelReadbackProbe({
            workspaceId: candidate.workspaceId,
            wireAttemptId: candidate.wireAttemptId,
            sequence,
          }),
        record: ({ probeId, probe, observedAt }) =>
          this.authority.recordModelReadbackProbe({
            workspaceId: candidate.workspaceId,
            probeId,
            probe,
            observedAt,
          }),
      },
    });
    if (settlement.status === "unknown") {
      const observedAt = new Date();
      const unresolved: SiteBuildReconciliationObservation = {
        status: "UNRESOLVED",
        resolverId: settlement.resolverId,
        observedAt,
        meta: {
          reason: settlement.reason,
          readbackProbes: settlement.readbackProbes,
        },
      };
      try {
        if (candidate.wireState === "DISPATCH_STARTED") {
          const finalPhase =
            settlement.reason === "gateway_log_missing"
              ? "gateway_log_missing"
              : settlement.reason === "gateway_log_unavailable"
                ? "gateway_log_unavailable"
                : "gateway_log_invalid";
          await this.authority.finalizeModelPhysicalWire({
            workspaceId: candidate.workspaceId,
            wireAttemptId: candidate.wireAttemptId,
            observation: {
              status: "unknown",
              physicalWireAttempt: candidate.physicalWireAttempt,
              resolverId: settlement.resolverId,
              reason: settlement.reason,
              transportObservation: createProviderTransportObservation({
                physicalWireAttempt: candidate.physicalWireAttempt,
                finalPhase,
                gatewayIdState: "not_observable",
                upstreamIdState: "unknown",
                payloadState: "unavailable",
                readbackProbes: settlement.readbackProbes,
              }),
            },
            observedAt,
          });
        }
        await this.authority.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: settlement.resolverId,
          observedAt,
        });
        return unresolved;
      } catch {
        return {
          status: "UNRESOLVED",
          resolverId: settlement.resolverId,
          observedAt,
          meta: { reason: "database_ack_unknown" },
        };
      }
    }
    if (settlement.resolverId !== candidate.resolverId) {
      return {
        status: "UNRESOLVED",
        resolverId: candidate.resolverId,
        observedAt: new Date(),
        meta: { reason: "resolver_identity_mismatch" },
      };
    }
    const exactCostMicrousd = pricedCostMicrousd(
      candidate,
      settlement.inputTokens,
      settlement.outputTokens,
    );
    if (exactCostMicrousd === null) {
      return {
        status: "UNRESOLVED",
        resolverId: candidate.resolverId,
        observedAt: new Date(),
        meta: { reason: "trusted_price_mapping_invalid" },
      };
    }
    const observedAt = new Date();
    try {
      await this.authority.recordModelPhysicalWireReceipt({
        workspaceId: candidate.workspaceId,
        wireAttemptId: candidate.wireAttemptId,
        receiptDigest: settlement.receiptDigest,
        observedAt,
        observation: {
          status: "settled",
          physicalWireAttempt: candidate.physicalWireAttempt,
          resolverId: settlement.resolverId,
          alias: settlement.alias,
          protocol: candidate.protocol,
          channelId: settlement.channelId,
          basis: "openox_catalog_token_pricing",
          quota: settlement.quota,
          costMicrousd: Number(exactCostMicrousd),
          inputTokens: settlement.inputTokens,
          outputTokens: settlement.outputTokens,
          upstreamIdState: settlement.upstreamIdState,
          transportObservation: createProviderTransportObservation({
            physicalWireAttempt: candidate.physicalWireAttempt,
            finalPhase: "gateway_request_id_observed",
            gatewayIdState: "not_observable",
            upstreamIdState: settlement.upstreamIdState,
            payloadState: "available",
            readbackProbes: settlement.readbackProbes,
          }),
        },
      });
      if (candidate.wireState === "DISPATCH_STARTED") {
        await this.authority.finalizeModelPhysicalWireFromReceipt({
          workspaceId: candidate.workspaceId,
          wireAttemptId: candidate.wireAttemptId,
        });
      }
      return this.authority.completeProviderSpendReconciliation({
        workspaceId: candidate.workspaceId,
        siteId: candidate.siteId,
        buildRunId: candidate.buildRunId,
        spendId: candidate.spendId,
        resolverId: settlement.resolverId,
        observedAt,
      });
    } catch {
      return {
        status: "UNRESOLVED",
        resolverId: settlement.resolverId,
        observedAt,
        meta: { reason: "database_ack_unknown" },
      };
    }
  }
}

export function createSiteBuildSettlementReadbackRuntimeFromEnv(
  authority: ProviderWireAuthority,
  env: NodeJS.ProcessEnv = process.env,
):
  | {
      keyring: SettlementDerivationKeyring;
      resolver: NewApiRequestBoundSettlementResolver;
      reconciliationResolver: SiteBuildCostReconciliationResolver;
    }
  | undefined {
  const gatewayUrl = env.MODEL_GATEWAY_URL;
  const readerCredential = canonicalGatewayCredential(
    env.MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL,
  );
  const dispatchCredential =
    env.MODEL_GATEWAY_KEY === undefined
      ? undefined
      : canonicalGatewayCredential(env.MODEL_GATEWAY_KEY);
  const keyringPath = env.SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE;
  if (
    !gatewayUrl ||
    !readerCredential ||
    !keyringPath ||
    (env.MODEL_GATEWAY_KEY !== undefined && !dispatchCredential) ||
    (dispatchCredential !== undefined &&
      !gatewayCredentialsAreDistinct(dispatchCredential, readerCredential))
  )
    return undefined;
  try {
    const origin = new URL(gatewayUrl).origin;
    const rawPoll = Number(env.SITE_BUILD_COST_RECONCILIATION_POLL_MS ?? 5_000);
    const maximumProbeDurationMs = Number.isSafeInteger(rawPoll)
      ? Math.max(1, Math.min(30_000, rawPoll))
      : 5_000;
    const keyring = loadSettlementDerivationKeyring(keyringPath);
    const resolver = new NewApiRequestBoundSettlementResolver({
      gatewayOrigin: origin,
      readerCredential,
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      maximumProbeDurationMs,
    });
    return Object.freeze({
      keyring,
      resolver,
      reconciliationResolver: new NewApiSiteBuildCostReconciliationResolver(
        resolver,
        keyring,
        authority,
      ),
    });
  } catch {
    return undefined;
  }
}

export function createSiteBuildCostReconciliationResolverFromEnv(
  authority: ProviderWireAuthority,
  env: NodeJS.ProcessEnv = process.env,
): SiteBuildCostReconciliationResolver | undefined {
  return createSiteBuildSettlementReadbackRuntimeFromEnv(authority, env)
    ?.reconciliationResolver;
}
