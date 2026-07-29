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
  'site-builder-model-settlement-attestation/2026-07-29-v1' as const;
export const SITE_BUILDER_MODEL_SETTLEMENT_EVIDENCE_VERSION =
  'site-builder-paid-model-preflight-evidence/v1' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._/-]{2,127}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_ATTESTATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const PROTOCOL_FRAMING_TOKEN_UPPER_BOUND = 4_096;

export interface SettlementDispatch {
  taskId: SiteBuilderTaskId;
  alias: string;
  protocol: PaidModelProtocol;
  channelId: number;
  quotaType: 0;
  modelRatio: number;
  completionRatio: number;
  groupRatio: number;
  pricingVersion: string;
}

export interface SettlementSnapshot {
  attestationId: string;
  capturedAt: string;
  expiresAt: string;
  gateway: {
    origin: string;
    quotaPerUnit: number;
    pricingSnapshotSha256: string;
    channelSnapshotSha256: string;
  };
  credential: {
    bearerTokenSha256: string;
    purpose: 'site_builder_runtime';
    quotaMode: 'limited';
    quotaCapMicrousd: number;
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
}

export interface PricingRow {
  model_name?: unknown;
  quota_type?: unknown;
  model_ratio?: unknown;
  model_price?: unknown;
  completion_ratio?: unknown;
  pricing_version?: unknown;
  enable_groups?: unknown;
  supported_endpoint_types?: unknown;
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

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
      'credential',
      'dispatches',
      'settlement',
    ]) ||
    !exactKeys(snapshot.gateway, [
      'origin',
      'quotaPerUnit',
      'pricingSnapshotSha256',
      'channelSnapshotSha256',
    ]) ||
    !exactKeys(snapshot.credential, [
      'bearerTokenSha256',
      'purpose',
      'quotaMode',
      'quotaCapMicrousd',
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
    !SHA256.test(snapshot.gateway.pricingSnapshotSha256) ||
    !SHA256.test(snapshot.gateway.channelSnapshotSha256) ||
    !positiveSafeInteger(snapshot.gateway.quotaPerUnit) ||
    !SHA256.test(snapshot.credential.bearerTokenSha256) ||
    snapshot.credential.bearerTokenSha256 !== sha256(apiKey) ||
    snapshot.credential.purpose !== 'site_builder_runtime' ||
    snapshot.credential.quotaMode !== 'limited' ||
    snapshot.credential.scopeExact !== true ||
    !positiveSafeInteger(snapshot.credential.quotaCapMicrousd) ||
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
        'quotaType',
        'modelRatio',
        'completionRatio',
        'groupRatio',
        'pricingVersion',
      ]) ||
      !SITE_BUILDER_TASK_IDS.includes(dispatch.taskId) ||
      typeof dispatch.alias !== 'string' ||
      dispatch.alias.length === 0 ||
      !PAID_MODEL_PROTOCOLS.includes(dispatch.protocol) ||
      !positiveSafeInteger(dispatch.channelId) ||
      dispatch.quotaType !== 0 ||
      !positiveFinite(dispatch.modelRatio) ||
      !positiveFinite(dispatch.completionRatio) ||
      !positiveFinite(dispatch.groupRatio) ||
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

function normalizePricingRow(row: PricingRow) {
  return {
    modelName: row.model_name,
    quotaType: row.quota_type,
    modelRatio: row.model_ratio,
    modelPrice: row.model_price,
    completionRatio: row.completion_ratio,
    pricingVersion: row.pricing_version,
    enableGroups: row.enable_groups,
    supportedEndpointTypes: row.supported_endpoint_types,
  };
}

function pricingSnapshot(
  rows: readonly PricingRow[],
  allowlist: readonly string[],
): string {
  const selected = rows
    .filter(
      (row) =>
        typeof row.model_name === 'string' &&
        allowlist.includes(row.model_name),
    )
    .map(normalizePricingRow)
    .sort((left, right) =>
      String(left.modelName).localeCompare(String(right.modelName)),
    );
  return sha256CanonicalJson(selected);
}

function pointsToMicrousd(points: number, quotaPerUnit: number): number | null {
  if (!nonNegativeSafeInteger(points) || !positiveSafeInteger(quotaPerUnit)) {
    return null;
  }
  const microusd = (points * 1_000_000) / quotaPerUnit;
  return Number.isSafeInteger(microusd) ? microusd : null;
}

export class NewApiSiteBuilderModelSettlement implements PaidModelSettlementController {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
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
    this.gatewayOrigin = canonicalGatewayOrigin(
      this.attestation.snapshot.gateway.origin,
    );
  }

  private async getJson(path: string): Promise<{
    ok: boolean;
    status: number;
    body: unknown;
  }> {
    try {
      const response = await this.fetchImpl(`${this.gatewayOrigin}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
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

  async preflight(
    request: PaidModelPreflightRequest,
    ctx: AiContext,
  ): Promise<PaidModelPreflightEvidence> {
    const snapshot = this.attestation.snapshot;
    const now = this.now();
    if (
      !ctx.paidCost ||
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

    const [model, usage, status, pricing] = await Promise.all([
      this.getJson(`/v1/models/${encodeURIComponent(request.alias)}`),
      this.getJson('/api/usage/token'),
      this.getJson('/api/status'),
      this.getJson('/api/pricing'),
    ]);
    if (!model.ok || !usage.ok || !status.ok || !pricing.ok) {
      throw new PaidModelPreflightError('LIVE_PREFLIGHT_UNAVAILABLE');
    }

    const modelBody = model.body as { id?: unknown };
    const usageBody = ((usage.body as { data?: unknown })?.data ??
      usage.body) as Record<string, unknown>;
    const statusBody = ((status.body as { data?: unknown })?.data ??
      status.body) as Record<string, unknown>;
    const pricingBody = ((pricing.body as { data?: unknown })?.data ??
      pricing.body) as unknown;
    const pricingRows = Array.isArray(pricingBody)
      ? (pricingBody as PricingRow[])
      : [];
    const liveAllowlist =
      usageBody.model_limits &&
      typeof usageBody.model_limits === 'object' &&
      !Array.isArray(usageBody.model_limits)
        ? Object.keys(usageBody.model_limits as Record<string, unknown>).sort()
        : [];
    const totalGranted = usageBody.total_granted;
    const totalAvailable = usageBody.total_available;
    const quotaPerUnit = statusBody.quota_per_unit;
    const capMicrousd =
      typeof totalGranted === 'number' && typeof quotaPerUnit === 'number'
        ? pointsToMicrousd(totalGranted, quotaPerUnit)
        : null;
    const remainingMicrousd =
      typeof totalAvailable === 'number' && typeof quotaPerUnit === 'number'
        ? pointsToMicrousd(totalAvailable, quotaPerUnit)
        : null;
    if (
      modelBody.id !== request.alias ||
      usageBody.unlimited_quota !== false ||
      usageBody.model_limits_enabled !== true ||
      JSON.stringify(liveAllowlist) !==
        JSON.stringify(snapshot.credential.modelAllowlist) ||
      quotaPerUnit !== snapshot.gateway.quotaPerUnit ||
      capMicrousd !== snapshot.credential.quotaCapMicrousd ||
      remainingMicrousd === null ||
      remainingMicrousd < request.reservationMicrousd ||
      pricingSnapshot(pricingRows, snapshot.credential.modelAllowlist) !==
        snapshot.gateway.pricingSnapshotSha256
    ) {
      throw new PaidModelPreflightError('LIVE_SCOPE_OR_QUOTA_MISMATCH');
    }
    const price = pricingRows.find(
      (entry) => entry.model_name === request.alias,
    );
    if (
      !price ||
      price.quota_type !== dispatch.quotaType ||
      price.model_ratio !== dispatch.modelRatio ||
      (price.completion_ratio ?? 1) !== dispatch.completionRatio ||
      price.pricing_version !== dispatch.pricingVersion
    ) {
      throw new PaidModelPreflightError('LIVE_PRICING_MISMATCH');
    }

    const tokensPerCall =
      request.promptUtf8BytesPerCall +
      PROTOCOL_FRAMING_TOKEN_UPPER_BOUND +
      request.maxOutputTokens * dispatch.completionRatio;
    const quotaUpperBound =
      tokensPerCall *
      dispatch.modelRatio *
      dispatch.groupRatio *
      request.maximumWireCalls;
    const pricedMaximumMicrousd = Math.ceil(
      (quotaUpperBound * 1_000_000) / snapshot.gateway.quotaPerUnit,
    );
    if (
      !Number.isSafeInteger(pricedMaximumMicrousd) ||
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
      quotaPerUnit: snapshot.gateway.quotaPerUnit,
      credentialQuotaCapMicrousd: snapshot.credential.quotaCapMicrousd,
      credentialRemainingMicrousd: remainingMicrousd,
      pricedMaximumMicrousd,
    });
  }

  async resolve(input: {
    requestId: string | null;
    evidence: PaidModelPreflightEvidence;
    usage?: { inputTokens?: number; outputTokens?: number };
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

    for (const delay of [0, 50, 150, 400]) {
      if (delay) await this.wait(delay);
      const response = await this.getJson(
        this.attestation.snapshot.settlement.logEndpoint,
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
        !nonNegativeSafeInteger(row.prompt_tokens) ||
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
      const costMicrousd = pointsToMicrousd(
        row.quota,
        input.evidence.quotaPerUnit,
      );
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
        quota: row.quota,
        quotaPerUnit: input.evidence.quotaPerUnit,
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
  rows: readonly PricingRow[],
  allowlist: readonly string[],
): string {
  return pricingSnapshot(rows, allowlist);
}

export function settlementChannelSnapshotSha256(
  dispatches: readonly SettlementDispatch[],
): string {
  return channelSnapshot(dispatches);
}
