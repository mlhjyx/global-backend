import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { PaidModelProtocol } from "../model-gateway/paid-model-settlement";
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from "../model-gateway/model-transports";
import {
  resolveTaskRoute,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from "./agents/task-routes";
import { modelPolicyRegistry } from "./agents/model-policy.registry";
import {
  OPENOX_PRICING_AUTHORITY,
  settlementOpenOxPrice,
  type OpenOxPricingCatalog,
} from "./site-builder-model-settlement";

export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION =
  "site-builder-current-route-recovery-safe-snapshot/2026-07-29-v2" as const;
export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION =
  "site-builder-current-route-recovery-report/2026-07-29-v4" as const;
export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SOURCE_BUNDLE_VERSION =
  "site-builder-current-route-openox-source-bundle/2026-07-29-v1" as const;
export const SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT =
  "e727bb141ad2c8c5fdd4379308ed85cfc7aefb86" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const PROHIBITED_KEYS = new Set([
  "authorization",
  "apikey",
  "baseurl",
  "bearertoken",
  "key",
  "prompt",
  "responsebody",
  "secret",
  "token",
]);

type ChannelStatus = "enabled" | "disabled";

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
  currency: "USD" | "CNY";
  pricingUnit: "native_currency_per_million_tokens";
  groupMultiplier: string;
  inputRate: string;
  outputRate: string;
  cacheReadRate: string;
  cacheWriteRate: string;
  effectiveInputRate: string;
  effectiveOutputRate: string;
  effectiveCacheReadRate: string;
  effectiveCacheWriteRate: string;
  status: "enabled";
  updatedAt: string;
  modelBillingMultiplier: string | null;
}

export interface CurrentRouteRecoverySafeSnapshot {
  schemaVersion: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION;
  capturedAt: string;
  routeBaselineCommitSha: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT;
  routeDispatchSha256: string;
  gateway: {
    source: "local_new_api_read_only_sqlite";
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
    catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
    capturedAt: string;
    httpStatus: 200;
    sourceBundlePath: string;
    sourceBundleSha256: string;
    sourceBundleCommitSha: string;
    modelRows: number;
    groupRows: number;
    runtimeFetch: "http_200";
  };
}

export interface CurrentRouteRecoveryOpenOxSourceBundle {
  schemaVersion: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SOURCE_BUNDLE_VERSION;
  authority: typeof OPENOX_PRICING_AUTHORITY.provider;
  catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
  capturedAt: string;
  httpStatus: 200;
  fullModelCount: number;
  fullGroupCount: number;
  modelIds: string[];
  groupNames: string[];
  catalog: OpenOxPricingCatalog;
}

export type CurrentRouteRecoveryBlocker =
  | "CREDENTIAL_NOT_FINITE_EXACT"
  | "ENABLED_CHANNEL_AMBIGUOUS"
  | "ENABLED_CHANNEL_MISSING"
  | "OPENOX_PRICE_MISSING"
  | "RETIRED_ALIAS_STILL_ACTIVE"
  | "RUNTIME_PRICING_EGRESS_UNPROVEN";

export interface CurrentRouteRecoveryReport {
  schemaVersion: typeof SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION;
  status:
    "BLOCKED_CURRENT_ROUTE_RECOVERY" | "READY_FOR_RUNTIME_ATTESTATION_DECISION";
  modelDispatchAuthorization: "NOT_AUTHORIZED";
  modelGenerationCalls: 0;
  modelFeesUsd: 0;
  source: {
    capturedAt: string;
    routeBaselineCommitSha: string;
    routeDispatchSha256: string;
    safeSnapshotSha256: string;
    openOxSourceBundleSha256: string;
    openOxSourceBundleCommitSha: string;
    runnerSourceSha256: string;
  };
  credential: {
    status: "finite_exact" | "not_finite_exact";
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
    retirementDecision: "pending_retirement" | null;
    enabledChannelIds: number[];
    disabledChannelIds: number[];
    channelSelection: "missing" | "unique" | "ambiguous" | "not_applicable";
    openOxPricing: CurrentRouteRecoveryPricingModelSnapshot | null;
    blockers: CurrentRouteRecoveryBlocker[];
  }>;
  blockers: CurrentRouteRecoveryBlocker[];
  blockedTaskIds: SiteBuilderTaskId[];
  requiredActions: Array<
    | "CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE"
    | "PIN_ONE_REVIEWED_CHANNEL"
    | "PROVE_REVIEWED_RUNTIME_PRICING_EGRESS"
    | "PROMOTE_TASKS_OFF_RETIRED_ALIASES"
    | "REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE"
    | "RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE"
  >;
  boundaries: {
    changesTaskRoutes: false;
    createsRuntimeAttestation: false;
    installsRuntimeAttestation: false;
    mutatesGateway: false;
    dispatchesModels: false;
  };
}

function exactKeys(
  value: object,
  expected: readonly string[],
  role: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${role} contains undeclared or missing fields`);
  }
}

function object(value: unknown, role: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${role} must be an object`);
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown, role: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    throw new Error(`${role} must be an ISO UTC timestamp`);
  }
}

function nonNegativeInteger(
  value: unknown,
  role: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${role} must be a non-negative safe integer`);
  }
}

function assertNoSecretAdjacentKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretAdjacentKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (PROHIBITED_KEYS.has(key.toLowerCase())) {
      throw new Error(`safe snapshot contains prohibited field ${key}`);
    }
    assertNoSecretAdjacentKeys(nested);
  }
}

function protocolFor(alias: string): PaidModelProtocol {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? "openai-chat-completions";
}

function canonicalDispatches(): CurrentRouteRecoveryReport["dispatches"] {
  return SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
    const route = resolveTaskRoute(taskId, {});
    return [route.primary, ...route.fallbacks].map((alias) => ({
      taskId,
      alias,
      protocol: protocolFor(alias),
    }));
  });
}

export function currentRouteRecoveryActiveAliases(): string[] {
  return [...new Set(canonicalDispatches().map(({ alias }) => alias))].sort();
}

export function currentRouteRecoveryRequiredAliases(): string[] {
  return currentRouteRecoveryActiveAliases().filter(
    (alias) => modelPolicyRegistry.getAliasRetirementPolicy(alias) === null,
  );
}

export function currentRouteRecoveryDispatchSha256(): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalDispatches()))
    .digest("hex");
}

function assertAliasList(
  value: unknown,
  role: string,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((alias) => typeof alias !== "string" || !ALIAS.test(alias)) ||
    new Set(value).size !== value.length ||
    JSON.stringify([...value].sort()) !== JSON.stringify(value)
  ) {
    throw new Error(`${role} must be a sorted unique alias list`);
  }
}

function assertSnapshot(input: unknown): CurrentRouteRecoverySafeSnapshot {
  assertNoSecretAdjacentKeys(input);
  const snapshot = object(input, "safe snapshot");
  exactKeys(
    snapshot,
    [
      "schemaVersion",
      "capturedAt",
      "routeBaselineCommitSha",
      "routeDispatchSha256",
      "gateway",
      "credential",
      "pricing",
    ],
    "safe snapshot",
  );
  if (
    snapshot.schemaVersion !==
    SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION
  ) {
    throw new Error("unsupported safe snapshot schemaVersion");
  }
  iso(snapshot.capturedAt, "capturedAt");
  if (
    snapshot.routeBaselineCommitSha !==
      SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT ||
    snapshot.routeDispatchSha256 !== currentRouteRecoveryDispatchSha256()
  ) {
    throw new Error("route baseline commit or dispatch digest is not frozen");
  }

  const gateway = object(snapshot.gateway, "gateway");
  exactKeys(gateway, ["source", "channels"], "gateway");
  if (gateway.source !== "local_new_api_read_only_sqlite") {
    throw new Error("gateway source must be read-only local new-api");
  }
  if (!Array.isArray(gateway.channels)) {
    throw new Error("gateway channels must be an array");
  }
  const activeAliases = new Set(currentRouteRecoveryActiveAliases());
  const channelKeys = new Set<string>();
  for (const raw of gateway.channels) {
    const channel = object(raw, "channel");
    exactKeys(
      channel,
      ["alias", "channelId", "status", "priority", "weight"],
      "channel",
    );
    if (typeof channel.alias !== "string" || !ALIAS.test(channel.alias)) {
      throw new Error("channel alias is invalid");
    }
    if (!activeAliases.has(channel.alias)) {
      throw new Error("channel alias is outside the frozen current route");
    }
    nonNegativeInteger(channel.channelId, "channelId");
    nonNegativeInteger(channel.priority, "priority");
    nonNegativeInteger(channel.weight, "weight");
    if (channel.status !== "enabled" && channel.status !== "disabled") {
      throw new Error("channel status is invalid");
    }
    const key = `${channel.alias}:${channel.channelId}`;
    if (channelKeys.has(key)) throw new Error("duplicate alias/channel pair");
    channelKeys.add(key);
  }

  const credential = object(snapshot.credential, "credential");
  exactKeys(
    credential,
    [
      "observedAt",
      "httpStatus",
      "unlimitedQuota",
      "modelLimitsEnabled",
      "modelAllowlist",
      "visibleModelCount",
    ],
    "credential",
  );
  iso(credential.observedAt, "credential observedAt");
  if (
    credential.httpStatus !== 200 ||
    typeof credential.unlimitedQuota !== "boolean" ||
    typeof credential.modelLimitsEnabled !== "boolean"
  ) {
    throw new Error("credential status fields are invalid");
  }
  assertAliasList(credential.modelAllowlist, "credential modelAllowlist");
  nonNegativeInteger(credential.visibleModelCount, "visibleModelCount");

  const pricing = object(snapshot.pricing, "pricing");
  exactKeys(
    pricing,
    [
      "authority",
      "catalogEndpoint",
      "capturedAt",
      "httpStatus",
      "sourceBundlePath",
      "sourceBundleSha256",
      "sourceBundleCommitSha",
      "modelRows",
      "groupRows",
      "runtimeFetch",
    ],
    "pricing",
  );
  if (
    pricing.authority !== OPENOX_PRICING_AUTHORITY.provider ||
    pricing.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    pricing.httpStatus !== 200 ||
    pricing.runtimeFetch !== "http_200" ||
    typeof pricing.sourceBundlePath !== "string" ||
    !pricing.sourceBundlePath.endsWith(".json") ||
    pricing.sourceBundlePath.startsWith("/") ||
    pricing.sourceBundlePath.split("/").includes("..") ||
    typeof pricing.sourceBundleSha256 !== "string" ||
    !SHA256.test(pricing.sourceBundleSha256) ||
    typeof pricing.sourceBundleCommitSha !== "string" ||
    !COMMIT_SHA.test(pricing.sourceBundleCommitSha)
  ) {
    throw new Error("pricing authority or capture evidence is invalid");
  }
  iso(pricing.capturedAt, "pricing capturedAt");
  nonNegativeInteger(pricing.modelRows, "pricing modelRows");
  nonNegativeInteger(pricing.groupRows, "pricing groupRows");
  return structuredClone(
    snapshot,
  ) as unknown as CurrentRouteRecoverySafeSnapshot;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "number")
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  throw new Error("safe snapshot contains unsupported JSON value");
}

function selectedOpenOxGroup(alias: string): string {
  if (alias === "gpt-5.6-terra") return "gpt-unified";
  if (alias === "claude-sonnet-5") return "special";
  if (alias.startsWith("deepseek-")) return "deepseek";
  if (alias.startsWith("doubao-")) return "doubao";
  if (alias.startsWith("minimax-")) return "minimax";
  if (alias.startsWith("glm-")) return "glm";
  throw new Error(`no frozen OpenOx group for ${alias}`);
}

function microunitsToDecimal(value: number): string {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : String(whole);
}

function assertOpenOxSourceBundle(
  input: unknown,
): CurrentRouteRecoveryOpenOxSourceBundle {
  assertNoSecretAdjacentKeys(input);
  const bundle = object(input, "OpenOx source bundle");
  exactKeys(
    bundle,
    [
      "schemaVersion",
      "authority",
      "catalogEndpoint",
      "capturedAt",
      "httpStatus",
      "fullModelCount",
      "fullGroupCount",
      "modelIds",
      "groupNames",
      "catalog",
    ],
    "OpenOx source bundle",
  );
  if (
    bundle.schemaVersion !==
      SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SOURCE_BUNDLE_VERSION ||
    bundle.authority !== OPENOX_PRICING_AUTHORITY.provider ||
    bundle.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    bundle.httpStatus !== 200
  ) {
    throw new Error("OpenOx source bundle identity is invalid");
  }
  iso(bundle.capturedAt, "OpenOx source bundle capturedAt");
  nonNegativeInteger(bundle.fullModelCount, "OpenOx fullModelCount");
  nonNegativeInteger(bundle.fullGroupCount, "OpenOx fullGroupCount");
  assertAliasList(bundle.modelIds, "OpenOx modelIds");
  if (
    bundle.fullModelCount !== bundle.modelIds.length ||
    !Array.isArray(bundle.groupNames) ||
    bundle.groupNames.some(
      (name) =>
        typeof name !== "string" || name.length === 0 || name.length > 128,
    ) ||
    new Set(bundle.groupNames).size !== bundle.groupNames.length ||
    bundle.fullGroupCount !== bundle.groupNames.length
  ) {
    throw new Error("OpenOx full catalog identity sets are invalid");
  }

  const catalog = object(bundle.catalog, "OpenOx catalog");
  exactKeys(catalog, ["success", "data"], "OpenOx catalog");
  if (catalog.success !== true) throw new Error("OpenOx catalog must succeed");
  const data = object(catalog.data, "OpenOx catalog data");
  exactKeys(data, ["models", "groups"], "OpenOx catalog data");
  if (!Array.isArray(data.models) || !Array.isArray(data.groups)) {
    throw new Error("OpenOx catalog models and groups must be arrays");
  }
  const requiredAliases = currentRouteRecoveryRequiredAliases();
  const expectedPublishedAliases = requiredAliases.filter((alias) =>
    (bundle.modelIds as string[]).includes(alias),
  );
  const modelAliases: string[] = [];
  for (const raw of data.models) {
    const model = object(raw, "OpenOx catalog model");
    exactKeys(
      model,
      [
        "model_id",
        "product_line",
        "input_rate",
        "output_rate",
        "cache_read_rate",
        "cache_write_rate",
        "group_rates",
        "status",
        "updated_at",
      ],
      "OpenOx catalog model",
    );
    if (
      typeof model.model_id !== "string" ||
      !expectedPublishedAliases.includes(model.model_id) ||
      typeof model.product_line !== "string" ||
      model.status !== "enabled"
    ) {
      throw new Error("OpenOx selected model row is invalid");
    }
    iso(model.updated_at, "OpenOx model updatedAt");
    modelAliases.push(model.model_id);
  }
  if (
    JSON.stringify([...modelAliases].sort()) !==
    JSON.stringify(expectedPublishedAliases)
  ) {
    throw new Error(
      "OpenOx selected model rows do not match the full model set",
    );
  }
  const expectedGroups = [
    ...new Set(expectedPublishedAliases.map(selectedOpenOxGroup)),
  ].sort();
  const selectedGroups: string[] = [];
  for (const raw of data.groups) {
    const group = object(raw, "OpenOx catalog group");
    exactKeys(
      group,
      ["name", "product_line", "rate_multiplier"],
      "OpenOx catalog group",
    );
    if (
      typeof group.name !== "string" ||
      !expectedGroups.includes(group.name) ||
      !(bundle.groupNames as string[]).includes(group.name)
    ) {
      throw new Error("OpenOx selected group row is invalid");
    }
    selectedGroups.push(group.name);
  }
  if (
    JSON.stringify([...selectedGroups].sort()) !==
    JSON.stringify(expectedGroups)
  ) {
    throw new Error("OpenOx selected groups do not match published aliases");
  }
  return structuredClone(
    bundle,
  ) as unknown as CurrentRouteRecoveryOpenOxSourceBundle;
}

function deriveOpenOxPricing(
  sourceBundle: CurrentRouteRecoveryOpenOxSourceBundle,
): CurrentRouteRecoveryPricingModelSnapshot[] {
  return currentRouteRecoveryRequiredAliases().flatMap((alias) => {
    if (!sourceBundle.modelIds.includes(alias)) return [];
    const selectedGroup = selectedOpenOxGroup(alias);
    const price = settlementOpenOxPrice(
      sourceBundle.catalog,
      alias,
      selectedGroup,
    );
    if (!price) {
      throw new Error(`OpenOx source bundle cannot price ${alias}`);
    }
    const source = price.source;
    if (
      typeof source.inputRate !== "string" ||
      typeof source.outputRate !== "string" ||
      typeof source.cacheReadRate !== "string" ||
      typeof source.cacheWriteRate !== "string" ||
      typeof source.groupMultiplier !== "string" ||
      typeof source.updatedAt !== "string"
    ) {
      throw new Error(`OpenOx source fields are invalid for ${alias}`);
    }
    return [
      {
        alias,
        productLine: price.productLine,
        selectedGroup,
        currency: price.currency,
        pricingUnit: "native_currency_per_million_tokens" as const,
        groupMultiplier: source.groupMultiplier,
        inputRate: source.inputRate,
        outputRate: source.outputRate,
        cacheReadRate: source.cacheReadRate,
        cacheWriteRate: source.cacheWriteRate,
        effectiveInputRate: microunitsToDecimal(
          price.inputPriceMicrounitsPerMillionTokens,
        ),
        effectiveOutputRate: microunitsToDecimal(
          price.outputPriceMicrounitsPerMillionTokens,
        ),
        effectiveCacheReadRate: microunitsToDecimal(
          price.cacheReadPriceMicrounitsPerMillionTokens,
        ),
        effectiveCacheWriteRate: microunitsToDecimal(
          price.cacheWritePriceMicrounitsPerMillionTokens,
        ),
        status: "enabled" as const,
        updatedAt: source.updatedAt,
        modelBillingMultiplier:
          typeof source.modelBillingMultiplier === "string"
            ? source.modelBillingMultiplier
            : null,
      },
    ];
  });
}

export function buildCurrentRouteRecoveryReport(
  input: unknown,
  openOxSourceInput: unknown,
  openOxSourceBundleSha256: string,
  runnerSourceSha256: string,
): CurrentRouteRecoveryReport {
  const snapshot = assertSnapshot(input);
  const openOxSourceBundle = assertOpenOxSourceBundle(openOxSourceInput);
  if (
    !SHA256.test(openOxSourceBundleSha256) ||
    !SHA256.test(runnerSourceSha256) ||
    snapshot.pricing.sourceBundleSha256 !== openOxSourceBundleSha256 ||
    snapshot.pricing.modelRows !== openOxSourceBundle.fullModelCount ||
    snapshot.pricing.groupRows !== openOxSourceBundle.fullGroupCount ||
    snapshot.pricing.capturedAt !== openOxSourceBundle.capturedAt
  ) {
    throw new Error(
      "OpenOx source bundle does not reproduce the safe snapshot",
    );
  }
  const openOxPricing = deriveOpenOxPricing(openOxSourceBundle);
  const dispatches = canonicalDispatches();
  const requiredModelAllowlist = currentRouteRecoveryRequiredAliases();
  const activeAliases = currentRouteRecoveryActiveAliases();
  const exactCredential =
    snapshot.credential.unlimitedQuota === false &&
    snapshot.credential.modelLimitsEnabled === true &&
    snapshot.credential.visibleModelCount === requiredModelAllowlist.length &&
    JSON.stringify(snapshot.credential.modelAllowlist) ===
      JSON.stringify(requiredModelAllowlist);
  const runtimeEgressProven = snapshot.pricing.runtimeFetch === "http_200";

  const aliases: CurrentRouteRecoveryReport["aliases"] = activeAliases.map(
    (alias) => {
      const aliasDispatches = dispatches.filter(
        (entry) => entry.alias === alias,
      );
      const retirementPolicy =
        modelPolicyRegistry.getAliasRetirementPolicy(alias);
      const channels = snapshot.gateway.channels.filter(
        (entry) => entry.alias === alias,
      );
      const enabledChannelIds = channels
        .filter(({ status }) => status === "enabled")
        .map(({ channelId }) => channelId)
        .sort((left, right) => left - right);
      const disabledChannelIds = channels
        .filter(({ status }) => status === "disabled")
        .map(({ channelId }) => channelId)
        .sort((left, right) => left - right);
      const channelSelection:
        "missing" | "unique" | "ambiguous" | "not_applicable" = retirementPolicy
        ? "not_applicable"
        : enabledChannelIds.length === 0
          ? "missing"
          : enabledChannelIds.length === 1
            ? "unique"
            : "ambiguous";
      const selectedOpenOxPricing =
        openOxPricing.find((entry) => entry.alias === alias) ?? null;
      const blockers: CurrentRouteRecoveryBlocker[] = [];
      if (retirementPolicy) {
        blockers.push("RETIRED_ALIAS_STILL_ACTIVE");
      } else {
        if (!selectedOpenOxPricing) blockers.push("OPENOX_PRICE_MISSING");
        if (channelSelection === "missing")
          blockers.push("ENABLED_CHANNEL_MISSING");
        if (channelSelection === "ambiguous")
          blockers.push("ENABLED_CHANNEL_AMBIGUOUS");
        if (!exactCredential) blockers.push("CREDENTIAL_NOT_FINITE_EXACT");
        if (!runtimeEgressProven)
          blockers.push("RUNTIME_PRICING_EGRESS_UNPROVEN");
      }
      return {
        alias,
        protocol: aliasDispatches[0]!.protocol,
        taskIds: [
          ...new Set(aliasDispatches.map(({ taskId }) => taskId)),
        ].sort(),
        retirementDecision: retirementPolicy?.decision ?? null,
        enabledChannelIds,
        disabledChannelIds,
        channelSelection,
        openOxPricing: selectedOpenOxPricing,
        blockers,
      };
    },
  );
  const blockers = [
    ...new Set(aliases.flatMap((entry) => entry.blockers)),
  ].sort();
  const blockedTaskIds = [
    ...new Set(
      aliases
        .filter((entry) => entry.blockers.length > 0)
        .flatMap((entry) => entry.taskIds),
    ),
  ].sort();
  const requiredActions = [
    ...(blockers.includes("RETIRED_ALIAS_STILL_ACTIVE")
      ? (["PROMOTE_TASKS_OFF_RETIRED_ALIASES"] as const)
      : []),
    ...(blockers.includes("OPENOX_PRICE_MISSING")
      ? (["REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE"] as const)
      : []),
    ...(blockers.includes("ENABLED_CHANNEL_MISSING")
      ? (["RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE"] as const)
      : []),
    ...(blockers.includes("ENABLED_CHANNEL_AMBIGUOUS")
      ? (["PIN_ONE_REVIEWED_CHANNEL"] as const)
      : []),
    ...(blockers.includes("CREDENTIAL_NOT_FINITE_EXACT")
      ? (["CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE"] as const)
      : []),
    ...(blockers.includes("RUNTIME_PRICING_EGRESS_UNPROVEN")
      ? (["PROVE_REVIEWED_RUNTIME_PRICING_EGRESS"] as const)
      : []),
  ];
  return deepFreeze({
    schemaVersion: SITE_BUILDER_CURRENT_ROUTE_RECOVERY_REPORT_VERSION,
    status:
      blockers.length === 0
        ? "READY_FOR_RUNTIME_ATTESTATION_DECISION"
        : "BLOCKED_CURRENT_ROUTE_RECOVERY",
    modelDispatchAuthorization: "NOT_AUTHORIZED",
    modelGenerationCalls: 0,
    modelFeesUsd: 0,
    source: {
      capturedAt: snapshot.capturedAt,
      routeBaselineCommitSha: snapshot.routeBaselineCommitSha,
      routeDispatchSha256: snapshot.routeDispatchSha256,
      safeSnapshotSha256: createHash("sha256")
        .update(canonicalJson(snapshot))
        .digest("hex"),
      openOxSourceBundleSha256,
      openOxSourceBundleCommitSha: snapshot.pricing.sourceBundleCommitSha,
      runnerSourceSha256,
    },
    credential: {
      status: exactCredential ? "finite_exact" : "not_finite_exact",
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
  const root = await realpath(resolve(repositoryRoot));
  const path = resolve(root, repositoryRelativeOutput);
  if (
    !path.startsWith(`${root}/`) ||
    !repositoryRelativeOutput.endsWith(".json") ||
    repositoryRelativeOutput.split("/").includes("..")
  ) {
    throw new Error("output must be a repository-relative JSON path");
  }
  const expectedParent = dirname(path);
  const actualParent = await realpath(expectedParent);
  if (
    actualParent !== expectedParent ||
    (actualParent !== root && !actualParent.startsWith(`${root}/`))
  ) {
    throw new Error("output path must not traverse a symbolic link");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function readCurrentRouteRecoveryRepositoryJson(
  repositoryRoot: string,
  repositoryRelativeInput: string,
): Promise<{ parsed: unknown; sha256: string }> {
  const root = await realpath(resolve(repositoryRoot));
  const path = resolve(root, repositoryRelativeInput);
  if (
    !path.startsWith(`${root}/`) ||
    !repositoryRelativeInput.endsWith(".json") ||
    repositoryRelativeInput.split("/").includes("..")
  ) {
    throw new Error("input must be a repository-relative JSON path");
  }
  const actualPath = await realpath(path);
  if (actualPath !== path || !actualPath.startsWith(`${root}/`)) {
    throw new Error("input path must not traverse a symbolic link");
  }
  const bytes = await readFile(actualPath);
  return {
    parsed: JSON.parse(bytes.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
