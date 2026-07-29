import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GatewaySettlementObservation,
  PAID_MODEL_PROTOCOLS,
  PaidModelPreflightError,
  type PaidModelPreflightEvidence,
  type PaidModelPreflightRequest,
  type PaidModelProtocol,
  type PaidModelSettlementController,
} from '../model-gateway/paid-model-settlement';
import type { AiContext } from '../model-gateway/types';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import {
  resolveTaskRoute,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from './agents/task-routes';

export const SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION =
  'site-builder-model-settlement-attestation/2026-07-29-v2' as const;
export const SITE_BUILDER_MODEL_SETTLEMENT_EVIDENCE_VERSION =
  'site-builder-paid-model-preflight-evidence/v2' as const;
export const OPENOX_PRICING_AUTHORITY = {
  provider: 'openox_model_marketplace',
  origin: 'https://openox.tech',
  catalogEndpoint: '/api/public/pricing-catalog',
} as const;

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._/-]{2,127}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_ATTESTATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const PROTOCOL_FRAMING_TOKEN_UPPER_BOUND = 4_096;
const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 5_000;

export interface SettlementDispatch {
  taskId: SiteBuilderTaskId;
  alias: string;
  protocol: PaidModelProtocol;
  channelId: number;
  upstreamModelId: string;
  upstreamProductLine: string;
  upstreamGroupName: string;
  pricingCurrency: 'USD' | 'CNY';
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  cacheReadPriceMicrounitsPerMillionTokens: number;
  cacheWritePriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
  pricingVersion: string;
}

export interface SettlementSnapshot {
  attestationId: string;
  capturedAt: string;
  expiresAt: string;
  gateway: {
    origin: string;
    channelSnapshotSha256: string;
  };
  pricing: {
    authority: typeof OPENOX_PRICING_AUTHORITY.provider;
    origin: typeof OPENOX_PRICING_AUTHORITY.origin;
    catalogEndpoint: typeof OPENOX_PRICING_AUTHORITY.catalogEndpoint;
    snapshotSha256: string;
    ledgerConversionPolicy: 'openox_1_to_1_balance_credit';
    ledgerMicrousdPerUsd: 1_000_000;
    ledgerMicrousdPerCny: 1_000_000;
  };
  credential: {
    bearerTokenSha256: string;
    purpose: 'site_builder_runtime';
    quotaMode: 'limited';
    quotaCapPoints: number;
    scopeExact: true;
    modelAllowlist: string[];
  };
  dispatches: SettlementDispatch[];
  settlement: {
    resolverId: string;
    requestIdentityHeader: 'x-oneapi-request-id';
    logEndpoint: '/api/log/token';
    unknownSettlementPolicy: 'freeze_campaign';
  };
}

export interface SiteBuilderModelSettlementAttestation {
  schemaVersion: typeof SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION;
  snapshot: SettlementSnapshot;
  snapshotSha256: string;
}

interface RuntimeDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  controlPlaneTimeoutMs?: number;
}

export interface OpenOxPricingRow {
  model_id?: unknown;
  product_line?: unknown;
  input_rate?: unknown;
  output_rate?: unknown;
  cache_read_rate?: unknown;
  cache_write_rate?: unknown;
  group_rates?: unknown;
  status?: unknown;
  updated_at?: unknown;
}

export interface OpenOxPricingGroup {
  name?: unknown;
  product_line?: unknown;
  rate_multiplier?: unknown;
}

export interface OpenOxPricingCatalog {
  success?: unknown;
  data?: {
    models?: unknown;
    groups?: unknown;
  };
}

interface LogRow {
  request_id?: unknown;
  type?: unknown;
  quota?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  model_name?: unknown;
  channel?: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite canonical number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new Error('unsupported canonical JSON value');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256CanonicalJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalGatewayOrigin(value: string): string {
  const parsed = new URL(value);
  const loopbackHttp =
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('gateway origin must be HTTPS or explicit loopback HTTP');
  }
  return parsed.origin;
}

function protocolFor(alias: string): PaidModelProtocol {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? 'openai-chat-completions';
}

function dispatchKey(dispatch: {
  taskId: string;
  alias: string;
  protocol: PaidModelProtocol;
}): string {
  return `${dispatch.taskId}:${dispatch.alias}:${dispatch.protocol}`;
}

function requiredDispatches(
  env: NodeJS.ProcessEnv,
): Array<Pick<SettlementDispatch, 'taskId' | 'alias' | 'protocol'>> {
  return SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
    const route = resolveTaskRoute(taskId, env);
    return [route.primary, ...route.fallbacks].map((alias) => ({
      taskId,
      alias,
      protocol: protocolFor(alias),
    }));
  });
}

function modelAllowlist(dispatches: readonly { alias: string }[]): string[] {
  return [...new Set(dispatches.map((entry) => entry.alias))].sort();
}

function assertAttestation(
  input: unknown,
  env: NodeJS.ProcessEnv,
  gatewayUrl: string,
  apiKey: string,
  now: Date,
): SiteBuilderModelSettlementAttestation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('model settlement attestation must be an object');
  }
  const envelope = input as SiteBuilderModelSettlementAttestation;
  const snapshot = envelope.snapshot;
  if (
    !exactKeys(envelope, ['schemaVersion', 'snapshot', 'snapshotSha256']) ||
    envelope.schemaVersion !==
      SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    !exactKeys(snapshot, [
      'attestationId',
      'capturedAt',
      'expiresAt',
      'gateway',
      'pricing',
      'credential',
      'dispatches',
      'settlement',
    ]) ||
    !exactKeys(snapshot.gateway, ['origin', 'channelSnapshotSha256']) ||
    !exactKeys(snapshot.pricing, [
      'authority',
      'origin',
      'catalogEndpoint',
      'snapshotSha256',
      'ledgerConversionPolicy',
      'ledgerMicrousdPerUsd',
      'ledgerMicrousdPerCny',
    ]) ||
    !exactKeys(snapshot.credential, [
      'bearerTokenSha256',
      'purpose',
      'quotaMode',
      'quotaCapPoints',
      'scopeExact',
      'modelAllowlist',
    ]) ||
    !exactKeys(snapshot.settlement, [
      'resolverId',
      'requestIdentityHeader',
      'logEndpoint',
      'unknownSettlementPolicy',
    ]) ||
    !IDENTIFIER.test(snapshot.attestationId) ||
    !canonicalInstant(snapshot.capturedAt) ||
    !canonicalInstant(snapshot.expiresAt) ||
    !SHA256.test(envelope.snapshotSha256) ||
    envelope.snapshotSha256 !== sha256CanonicalJson(snapshot) ||
    !SHA256.test(snapshot.gateway.channelSnapshotSha256) ||
    snapshot.pricing.authority !== OPENOX_PRICING_AUTHORITY.provider ||
    snapshot.pricing.origin !== OPENOX_PRICING_AUTHORITY.origin ||
    snapshot.pricing.catalogEndpoint !==
      OPENOX_PRICING_AUTHORITY.catalogEndpoint ||
    !SHA256.test(snapshot.pricing.snapshotSha256) ||
    snapshot.pricing.ledgerConversionPolicy !==
      'openox_1_to_1_balance_credit' ||
    snapshot.pricing.ledgerMicrousdPerUsd !== 1_000_000 ||
    snapshot.pricing.ledgerMicrousdPerCny !== 1_000_000 ||
    !SHA256.test(snapshot.credential.bearerTokenSha256) ||
    snapshot.credential.bearerTokenSha256 !== sha256(apiKey) ||
    snapshot.credential.purpose !== 'site_builder_runtime' ||
    snapshot.credential.quotaMode !== 'limited' ||
    snapshot.credential.scopeExact !== true ||
    !positiveSafeInteger(snapshot.credential.quotaCapPoints) ||
    snapshot.settlement.requestIdentityHeader !== 'x-oneapi-request-id' ||
    snapshot.settlement.logEndpoint !== '/api/log/token' ||
    snapshot.settlement.unknownSettlementPolicy !== 'freeze_campaign' ||
    !IDENTIFIER.test(snapshot.settlement.resolverId)
  ) {
    throw new Error('model settlement attestation is invalid');
  }

  const capturedAt = Date.parse(snapshot.capturedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    capturedAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    expiresAt - capturedAt > MAX_ATTESTATION_LIFETIME_MS
  ) {
    throw new Error('model settlement attestation is stale or future-dated');
  }
  if (
    canonicalGatewayOrigin(gatewayUrl) !==
    canonicalGatewayOrigin(snapshot.gateway.origin)
  ) {
    throw new Error('model settlement gateway origin mismatch');
  }

  const expected = requiredDispatches(env).map(dispatchKey).sort();
  const actual = snapshot.dispatches.map(dispatchKey).sort();
  if (
    expected.length !== actual.length ||
    new Set(actual).size !== actual.length ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  ) {
    throw new Error('model settlement dispatch scope is not exact');
  }
  const expectedModels = modelAllowlist(snapshot.dispatches);
  if (
    JSON.stringify(snapshot.credential.modelAllowlist) !==
    JSON.stringify(expectedModels)
  ) {
    throw new Error('model settlement credential allowlist is not exact');
  }

  for (const dispatch of snapshot.dispatches) {
    if (
      !exactKeys(dispatch, [
        'taskId',
        'alias',
        'protocol',
        'channelId',
        'upstreamModelId',
        'upstreamProductLine',
        'upstreamGroupName',
        'pricingCurrency',
        'inputPriceMicrounitsPerMillionTokens',
        'outputPriceMicrounitsPerMillionTokens',
        'cacheReadPriceMicrounitsPerMillionTokens',
        'cacheWritePriceMicrounitsPerMillionTokens',
        'ledgerMicrousdPerPricingUnit',
        'pricingVersion',
      ]) ||
      !SITE_BUILDER_TASK_IDS.includes(dispatch.taskId) ||
      typeof dispatch.alias !== 'string' ||
      dispatch.alias.length === 0 ||
      !PAID_MODEL_PROTOCOLS.includes(dispatch.protocol) ||
      !positiveSafeInteger(dispatch.channelId) ||
      dispatch.upstreamModelId !== dispatch.alias ||
      !IDENTIFIER.test(dispatch.upstreamProductLine) ||
      !IDENTIFIER.test(dispatch.upstreamGroupName) ||
      !['USD', 'CNY'].includes(dispatch.pricingCurrency) ||
      !nonNegativeSafeInteger(dispatch.inputPriceMicrounitsPerMillionTokens) ||
      !nonNegativeSafeInteger(dispatch.outputPriceMicrounitsPerMillionTokens) ||
      !nonNegativeSafeInteger(
        dispatch.cacheReadPriceMicrounitsPerMillionTokens,
      ) ||
      !nonNegativeSafeInteger(
        dispatch.cacheWritePriceMicrounitsPerMillionTokens,
      ) ||
      !positiveSafeInteger(dispatch.ledgerMicrousdPerPricingUnit) ||
      dispatch.ledgerMicrousdPerPricingUnit !==
        (dispatch.pricingCurrency === 'USD'
          ? snapshot.pricing.ledgerMicrousdPerUsd
          : snapshot.pricing.ledgerMicrousdPerCny) ||
      !SHA256.test(dispatch.pricingVersion)
    ) {
      throw new Error('model settlement dispatch entry is invalid');
    }
  }
  if (
    snapshot.gateway.channelSnapshotSha256 !==
    channelSnapshot(snapshot.dispatches)
  ) {
    throw new Error('model settlement channel snapshot digest mismatch');
  }
  return structuredClone(envelope);
}

function channelSnapshot(dispatches: readonly SettlementDispatch[]): string {
  return sha256CanonicalJson(
    dispatches
      .map(({ taskId, alias, protocol, channelId }) => ({
        taskId,
        alias,
        protocol,
        channelId,
      }))
      .sort((left, right) =>
        dispatchKey(left).localeCompare(dispatchKey(right)),
      ),
  );
}

function decimalMicrounits(value: unknown): number | null {
  const raw =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(result) ? result : null;
}

function multiplyMicrounits(
  rateMicrounits: number,
  multiplierMicrounits: number,
): number | null {
  const result = Math.round(
    (rateMicrounits * multiplierMicrounits) / 1_000_000,
  );
  return Number.isSafeInteger(result) ? result : null;
}

function catalogRows(catalog: OpenOxPricingCatalog): {
  models: OpenOxPricingRow[];
  groups: OpenOxPricingGroup[];
} | null {
  const models = catalog.data?.models;
  const groups = catalog.data?.groups;
  if (
    catalog.success !== true ||
    !Array.isArray(models) ||
    !Array.isArray(groups)
  ) {
    return null;
  }
  return {
    models: models as OpenOxPricingRow[],
    groups: groups as OpenOxPricingGroup[],
  };
}

function pricingCurrency(productLine: string): 'USD' | 'CNY' | null {
  if (productLine === 'claude' || productLine === 'kimi') return 'USD';
  if (
    [
      'gpt',
      'deepseek',
      'glm',
      'grok',
      'gemini',
      'minimax',
      'doubao',
    ].includes(productLine)
  ) {
    return 'CNY';
  }
  return null;
}

function deriveOpenOxPrice(
  catalog: OpenOxPricingCatalog,
  modelId: string,
  groupName: string,
) {
  const rows = catalogRows(catalog);
  if (!rows) return null;
  const model = rows.models.find((entry) => entry.model_id === modelId);
  if (
    !model ||
    model.status !== 'enabled' ||
    typeof model.product_line !== 'string'
  ) {
    return null;
  }
  const group = rows.groups.find(
    (entry) =>
      entry.name === groupName && entry.product_line === model.product_line,
  );
  const currency = pricingCurrency(model.product_line);
  if (!group || !currency) return null;

  const modelMultiplier =
    modelId === 'glm-5.2' &&
    model.group_rates &&
    typeof model.group_rates === 'object' &&
    !Array.isArray(model.group_rates)
      ? (model.group_rates as Record<string, unknown>).billing_multiplier
      : undefined;
  const multiplierMicrounits = decimalMicrounits(
    modelMultiplier ?? group.rate_multiplier,
  );
  const input = decimalMicrounits(model.input_rate);
  const output = decimalMicrounits(model.output_rate);
  const cacheRead = decimalMicrounits(model.cache_read_rate ?? 0);
  const cacheWrite = decimalMicrounits(model.cache_write_rate ?? 0);
  if (
    multiplierMicrounits === null ||
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null
  ) {
    return null;
  }
  const effective = {
    input: multiplyMicrounits(input, multiplierMicrounits),
    output: multiplyMicrounits(output, multiplierMicrounits),
    cacheRead: multiplyMicrounits(cacheRead, multiplierMicrounits),
    cacheWrite: multiplyMicrounits(cacheWrite, multiplierMicrounits),
  };
  if (Object.values(effective).some((value) => value === null)) return null;

  const source = {
    modelId,
    productLine: model.product_line,
    groupName,
    groupMultiplier: group.rate_multiplier,
    modelBillingMultiplier: modelMultiplier ?? null,
    currency,
    inputRate: model.input_rate,
    outputRate: model.output_rate,
    cacheReadRate: model.cache_read_rate ?? '0',
    cacheWriteRate: model.cache_write_rate ?? '0',
    status: model.status,
    updatedAt: model.updated_at,
  };
  return {
    source,
    pricingVersion: sha256CanonicalJson(source),
    productLine: model.product_line,
    currency,
    inputPriceMicrounitsPerMillionTokens: effective.input!,
    outputPriceMicrounitsPerMillionTokens: effective.output!,
    cacheReadPriceMicrounitsPerMillionTokens: effective.cacheRead!,
    cacheWritePriceMicrounitsPerMillionTokens: effective.cacheWrite!,
  };
}

function pricingSnapshot(
  catalog: OpenOxPricingCatalog,
  dispatches: readonly SettlementDispatch[],
): string {
  const selected = dispatches
    .map((dispatch) => ({
      taskId: dispatch.taskId,
      alias: dispatch.alias,
      protocol: dispatch.protocol,
      price: deriveOpenOxPrice(
        catalog,
        dispatch.upstreamModelId,
        dispatch.upstreamGroupName,
      )?.source,
    }))
    .sort((left, right) => dispatchKey(left).localeCompare(dispatchKey(right)));
  return sha256CanonicalJson(selected);
}

function openOxPricedCostMicrousd(input: {
  inputTokens: number;
  outputTokens: number;
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
}): number | null {
  const nativePriceNumerator =
    input.inputTokens * input.inputPriceMicrounitsPerMillionTokens +
    input.outputTokens * input.outputPriceMicrounitsPerMillionTokens;
  const cost = Math.ceil(
    (nativePriceNumerator * input.ledgerMicrousdPerPricingUnit) /
      1_000_000_000_000,
  );
  return Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
}

export class NewApiSiteBuilderModelSettlement implements PaidModelSettlementController {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly controlPlaneTimeoutMs: number;
  private readonly gatewayOrigin: string;

  constructor(
    private readonly attestation: SiteBuilderModelSettlementAttestation,
    private readonly apiKey: string,
    deps: RuntimeDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.wait =
      deps.wait ??
      ((milliseconds) =>
        new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    this.controlPlaneTimeoutMs =
      Number.isSafeInteger(deps.controlPlaneTimeoutMs) &&
      (deps.controlPlaneTimeoutMs ?? 0) > 0
        ? deps.controlPlaneTimeoutMs!
        : DEFAULT_CONTROL_PLANE_TIMEOUT_MS;
    this.gatewayOrigin = canonicalGatewayOrigin(
      this.attestation.snapshot.gateway.origin,
    );
  }

  private controlPlaneSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.controlPlaneTimeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  }

  private async getJson(
    path: string,
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    body: unknown;
  }> {
    try {
      const response = await this.fetchImpl(`${this.gatewayOrigin}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
      };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  private async getOpenOxCatalog(signal: AbortSignal): Promise<{
    ok: boolean;
    status: number;
    body: unknown;
  }> {
    try {
      const response = await this.fetchImpl(
        `${OPENOX_PRICING_AUTHORITY.origin}${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`,
        { signal },
      );
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
      };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  async preflight(
    request: PaidModelPreflightRequest,
    ctx: AiContext,
  ): Promise<PaidModelPreflightEvidence> {
    const snapshot = this.attestation.snapshot;
    const now = this.now();
    const signal = this.controlPlaneSignal(request.signal);
    if (
      !ctx.paidCost ||
      request.signal?.aborted ||
      request.op !== 'generateStructured' ||
      request.providerId !== 'gateway' ||
      canonicalGatewayOrigin(request.gatewayOrigin) !== this.gatewayOrigin ||
      request.credentialSha256 !== snapshot.credential.bearerTokenSha256 ||
      !positiveSafeInteger(request.promptUtf8BytesPerCall) ||
      !positiveSafeInteger(request.maxOutputTokens) ||
      request.maximumWireCalls !== 2 ||
      !positiveSafeInteger(request.reservationMicrousd) ||
      Date.parse(snapshot.expiresAt) <= now.getTime()
    ) {
      throw new PaidModelPreflightError('REQUEST_OUTSIDE_ATTESTATION');
    }
    const dispatch = snapshot.dispatches.find(
      (entry) =>
        entry.taskId === request.taskId &&
        entry.alias === request.alias &&
        entry.protocol === request.protocol,
    );
    if (!dispatch) {
      throw new PaidModelPreflightError('DISPATCH_NOT_ATTESTED');
    }

    const [model, usage, pricing] = await Promise.all([
      this.getJson(`/v1/models/${encodeURIComponent(request.alias)}`, signal),
      this.getJson('/api/usage/token', signal),
      this.getOpenOxCatalog(signal),
    ]);
    if (request.signal?.aborted) {
      throw new PaidModelPreflightError('REQUEST_CANCELLED');
    }
    if (signal.aborted) {
      throw new PaidModelPreflightError('LIVE_PREFLIGHT_UNAVAILABLE');
    }
    if (Date.parse(snapshot.expiresAt) <= this.now().getTime()) {
      throw new PaidModelPreflightError('ATTESTATION_EXPIRED_DURING_PREFLIGHT');
    }
    if (!model.ok || !usage.ok || !pricing.ok) {
      throw new PaidModelPreflightError('LIVE_PREFLIGHT_UNAVAILABLE');
    }

    const modelBody = model.body as { id?: unknown };
    const usageBody = ((usage.body as { data?: unknown })?.data ??
      usage.body) as Record<string, unknown>;
    const pricingCatalog = pricing.body as OpenOxPricingCatalog;
    const liveAllowlist =
      usageBody.model_limits &&
      typeof usageBody.model_limits === 'object' &&
      !Array.isArray(usageBody.model_limits)
        ? Object.keys(usageBody.model_limits as Record<string, unknown>).sort()
        : [];
    const totalGranted = usageBody.total_granted;
    const totalAvailable = usageBody.total_available;
    if (
      modelBody.id !== request.alias ||
      usageBody.unlimited_quota !== false ||
      usageBody.model_limits_enabled !== true ||
      JSON.stringify(liveAllowlist) !==
        JSON.stringify(snapshot.credential.modelAllowlist) ||
      totalGranted !== snapshot.credential.quotaCapPoints ||
      !positiveSafeInteger(totalAvailable) ||
      (totalAvailable as number) > snapshot.credential.quotaCapPoints ||
      pricingSnapshot(pricingCatalog, snapshot.dispatches) !==
        snapshot.pricing.snapshotSha256
    ) {
      throw new PaidModelPreflightError('LIVE_SCOPE_OR_QUOTA_MISMATCH');
    }
    if (
      snapshot.dispatches.some(
        (entry) =>
          !deriveOpenOxPrice(
            pricingCatalog,
            entry.upstreamModelId,
            entry.upstreamGroupName,
          ),
      )
    ) {
      throw new PaidModelPreflightError('LIVE_PRICING_COVERAGE_INCOMPLETE');
    }
    const price = deriveOpenOxPrice(
      pricingCatalog,
      dispatch.upstreamModelId,
      dispatch.upstreamGroupName,
    );
    if (
      !price ||
      price.productLine !== dispatch.upstreamProductLine ||
      price.currency !== dispatch.pricingCurrency ||
      price.inputPriceMicrounitsPerMillionTokens !==
        dispatch.inputPriceMicrounitsPerMillionTokens ||
      price.outputPriceMicrounitsPerMillionTokens !==
        dispatch.outputPriceMicrounitsPerMillionTokens ||
      price.cacheReadPriceMicrounitsPerMillionTokens !==
        dispatch.cacheReadPriceMicrounitsPerMillionTokens ||
      price.cacheWritePriceMicrounitsPerMillionTokens !==
        dispatch.cacheWritePriceMicrounitsPerMillionTokens ||
      price.pricingVersion !== dispatch.pricingVersion
    ) {
      throw new PaidModelPreflightError('LIVE_PRICING_MISMATCH');
    }

    const pricedMaximumMicrousd = openOxPricedCostMicrousd({
      inputTokens:
        (request.promptUtf8BytesPerCall + PROTOCOL_FRAMING_TOKEN_UPPER_BOUND) *
        request.maximumWireCalls,
      outputTokens: request.maxOutputTokens * request.maximumWireCalls,
      inputPriceMicrounitsPerMillionTokens:
        dispatch.inputPriceMicrounitsPerMillionTokens,
      outputPriceMicrounitsPerMillionTokens:
        dispatch.outputPriceMicrounitsPerMillionTokens,
      ledgerMicrousdPerPricingUnit: dispatch.ledgerMicrousdPerPricingUnit,
    });
    if (
      pricedMaximumMicrousd === null ||
      pricedMaximumMicrousd > request.reservationMicrousd
    ) {
      throw new PaidModelPreflightError('PRICED_MAXIMUM_EXCEEDS_RESERVATION');
    }

    return Object.freeze({
      schemaVersion: SITE_BUILDER_MODEL_SETTLEMENT_EVIDENCE_VERSION,
      attestationId: snapshot.attestationId,
      snapshotSha256: this.attestation.snapshotSha256,
      resolverId: snapshot.settlement.resolverId,
      taskId: request.taskId,
      alias: request.alias,
      protocol: request.protocol,
      expectedChannelId: dispatch.channelId,
      pricingAuthority: snapshot.pricing.authority,
      pricingSourceUrl: `${snapshot.pricing.origin}${snapshot.pricing.catalogEndpoint}`,
      pricingSnapshotSha256: snapshot.pricing.snapshotSha256,
      pricingCurrency: dispatch.pricingCurrency,
      inputPriceMicrounitsPerMillionTokens:
        dispatch.inputPriceMicrounitsPerMillionTokens,
      outputPriceMicrounitsPerMillionTokens:
        dispatch.outputPriceMicrounitsPerMillionTokens,
      ledgerMicrousdPerPricingUnit: dispatch.ledgerMicrousdPerPricingUnit,
      gatewayCredentialQuotaCapPoints: snapshot.credential.quotaCapPoints,
      gatewayCredentialRemainingPoints: totalAvailable as number,
      pricedMaximumMicrousd,
    });
  }

  async resolve(input: {
    requestId: string | null;
    evidence: PaidModelPreflightEvidence;
    usage?: { inputTokens?: number; outputTokens?: number };
    signal?: AbortSignal;
  }): Promise<GatewaySettlementObservation> {
    const resolverId = this.attestation.snapshot.settlement.resolverId;
    if (!input.requestId || !REQUEST_ID.test(input.requestId)) {
      return {
        status: 'unknown',
        requestId: input.requestId,
        resolverId,
        reason: 'request_id_missing',
      };
    }

    const signal = this.controlPlaneSignal(input.signal);
    for (const delay of [0, 50, 150, 400]) {
      if (signal.aborted) break;
      if (delay) {
        await this.wait(delay);
        if (signal.aborted) break;
      }
      const response = await this.getJson(
        this.attestation.snapshot.settlement.logEndpoint,
        signal,
      );
      if (!response.ok) continue;
      const rows = ((response.body as { data?: unknown })?.data ??
        []) as unknown;
      if (!Array.isArray(rows)) continue;
      const matching = (rows as LogRow[]).filter(
        (row) => row.request_id === input.requestId,
      );
      if (matching.length === 0) continue;
      if (matching.length !== 1 || matching[0]!.type !== 2) {
        return {
          status: 'unknown',
          requestId: input.requestId,
          resolverId,
          reason: 'log_ambiguous',
        };
      }
      const row = matching[0]!;
      if (row.model_name !== input.evidence.alias) {
        return {
          status: 'unknown',
          requestId: input.requestId,
          resolverId,
          reason: 'model_mismatch',
        };
      }
      if (row.channel !== input.evidence.expectedChannelId) {
        return {
          status: 'unknown',
          requestId: input.requestId,
          resolverId,
          reason: 'channel_mismatch',
        };
      }
      if (
        !nonNegativeSafeInteger(row.quota) ||
        !positiveSafeInteger(row.prompt_tokens) ||
        !nonNegativeSafeInteger(row.completion_tokens) ||
        (input.usage?.inputTokens !== undefined &&
          input.usage.inputTokens !== row.prompt_tokens) ||
        (input.usage?.outputTokens !== undefined &&
          input.usage.outputTokens !== row.completion_tokens)
      ) {
        return {
          status: 'unknown',
          requestId: input.requestId,
          resolverId,
          reason: 'log_invalid',
        };
      }
      const costMicrousd = openOxPricedCostMicrousd({
        inputTokens: row.prompt_tokens,
        outputTokens: row.completion_tokens,
        inputPriceMicrounitsPerMillionTokens:
          input.evidence.inputPriceMicrounitsPerMillionTokens,
        outputPriceMicrounitsPerMillionTokens:
          input.evidence.outputPriceMicrounitsPerMillionTokens,
        ledgerMicrousdPerPricingUnit:
          input.evidence.ledgerMicrousdPerPricingUnit,
      });
      if (costMicrousd === null) {
        return {
          status: 'unknown',
          requestId: input.requestId,
          resolverId,
          reason: 'log_invalid',
        };
      }
      return {
        status: 'settled',
        requestId: input.requestId,
        resolverId,
        alias: input.evidence.alias,
        protocol: input.evidence.protocol,
        channelId: row.channel,
        basis: 'openox_catalog_token_pricing',
        quota: row.quota,
        costMicrousd,
        inputTokens: row.prompt_tokens,
        outputTokens: row.completion_tokens,
      };
    }
    return {
      status: 'unknown',
      requestId: input.requestId,
      resolverId,
      reason: 'log_unavailable',
    };
  }
}

export function loadSiteBuilderModelSettlement(
  env: NodeJS.ProcessEnv = process.env,
  deps: RuntimeDeps = {},
): PaidModelSettlementController | undefined {
  const attestationPath =
    env.SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH?.trim();
  if (!attestationPath) return undefined;
  const expectedFileSha256 =
    env.SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256?.trim();
  if (!expectedFileSha256 || !SHA256.test(expectedFileSha256)) {
    throw new Error(
      'SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256 is required',
    );
  }
  const gatewayUrl = env.MODEL_GATEWAY_URL?.trim();
  const apiKey = env.MODEL_GATEWAY_KEY?.trim();
  if (!gatewayUrl || !apiKey) {
    throw new Error('model gateway credential is required for settlement');
  }
  const bytes = readFileSync(resolve(attestationPath));
  if (sha256(bytes) !== expectedFileSha256) {
    throw new Error('model settlement attestation file digest mismatch');
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  const attestation = assertAttestation(
    parsed,
    env,
    gatewayUrl,
    apiKey,
    deps.now?.() ?? new Date(),
  );
  return new NewApiSiteBuilderModelSettlement(attestation, apiKey, deps);
}

export function settlementAttestationSnapshotSha256(
  snapshot: SettlementSnapshot,
): string {
  return sha256CanonicalJson(snapshot);
}

export function settlementPricingSnapshotSha256(
  catalog: OpenOxPricingCatalog,
  dispatches: readonly SettlementDispatch[],
): string {
  return pricingSnapshot(catalog, dispatches);
}

export function settlementOpenOxPrice(
  catalog: OpenOxPricingCatalog,
  modelId: string,
  groupName: string,
): ReturnType<typeof deriveOpenOxPrice> {
  return deriveOpenOxPrice(catalog, modelId, groupName);
}

export function settlementChannelSnapshotSha256(
  dispatches: readonly SettlementDispatch[],
): string {
  return channelSnapshot(dispatches);
}
