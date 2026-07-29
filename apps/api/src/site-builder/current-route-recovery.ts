import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PaidModelProtocol } from '../model-gateway/paid-model-settlement';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import {
  resolveTaskRoute,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from './agents/task-routes';
import { OPENOX_PRICING_AUTHORITY } from './site-builder-model-settlement';

export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION =
  'site-builder-current-route-recovery-safe-snapshot/2026-07-29-v1' as const;
export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION =
  'site-builder-current-route-recovery-report/2026-07-29-v1' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const PROHIBITED_KEYS = new Set([
  'authorization',
  'apikey',
  'baseurl',
  'bearertoken',
  'key',
  'prompt',
  'responsebody',
  'secret',
  'token',
]);

type ChannelStatus = 'enabled' | 'disabled';

export interface CurrentRouteRecoveryChannelSnapshot {
  alias: string;
  channelId: number;
  status: ChannelStatus;
  priority: number;
  weight: number;
}

export interface CurrentRouteRecoveryPricingModelSnapshot {
  alias: string;
  productLine: string;
  selectedGroup: string;
  currency: 'USD' | 'CNY';
  pricingUnit: 'native_currency_per_million_tokens';
  groupMultiplier: string;
  inputRate: string;
  outputRate: string;
  cacheReadRate: string;
  cacheWriteRate: string;
  effectiveInputRate: string;
  effectiveOutputRate: string;
  effectiveCacheReadRate: string;
  effectiveCacheWriteRate: string;
  status: 'enabled';
  updatedAt: string;
  modelBillingMultiplier: string | null;
}

export interface CurrentRouteRecoverySafeSnapshot {
  schemaVersion: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION;
  capturedAt: string;
  routeBaselineCommitSha: string;
  gateway: {
    source: 'local_new_api_read_only_sqlite';
    channels: CurrentRouteRecoveryChannelSnapshot[];
  };
  credential: {
    observedAt: string;
    httpStatus: 200;
    unlimitedQuota: boolean;
    modelLimitsEnabled: boolean;
    modelAllowlist: string[];
    visibleModelCount: number;
  };
  pricing: {
    authority: typeof OPENOX_PRICING_AUTHORITY.provider;
    catalogEndpoint: 'https://openox.tech/api/public/pricing-catalog';
    capturedAt: string;
    httpStatus: 200;
    responseSha256: string;
    modelRows: number;
    groupRows: number;
    runtimeFetch: 'http_200';
    models: CurrentRouteRecoveryPricingModelSnapshot[];
  };
}

export type CurrentRouteRecoveryBlocker =
  | 'CREDENTIAL_NOT_FINITE_EXACT'
  | 'ENABLED_CHANNEL_AMBIGUOUS'
  | 'ENABLED_CHANNEL_MISSING'
  | 'OPENOX_PRICE_MISSING'
  | 'RUNTIME_PRICING_EGRESS_UNPROVEN';

export interface CurrentRouteRecoveryReport {
  schemaVersion: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION;
  status:
    | 'BLOCKED_CURRENT_ROUTE_RECOVERY'
    | 'READY_FOR_RUNTIME_ATTESTATION_DECISION';
  modelDispatchAuthorization: 'NOT_AUTHORIZED';
  modelGenerationCalls: 0;
  modelFeesUsd: 0;
  source: {
    capturedAt: string;
    routeBaselineCommitSha: string;
    safeSnapshotSha256: string;
    openOxCatalogResponseSha256: string;
  };
  credential: {
    status: 'finite_exact' | 'not_finite_exact';
    requiredModelAllowlist: string[];
    observedModelAllowlist: string[];
  };
  dispatches: Array<{
    taskId: SiteBuilderTaskId;
    alias: string;
    protocol: PaidModelProtocol;
  }>;
  aliases: Array<{
    alias: string;
    protocol: PaidModelProtocol;
    taskIds: SiteBuilderTaskId[];
    enabledChannelIds: number[];
    disabledChannelIds: number[];
    channelSelection: 'missing' | 'unique' | 'ambiguous';
    openOxPricing: CurrentRouteRecoveryPricingModelSnapshot | null;
    blockers: CurrentRouteRecoveryBlocker[];
  }>;
  blockers: CurrentRouteRecoveryBlocker[];
  blockedTaskIds: SiteBuilderTaskId[];
  requiredActions: Array<
    | 'CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE'
    | 'PIN_ONE_REVIEWED_CHANNEL'
    | 'PROVE_REVIEWED_RUNTIME_PRICING_EGRESS'
    | 'REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE'
    | 'RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE'
  >;
  boundaries: {
    changesTaskRoutes: false;
    createsRuntimeAttestation: false;
    installsRuntimeAttestation: false;
    mutatesGateway: false;
    dispatchesModels: false;
  };
}

function exactKeys(value: object, expected: readonly string[], role: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${role} contains undeclared or missing fields`);
  }
}

function object(value: unknown, role: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${role} must be an object`);
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown, role: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    throw new Error(`${role} must be an ISO UTC timestamp`);
  }
}

function nonNegativeInteger(value: unknown, role: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${role} must be a non-negative safe integer`);
  }
}

function assertNoSecretAdjacentKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretAdjacentKeys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (PROHIBITED_KEYS.has(key.toLowerCase())) {
      throw new Error(`safe snapshot contains prohibited field ${key}`);
    }
    assertNoSecretAdjacentKeys(nested);
  }
}

function protocolFor(alias: string): PaidModelProtocol {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? 'openai-chat-completions';
}

function canonicalDispatches(): CurrentRouteRecoveryReport['dispatches'] {
  return SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
    const route = resolveTaskRoute(taskId, {});
    return [route.primary, ...route.fallbacks].map((alias) => ({
      taskId,
      alias,
      protocol: protocolFor(alias),
    }));
  });
}

export function currentRouteRecoveryRequiredAliases(): string[] {
  return [...new Set(canonicalDispatches().map(({ alias }) => alias))].sort();
}

function assertAliasList(value: unknown, role: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((alias) => typeof alias !== 'string' || !ALIAS.test(alias)) ||
    new Set(value).size !== value.length ||
    JSON.stringify([...value].sort()) !== JSON.stringify(value)
  ) {
    throw new Error(`${role} must be a sorted unique alias list`);
  }
}

function assertSnapshot(input: unknown): CurrentRouteRecoverySafeSnapshot {
  assertNoSecretAdjacentKeys(input);
  const snapshot = object(input, 'safe snapshot');
  exactKeys(
    snapshot,
    [
      'schemaVersion',
      'capturedAt',
      'routeBaselineCommitSha',
      'gateway',
      'credential',
      'pricing',
    ],
    'safe snapshot',
  );
  if (
    snapshot.schemaVersion !==
    SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION
  ) {
    throw new Error('unsupported safe snapshot schemaVersion');
  }
  iso(snapshot.capturedAt, 'capturedAt');
  if (
    typeof snapshot.routeBaselineCommitSha !== 'string' ||
    !COMMIT_SHA.test(snapshot.routeBaselineCommitSha)
  ) {
    throw new Error('routeBaselineCommitSha must be a 40-character commit SHA');
  }

  const gateway = object(snapshot.gateway, 'gateway');
  exactKeys(gateway, ['source', 'channels'], 'gateway');
  if (gateway.source !== 'local_new_api_read_only_sqlite') {
    throw new Error('gateway source must be read-only local new-api');
  }
  if (!Array.isArray(gateway.channels)) {
    throw new Error('gateway channels must be an array');
  }
  const requiredAliases = new Set(currentRouteRecoveryRequiredAliases());
  const channelKeys = new Set<string>();
  for (const raw of gateway.channels) {
    const channel = object(raw, 'channel');
    exactKeys(
      channel,
      ['alias', 'channelId', 'status', 'priority', 'weight'],
      'channel',
    );
    if (typeof channel.alias !== 'string' || !ALIAS.test(channel.alias)) {
      throw new Error('channel alias is invalid');
    }
    if (!requiredAliases.has(channel.alias)) {
      throw new Error('channel alias is outside the frozen current route');
    }
    nonNegativeInteger(channel.channelId, 'channelId');
    nonNegativeInteger(channel.priority, 'priority');
    nonNegativeInteger(channel.weight, 'weight');
    if (channel.status !== 'enabled' && channel.status !== 'disabled') {
      throw new Error('channel status is invalid');
    }
    const key = `${channel.alias}:${channel.channelId}`;
    if (channelKeys.has(key)) throw new Error('duplicate alias/channel pair');
    channelKeys.add(key);
  }

  const credential = object(snapshot.credential, 'credential');
  exactKeys(
    credential,
    [
      'observedAt',
      'httpStatus',
      'unlimitedQuota',
      'modelLimitsEnabled',
      'modelAllowlist',
      'visibleModelCount',
    ],
    'credential',
  );
  iso(credential.observedAt, 'credential observedAt');
  if (
    credential.httpStatus !== 200 ||
    typeof credential.unlimitedQuota !== 'boolean' ||
    typeof credential.modelLimitsEnabled !== 'boolean'
  ) {
    throw new Error('credential status fields are invalid');
  }
  assertAliasList(credential.modelAllowlist, 'credential modelAllowlist');
  nonNegativeInteger(credential.visibleModelCount, 'visibleModelCount');

  const pricing = object(snapshot.pricing, 'pricing');
  exactKeys(
    pricing,
    [
      'authority',
      'catalogEndpoint',
      'capturedAt',
      'httpStatus',
      'responseSha256',
      'modelRows',
      'groupRows',
      'runtimeFetch',
      'models',
    ],
    'pricing',
  );
  if (
    pricing.authority !== OPENOX_PRICING_AUTHORITY.provider ||
    pricing.catalogEndpoint !==
      'https://openox.tech/api/public/pricing-catalog' ||
    pricing.httpStatus !== 200 ||
    pricing.runtimeFetch !== 'http_200' ||
    typeof pricing.responseSha256 !== 'string' ||
    !SHA256.test(pricing.responseSha256)
  ) {
    throw new Error('pricing authority or capture evidence is invalid');
  }
  iso(pricing.capturedAt, 'pricing capturedAt');
  nonNegativeInteger(pricing.modelRows, 'pricing modelRows');
  nonNegativeInteger(pricing.groupRows, 'pricing groupRows');
  if (!Array.isArray(pricing.models)) throw new Error('pricing models must be an array');
  const pricingAliases = new Set<string>();
  for (const raw of pricing.models) {
    const model = object(raw, 'pricing model');
    exactKeys(
      model,
      [
        'alias',
        'productLine',
        'selectedGroup',
        'currency',
        'pricingUnit',
        'groupMultiplier',
        'inputRate',
        'outputRate',
        'cacheReadRate',
        'cacheWriteRate',
        'effectiveInputRate',
        'effectiveOutputRate',
        'effectiveCacheReadRate',
        'effectiveCacheWriteRate',
        'status',
        'updatedAt',
        'modelBillingMultiplier',
      ],
      'pricing model',
    );
    if (
      typeof model.alias !== 'string' ||
      !ALIAS.test(model.alias) ||
      typeof model.productLine !== 'string' ||
      !ALIAS.test(model.productLine) ||
      typeof model.selectedGroup !== 'string' ||
      model.selectedGroup.length === 0 ||
      !['USD', 'CNY'].includes(model.currency as string) ||
      model.pricingUnit !== 'native_currency_per_million_tokens' ||
      model.status !== 'enabled'
    ) {
      throw new Error('pricing model identity is invalid');
    }
    if (!requiredAliases.has(model.alias)) {
      throw new Error('pricing alias is outside the frozen current route');
    }
    for (const field of [
      'inputRate',
      'outputRate',
      'cacheReadRate',
      'cacheWriteRate',
      'groupMultiplier',
      'effectiveInputRate',
      'effectiveOutputRate',
      'effectiveCacheReadRate',
      'effectiveCacheWriteRate',
    ] as const) {
      if (typeof model[field] !== 'string' || !DECIMAL.test(model[field])) {
        throw new Error(`pricing model ${field} is invalid`);
      }
    }
    if (
      model.modelBillingMultiplier !== null &&
      (typeof model.modelBillingMultiplier !== 'string' ||
        !DECIMAL.test(model.modelBillingMultiplier))
    ) {
      throw new Error('pricing model billing multiplier is invalid');
    }
    iso(model.updatedAt, 'pricing model updatedAt');
    if (pricingAliases.has(model.alias)) throw new Error('duplicate pricing alias');
    pricingAliases.add(model.alias);
  }
  return structuredClone(snapshot) as unknown as CurrentRouteRecoverySafeSnapshot;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  throw new Error('safe snapshot contains unsupported JSON value');
}

export function buildCurrentRouteRecoveryReport(
  input: unknown,
): CurrentRouteRecoveryReport {
  const snapshot = assertSnapshot(input);
  const dispatches = canonicalDispatches();
  const requiredModelAllowlist = currentRouteRecoveryRequiredAliases();
  const exactCredential =
    snapshot.credential.unlimitedQuota === false &&
    snapshot.credential.modelLimitsEnabled === true &&
    JSON.stringify(snapshot.credential.modelAllowlist) ===
      JSON.stringify(requiredModelAllowlist);
  const runtimeEgressProven = snapshot.pricing.runtimeFetch === 'http_200';

  const aliases: CurrentRouteRecoveryReport['aliases'] =
    requiredModelAllowlist.map((alias) => {
      const aliasDispatches = dispatches.filter(
        (entry) => entry.alias === alias,
      );
      const channels = snapshot.gateway.channels.filter(
        (entry) => entry.alias === alias,
      );
      const enabledChannelIds = channels
        .filter(({ status }) => status === 'enabled')
        .map(({ channelId }) => channelId)
        .sort((left, right) => left - right);
      const disabledChannelIds = channels
        .filter(({ status }) => status === 'disabled')
        .map(({ channelId }) => channelId)
        .sort((left, right) => left - right);
      const channelSelection: 'missing' | 'unique' | 'ambiguous' =
        enabledChannelIds.length === 0
          ? 'missing'
          : enabledChannelIds.length === 1
            ? 'unique'
            : 'ambiguous';
      const openOxPricing =
        snapshot.pricing.models.find((entry) => entry.alias === alias) ?? null;
      const blockers: CurrentRouteRecoveryBlocker[] = [];
      if (!openOxPricing) blockers.push('OPENOX_PRICE_MISSING');
      if (channelSelection === 'missing')
        blockers.push('ENABLED_CHANNEL_MISSING');
      if (channelSelection === 'ambiguous')
        blockers.push('ENABLED_CHANNEL_AMBIGUOUS');
      if (!exactCredential) blockers.push('CREDENTIAL_NOT_FINITE_EXACT');
      if (!runtimeEgressProven)
        blockers.push('RUNTIME_PRICING_EGRESS_UNPROVEN');
      return {
        alias,
        protocol: aliasDispatches[0]!.protocol,
        taskIds: [
          ...new Set(aliasDispatches.map(({ taskId }) => taskId)),
        ].sort(),
        enabledChannelIds,
        disabledChannelIds,
        channelSelection,
        openOxPricing,
        blockers,
      };
    });
  const blockers = [...new Set(aliases.flatMap((entry) => entry.blockers))].sort();
  const blockedTaskIds = [
    ...new Set(
      aliases
        .filter((entry) => entry.blockers.length > 0)
        .flatMap((entry) => entry.taskIds),
    ),
  ].sort();
  const requiredActions = [
    ...(blockers.includes('OPENOX_PRICE_MISSING')
      ? (['REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE'] as const)
      : []),
    ...(blockers.includes('ENABLED_CHANNEL_MISSING')
      ? (['RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE'] as const)
      : []),
    ...(blockers.includes('ENABLED_CHANNEL_AMBIGUOUS')
      ? (['PIN_ONE_REVIEWED_CHANNEL'] as const)
      : []),
    ...(blockers.includes('CREDENTIAL_NOT_FINITE_EXACT')
      ? (['CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE'] as const)
      : []),
    ...(blockers.includes('RUNTIME_PRICING_EGRESS_UNPROVEN')
      ? (['PROVE_REVIEWED_RUNTIME_PRICING_EGRESS'] as const)
      : []),
  ];
  return deepFreeze({
    schemaVersion: SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION,
    status:
      blockers.length === 0
        ? 'READY_FOR_RUNTIME_ATTESTATION_DECISION'
        : 'BLOCKED_CURRENT_ROUTE_RECOVERY',
    modelDispatchAuthorization: 'NOT_AUTHORIZED',
    modelGenerationCalls: 0,
    modelFeesUsd: 0,
    source: {
      capturedAt: snapshot.capturedAt,
      routeBaselineCommitSha: snapshot.routeBaselineCommitSha,
      safeSnapshotSha256: createHash('sha256')
        .update(canonicalJson(snapshot))
        .digest('hex'),
      openOxCatalogResponseSha256: snapshot.pricing.responseSha256,
    },
    credential: {
      status: exactCredential ? 'finite_exact' : 'not_finite_exact',
      requiredModelAllowlist,
      observedModelAllowlist: snapshot.credential.modelAllowlist,
    },
    dispatches,
    aliases,
    blockers,
    blockedTaskIds,
    requiredActions,
    boundaries: {
      changesTaskRoutes: false,
      createsRuntimeAttestation: false,
      installsRuntimeAttestation: false,
      mutatesGateway: false,
      dispatchesModels: false,
    },
  });
}

export async function writeCurrentRouteRecoveryReportCreateOnly(
  repositoryRoot: string,
  repositoryRelativeOutput: string,
  report: CurrentRouteRecoveryReport,
): Promise<void> {
  const path = resolve(repositoryRoot, repositoryRelativeOutput);
  const root = resolve(repositoryRoot);
  if (
    !path.startsWith(`${root}/`) ||
    !repositoryRelativeOutput.endsWith('.json') ||
    repositoryRelativeOutput.split('/').includes('..')
  ) {
    throw new Error('output must be a repository-relative JSON path');
  }
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
