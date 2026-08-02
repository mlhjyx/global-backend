import { createHash } from "node:crypto";

import type { OpenOxPricingCatalog } from "../site-builder-model-settlement";
import { settlementOpenOxPrice } from "../site-builder-model-settlement";

export const DESIGN_SPEC_EVIDENCE_PREFLIGHT_ID =
  "site-builder-design-spec-evidence-preflight/2026-08-02-v2" as const;
export const DESIGN_SPEC_EVIDENCE_PREFLIGHT_SCHEMA_VERSION =
  "site-builder-design-spec-evidence-preflight/v2" as const;
export const OPENOX_PRICING_CATALOG_URL =
  "https://openox.tech/api/public/pricing-catalog" as const;
export const OPENOX_PRICING_MODELS_PAGE = "https://openox.tech/models" as const;
export const MAX_OPENOX_CATALOG_BYTES = 1_048_576;
export const PROTOCOL_FRAMING_TOKEN_UPPER_BOUND = 4_096;

const REQUIRED_MANIFEST_SCHEMA =
  "site-builder-design-spec-evaluation-manifest-prep/v1";
const REQUIRED_TASK_ID = "site_builder.design_spec";
const REQUIRED_GROUP_BY_ALIAS: Readonly<Record<string, string>> = Object.freeze(
  {
    "gpt-5.6-terra": "gpt-unified",
    "gpt-5.5": "gpt-unified",
    "claude-sonnet-5": "special",
  },
);
const REQUIRED_EVALUATION_GROUP = "design-spec-eval" as const;
const REQUIRED_CHANNEL_BY_ALIAS: Readonly<
  Record<string, { channelId: number; protocol: string }>
> = Object.freeze({
  "claude-sonnet-5": {
    channelId: 19,
    protocol: "anthropic-messages",
  },
  "gpt-5.5": { channelId: 17, protocol: "openai-responses" },
  "gpt-5.6-terra": { channelId: 17, protocol: "openai-responses" },
});
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type DesignSpecEvidencePreflightStatus =
  | "READY_FOR_PRODUCT_DECISION"
  | "BLOCKED_CREDENTIAL_NOT_FINITE_EXACT"
  | "BLOCKED_CHANNEL_NOT_EXACT"
  | "BLOCKED_OPENOX_PRICE_MISSING"
  | "BLOCKED_READ_ONLY_PREFLIGHT_UNAVAILABLE";

export interface DesignSpecEvidencePreflightManifest {
  schemaVersion: string;
  taskId: string;
  fixedCommitSha: string;
  executionCount: number;
  maximumWireCallCount: number;
  promptUtf8Bytes: {
    maximumCanonicalInitial: number;
    maximumCanonicalRepair: number;
  };
  planningHardUpperBound: {
    perWireCallCents: number;
    amountCents: number;
  };
  executions: readonly {
    kind: "capability_probe" | "target";
    alias: string;
    protocol: "openai-responses" | "anthropic-messages";
    maximumWireCalls: number;
    maximumRepairCalls: number;
  }[];
  suite?: {
    suiteId?: string;
    sourceBundleContractId?: string;
    sourceBundleSha256?: string;
  };
}

export interface DesignSpecEvidenceCredentialSnapshot {
  source: "new_api_read_only_control_plane";
  observedAt: string;
  gatewayOrigin: string | null;
  credentialMaterial: "not_persisted";
  purpose: "site_builder_model_evaluation";
  observedQuotaMode: "limited" | "unlimited" | "unavailable";
  modelLimitsEnabled: boolean | null;
  scopeExact: boolean;
  quotaCapPoints: number | null;
  remainingQuotaPoints: number | null;
  observedAllowedAliases: readonly string[];
  requiredAllowedAliases: readonly string[];
  requiredAliasesVisible: readonly string[];
  visibleModelCount: number | null;
  visibleModelIdsSha256: string | null;
}

export interface DesignSpecEvidencePriceSnapshot {
  authority: "openox_model_marketplace";
  modelsPage: typeof OPENOX_PRICING_MODELS_PAGE;
  catalogEndpoint: typeof OPENOX_PRICING_CATALOG_URL;
  capturedAt: string;
  httpStatus: number;
  catalogResponseSha256: string | null;
  fullModelCount: number | null;
  fullGroupCount: number | null;
  selectedPricingSha256: string | null;
  entries: readonly {
    alias: string;
    protocol: "openai-responses" | "anthropic-messages";
    groupName: string;
    status: "published" | "missing";
    currency: "USD" | "CNY" | null;
    productLine: string | null;
    groupMultiplier: string | null;
    inputRate: string | null;
    outputRate: string | null;
    cacheReadRate: string | null;
    cacheWriteRate: string | null;
    effectiveInputRate: string | null;
    effectiveOutputRate: string | null;
    effectiveCacheReadRate: string | null;
    effectiveCacheWriteRate: string | null;
    modelUpdatedAt: string | null;
    pricingVersion: string | null;
  }[];
}

export interface DesignSpecEvidenceCostEstimate {
  inputTokenUpperBoundInitial: number;
  inputTokenUpperBoundRepair: number;
  outputTokenUpperBoundPerCall: number;
  maximumWireCallCount: number;
  mechanicalHardCeilingCents: number;
  perWireCallHardCapCents: number;
  expectedCost: "not_known_before_usage";
  conservativeTokenEnvelopeByCurrency: Readonly<{ USD: number; CNY: number }>;
}

export interface DesignSpecEvidenceChannelBindingSnapshot {
  source: "new_api_sanitized_control_plane_snapshot";
  observedAt: string | null;
  group: string | null;
  groupRatio: number | null;
  crossGroupRetry: boolean | null;
  exact: boolean;
  credentialMaterial: "not_persisted";
  entries: readonly {
    alias: string;
    protocol: string;
    channelId: number;
    channelName: string;
    enabled: boolean;
  }[];
}

export interface DesignSpecEvidencePreflightReport {
  schemaVersion: typeof DESIGN_SPEC_EVIDENCE_PREFLIGHT_SCHEMA_VERSION;
  preflightId: typeof DESIGN_SPEC_EVIDENCE_PREFLIGHT_ID;
  status: DesignSpecEvidencePreflightStatus;
  dispatchAuthorization: "NOT_AUTHORIZED";
  fixedSourceCommitSha: string;
  manifestSha256: string;
  suiteId: string | null;
  sourceBundle: {
    commitSha: string;
    contractId: string | null;
    sha256: string;
    files: readonly { path: string; sha256: string }[];
  };
  readOnlyNetwork: {
    calls: number;
    modelWireCalls: 0;
    generativeEndpointsCalled: readonly [];
  };
  credential: DesignSpecEvidenceCredentialSnapshot;
  channelBinding: DesignSpecEvidenceChannelBindingSnapshot;
  pricing: DesignSpecEvidencePriceSnapshot;
  estimate: DesignSpecEvidenceCostEstimate;
  blockers: readonly string[];
  stopConditions: readonly string[];
  actualModelCostCents: 0;
  reportSha256: string;
}

export interface DesignSpecEvidencePreflightInput {
  manifest: unknown;
  capturedAt: string;
  gatewayOrigin: string | null;
  credentialMaterial: "not_persisted";
  gatewayModels: unknown | null;
  gatewayUsage: unknown | null;
  gatewayChannelBinding: unknown | null;
  openOxCatalog: unknown | null;
  openOxHttpStatus: number;
  openOxResponseSha256: string | null;
  readOnlyNetworkCalls: number;
  sourceBundle: DesignSpecEvidencePreflightReport["sourceBundle"];
}

const STOP_CONDITIONS = Object.freeze([
  "fixed_commit_or_manifest_drift",
  "source_bundle_drift",
  "missing_or_non_finite_exact_credential_scope",
  "missing_ambiguous_or_changed_channel_binding",
  "missing_or_changed_openox_price",
  "separate_cost_authorization_missing",
  "execution_or_wire_call_manifest_exhausted",
  "protocol_or_model_identity_mismatch",
  "unknown_or_over_budget_settlement",
] as const);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("preflight value is not canonical JSON");
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function decimalRate(value: number): string {
  const rounded = Math.round(value);
  const whole = Math.floor(rounded / 1_000_000);
  const fraction = String(rounded % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : String(whole);
}

function sourceString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function assertManifest(input: unknown): DesignSpecEvidencePreflightManifest {
  const value = record(input, "design_spec manifest");
  if (
    value.schemaVersion !== REQUIRED_MANIFEST_SCHEMA ||
    value.taskId !== REQUIRED_TASK_ID ||
    typeof value.fixedCommitSha !== "string" ||
    !SHA1.test(value.fixedCommitSha) ||
    !Number.isSafeInteger(value.executionCount) ||
    !Number.isSafeInteger(value.maximumWireCallCount) ||
    !Array.isArray(value.executions) ||
    !value.promptUtf8Bytes ||
    !value.planningHardUpperBound
  )
    throw new Error("design_spec manifest identity or shape is invalid");
  const executions = value.executions as unknown[];
  if (executions.length !== value.executionCount)
    throw new Error("design_spec manifest execution count drifted");
  const aliases = new Set<string>();
  for (const entry of executions) {
    const dispatch = record(entry, "design_spec manifest execution");
    if (
      (dispatch.kind !== "capability_probe" && dispatch.kind !== "target") ||
      typeof dispatch.alias !== "string" ||
      typeof dispatch.protocol !== "string" ||
      !REQUIRED_GROUP_BY_ALIAS[dispatch.alias]
    )
      throw new Error("design_spec manifest contains an unapproved dispatch");
    aliases.add(dispatch.alias);
  }
  if (
    JSON.stringify([...aliases].sort()) !==
    JSON.stringify(Object.keys(REQUIRED_GROUP_BY_ALIAS).sort())
  ) {
    throw new Error("design_spec manifest candidate set drifted");
  }
  return value as unknown as DesignSpecEvidencePreflightManifest;
}

function usageData(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  const outer = record(input, "gateway usage response");
  return outer.data &&
    typeof outer.data === "object" &&
    !Array.isArray(outer.data)
    ? (outer.data as Record<string, unknown>)
    : outer;
}

function visibleModelIds(input: unknown): string[] {
  if (!input) return [];
  const outer = record(input, "gateway models response");
  if (!Array.isArray(outer.data)) return [];
  return outer.data
    .map((entry) => record(entry, "gateway model row").id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

function channelBindingSnapshot(
  input: unknown | null,
): DesignSpecEvidenceChannelBindingSnapshot {
  const unavailable: DesignSpecEvidenceChannelBindingSnapshot = {
    source: "new_api_sanitized_control_plane_snapshot",
    observedAt: null,
    group: null,
    groupRatio: null,
    crossGroupRetry: null,
    exact: false,
    credentialMaterial: "not_persisted",
    entries: [],
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return unavailable;
  const value = input as Record<string, unknown>;
  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  const entries = rawEntries
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;
      const row = entry as Record<string, unknown>;
      if (
        typeof row.alias !== "string" ||
        typeof row.protocol !== "string" ||
        !Number.isSafeInteger(row.channelId) ||
        typeof row.channelName !== "string" ||
        row.channelName.length === 0 ||
        typeof row.enabled !== "boolean"
      )
        return null;
      return {
        alias: row.alias,
        protocol: row.protocol,
        channelId: row.channelId as number,
        channelName: row.channelName,
        enabled: row.enabled,
      };
    })
    .filter(
      (
        entry,
      ): entry is DesignSpecEvidenceChannelBindingSnapshot["entries"][number] =>
        entry !== null,
    )
    .sort(
      (left, right) =>
        left.alias.localeCompare(right.alias) ||
        left.channelId - right.channelId,
    );
  const expectedAliases = Object.keys(REQUIRED_CHANNEL_BY_ALIAS).sort();
  const exactEntries =
    entries.length === expectedAliases.length &&
    expectedAliases.every((alias) => {
      const expected = REQUIRED_CHANNEL_BY_ALIAS[alias]!;
      const matches = entries.filter((entry) => entry.alias === alias);
      return (
        matches.length === 1 &&
        matches[0]!.protocol === expected.protocol &&
        matches[0]!.channelId === expected.channelId &&
        matches[0]!.enabled
      );
    });
  const exact =
    value.source === "new_api_sanitized_control_plane_snapshot" &&
    value.group === REQUIRED_EVALUATION_GROUP &&
    value.groupRatio === 1 &&
    value.crossGroupRetry === false &&
    exactEntries;
  return {
    source: "new_api_sanitized_control_plane_snapshot",
    observedAt: typeof value.observedAt === "string" ? value.observedAt : null,
    group: typeof value.group === "string" ? value.group : null,
    groupRatio: typeof value.groupRatio === "number" ? value.groupRatio : null,
    crossGroupRetry:
      typeof value.crossGroupRetry === "boolean" ? value.crossGroupRetry : null,
    exact,
    credentialMaterial: "not_persisted",
    entries,
  };
}

function priceEntries(
  manifest: DesignSpecEvidencePreflightManifest,
  catalog: OpenOxPricingCatalog | null,
): DesignSpecEvidencePriceSnapshot["entries"] {
  const protocols = new Map(
    manifest.executions.map((entry) => [entry.alias, entry.protocol]),
  );
  return Object.keys(REQUIRED_GROUP_BY_ALIAS)
    .sort()
    .map((alias) => {
      const protocol = protocols.get(alias)!;
      const groupName = REQUIRED_GROUP_BY_ALIAS[alias]!;
      const price = catalog
        ? settlementOpenOxPrice(catalog, alias, groupName)
        : null;
      if (!price)
        return {
          alias,
          protocol,
          groupName,
          status: "missing" as const,
          currency: null,
          productLine: null,
          groupMultiplier: null,
          inputRate: null,
          outputRate: null,
          cacheReadRate: null,
          cacheWriteRate: null,
          effectiveInputRate: null,
          effectiveOutputRate: null,
          effectiveCacheReadRate: null,
          effectiveCacheWriteRate: null,
          modelUpdatedAt: null,
          pricingVersion: null,
        };
      return {
        alias,
        protocol,
        groupName,
        status: "published" as const,
        currency: price.currency,
        productLine: price.productLine,
        groupMultiplier: sourceString(price.source.groupMultiplier),
        inputRate: sourceString(price.source.inputRate),
        outputRate: sourceString(price.source.outputRate),
        cacheReadRate: sourceString(price.source.cacheReadRate),
        cacheWriteRate: sourceString(price.source.cacheWriteRate),
        effectiveInputRate: decimalRate(
          price.inputPriceMicrounitsPerMillionTokens,
        ),
        effectiveOutputRate: decimalRate(
          price.outputPriceMicrounitsPerMillionTokens,
        ),
        effectiveCacheReadRate: decimalRate(
          price.cacheReadPriceMicrounitsPerMillionTokens,
        ),
        effectiveCacheWriteRate: decimalRate(
          price.cacheWritePriceMicrounitsPerMillionTokens,
        ),
        modelUpdatedAt: sourceString(price.source.updatedAt),
        pricingVersion: price.pricingVersion,
      };
    });
}

function estimateCost(
  manifest: DesignSpecEvidencePreflightManifest,
  entries: DesignSpecEvidencePriceSnapshot["entries"],
): DesignSpecEvidenceCostEstimate {
  const initialInput =
    manifest.promptUtf8Bytes.maximumCanonicalInitial +
    PROTOCOL_FRAMING_TOKEN_UPPER_BOUND;
  const repairInput =
    manifest.promptUtf8Bytes.maximumCanonicalRepair +
    PROTOCOL_FRAMING_TOKEN_UPPER_BOUND;
  const totals = { USD: 0, CNY: 0 };
  for (const execution of manifest.executions) {
    const entry = entries.find(
      (candidate) => candidate.alias === execution.alias,
    );
    if (!entry || entry.status !== "published" || !entry.currency) continue;
    const inputRate = Number(entry.effectiveInputRate);
    const outputRate = Number(entry.effectiveOutputRate);
    totals[entry.currency] +=
      ((initialInput + repairInput) * inputRate + 2 * 4_000 * outputRate) /
      1_000_000;
  }
  return {
    inputTokenUpperBoundInitial: initialInput,
    inputTokenUpperBoundRepair: repairInput,
    outputTokenUpperBoundPerCall: 4_000,
    maximumWireCallCount: manifest.maximumWireCallCount,
    mechanicalHardCeilingCents: manifest.planningHardUpperBound.amountCents,
    perWireCallHardCapCents: manifest.planningHardUpperBound.perWireCallCents,
    expectedCost: "not_known_before_usage",
    conservativeTokenEnvelopeByCurrency: {
      USD: Number(totals.USD.toFixed(6)),
      CNY: Number(totals.CNY.toFixed(6)),
    },
  };
}

export function buildDesignSpecEvidencePreflight(
  input: DesignSpecEvidencePreflightInput,
): DesignSpecEvidencePreflightReport {
  const manifest = assertManifest(input.manifest);
  const declaredManifestSha256 = (
    input.manifest as {
      manifestSha256?: unknown;
    }
  ).manifestSha256;
  const manifestSha256 =
    typeof declaredManifestSha256 === "string" &&
    SHA256.test(declaredManifestSha256)
      ? declaredManifestSha256
      : sha256CanonicalJson(input.manifest);
  const requiredAliases = Object.keys(REQUIRED_GROUP_BY_ALIAS).sort();
  const usage = usageData(input.gatewayUsage);
  const visible = visibleModelIds(input.gatewayModels);
  const limits = usage?.model_limits;
  const allowlist =
    limits && typeof limits === "object" && !Array.isArray(limits)
      ? Object.keys(limits as Record<string, unknown>).sort()
      : [];
  const quotaMode = usage
    ? usage.unlimited_quota === true
      ? "unlimited"
      : usage.unlimited_quota === false
        ? "limited"
        : "unavailable"
    : "unavailable";
  const scopeExact =
    quotaMode === "limited" &&
    usage?.model_limits_enabled === true &&
    JSON.stringify(allowlist) === JSON.stringify(requiredAliases);
  const credential: DesignSpecEvidenceCredentialSnapshot = {
    source: "new_api_read_only_control_plane",
    observedAt: input.capturedAt,
    gatewayOrigin: input.gatewayOrigin,
    credentialMaterial: input.credentialMaterial,
    purpose: "site_builder_model_evaluation",
    observedQuotaMode: quotaMode,
    modelLimitsEnabled: usage ? usage.model_limits_enabled === true : null,
    scopeExact,
    quotaCapPoints: safeInteger(usage?.total_granted),
    remainingQuotaPoints: safeInteger(usage?.total_available),
    observedAllowedAliases: allowlist,
    requiredAllowedAliases: requiredAliases,
    requiredAliasesVisible: requiredAliases.filter((alias) =>
      visible.includes(alias),
    ),
    visibleModelCount: input.gatewayModels ? visible.length : null,
    visibleModelIdsSha256: input.gatewayModels
      ? sha256CanonicalJson(visible)
      : null,
  };
  const channelBinding = channelBindingSnapshot(input.gatewayChannelBinding);
  const entries = priceEntries(
    manifest,
    input.openOxCatalog as OpenOxPricingCatalog | null,
  );
  const selectedPricing = entries.map(
    ({ alias, protocol, groupName, ...entry }) => ({
      alias,
      protocol,
      groupName,
      ...entry,
    }),
  );
  const pricing: DesignSpecEvidencePriceSnapshot = {
    authority: "openox_model_marketplace",
    modelsPage: OPENOX_PRICING_MODELS_PAGE,
    catalogEndpoint: OPENOX_PRICING_CATALOG_URL,
    capturedAt: input.capturedAt,
    httpStatus: input.openOxHttpStatus,
    catalogResponseSha256: input.openOxResponseSha256,
    fullModelCount: input.openOxCatalog
      ? ((
          (input.openOxCatalog as OpenOxPricingCatalog).data?.models as
            unknown[] | undefined
        )?.length ?? null)
      : null,
    fullGroupCount: input.openOxCatalog
      ? ((
          (input.openOxCatalog as OpenOxPricingCatalog).data?.groups as
            unknown[] | undefined
        )?.length ?? null)
      : null,
    selectedPricingSha256: input.openOxCatalog
      ? sha256CanonicalJson(selectedPricing)
      : null,
    entries,
  };
  const blockers: string[] = [];
  if (!scopeExact) blockers.push("CREDENTIAL_NOT_FINITE_EXACT");
  if (!channelBinding.exact) blockers.push("CHANNEL_NOT_EXACT");
  if (entries.some((entry) => entry.status !== "published"))
    blockers.push("OPENOX_PRICE_MISSING");
  if (input.openOxCatalog === null)
    blockers.push("OPENOX_READ_ONLY_FETCH_FAILED");
  const status: DesignSpecEvidencePreflightStatus =
    input.openOxCatalog === null
      ? "BLOCKED_READ_ONLY_PREFLIGHT_UNAVAILABLE"
      : entries.some((entry) => entry.status !== "published")
        ? "BLOCKED_OPENOX_PRICE_MISSING"
        : !scopeExact
          ? "BLOCKED_CREDENTIAL_NOT_FINITE_EXACT"
          : !channelBinding.exact
            ? "BLOCKED_CHANNEL_NOT_EXACT"
            : "READY_FOR_PRODUCT_DECISION";
  const withoutDigest = {
    schemaVersion: DESIGN_SPEC_EVIDENCE_PREFLIGHT_SCHEMA_VERSION,
    preflightId: DESIGN_SPEC_EVIDENCE_PREFLIGHT_ID,
    status,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    fixedSourceCommitSha: manifest.fixedCommitSha,
    manifestSha256,
    suiteId: manifest.suite?.suiteId ?? null,
    sourceBundle: input.sourceBundle,
    readOnlyNetwork: {
      calls: input.readOnlyNetworkCalls,
      modelWireCalls: 0 as const,
      generativeEndpointsCalled: [] as const,
    },
    credential,
    channelBinding,
    pricing,
    estimate: estimateCost(manifest, entries),
    blockers,
    stopConditions: STOP_CONDITIONS,
    actualModelCostCents: 0 as const,
  };
  return { ...withoutDigest, reportSha256: sha256CanonicalJson(withoutDigest) };
}

function markdownRate(
  entry: DesignSpecEvidencePriceSnapshot["entries"][number],
): string {
  return entry.status === "published"
    ? `${entry.currency} ${entry.effectiveInputRate} / ${entry.effectiveOutputRate}`
    : "缺失";
}

export function renderDesignSpecEvidenceDecisionCard(
  report: DesignSpecEvidencePreflightReport,
): string {
  const rows = report.pricing.entries
    .map(
      (entry) =>
        `| \`${entry.alias}\` | ${entry.protocol} | ${entry.groupName} | ${entry.status} | ${markdownRate(entry)} |`,
    )
    .join("\n");
  const allowed =
    report.credential.observedAllowedAliases.length > 0
      ? report.credential.observedAllowedAliases
          .map((alias) => `\`${alias}\``)
          .join(", ")
      : "（空；当前令牌未启用精确模型限制）";
  const channelRows = report.channelBinding.entries
    .map(
      (entry) =>
        `| \`${entry.alias}\` | ${entry.protocol} | Channel ${entry.channelId} | ${entry.channelName} | ${String(entry.enabled)} |`,
    )
    .join("\n");
  const authorizationGate = !report.credential.scopeExact
    ? `The current token is not a finite exact-scope evaluation credential, so no
runtime attestation was created or installed. Create a purpose-specific token
with exactly the three aliases above and a finite cap. Then present a fresh
fee card and request separate explicit authorization before any capability
probe or evidence execution.`
    : report.status !== "READY_FOR_PRODUCT_DECISION"
      ? `The finite exact-scope credential attestation passed, but the blockers
above still prevent a spending decision. No runtime attestation was created or
installed, and model dispatch remains unauthorized.`
      : `The finite exact-scope credential attestation passed. This preflight did
not create or install a runtime attestation and did not authorize model
dispatch. Review this fee card and provide separate explicit authorization
before any capability probe or evidence execution.`;
  return `# design_spec evidence preflight decision card

Date: ${report.pricing.capturedAt}

Status: \`${report.status}\`

Dispatch authorization: \`NOT_AUTHORIZED\`

## Scope

- Fixed evidence source commit: \`${report.fixedSourceCommitSha}\`
- Manifest: \`${report.suiteId ?? "unknown"}\`
- Executions: **73**
- Maximum wire calls: **146**
- Model-generation calls made by this preflight: **0**
- Model fees incurred: **$0.00**
- Read-only control-plane/catalog calls: **${report.readOnlyNetwork.calls}**
- Generative endpoints called: **0**

## OpenOx price snapshot

OpenOx is the sole price authority; new-api prices are not used. Rates below
are native OpenOx units per one million tokens after the selected group
multiplier. Native USD and CNY totals remain separate; this is not FX.

| Alias | Protocol | OpenOx group | Status | Input / output |
| --- | --- | --- | --- | --- |
${rows}

- Catalog response SHA-256: \`${report.pricing.catalogResponseSha256 ?? "unavailable"}\`
- Selected pricing SHA-256: \`${report.pricing.selectedPricingSha256 ?? "unavailable"}\`
- Conservative token envelope: **USD ${report.estimate.conservativeTokenEnvelopeByCurrency.USD} / CNY ${report.estimate.conservativeTokenEnvelopeByCurrency.CNY}**
- Expected final cost: **not known before usage settlement**
- Mechanical hard ceiling: **${report.estimate.mechanicalHardCeilingCents}¢ ($${(report.estimate.mechanicalHardCeilingCents / 100).toFixed(2)})**; not approved spend

## Credential attestation

- Purpose: \`${report.credential.purpose}\`
- Credential material: not persisted (raw value and derived identifier are excluded)
- Observed quota mode: \`${report.credential.observedQuotaMode}\`
- Model limits enabled: \`${String(report.credential.modelLimitsEnabled)}\`
- Exact scope: \`${String(report.credential.scopeExact)}\`
- Observed allowed aliases: ${allowed}
- Granted quota points: \`${String(report.credential.quotaCapPoints)}\`; remaining: \`${String(report.credential.remainingQuotaPoints)}\`

## Exact channel binding

- Dedicated group: \`${report.channelBinding.group ?? "unavailable"}\`
- Group ratio: \`${String(report.channelBinding.groupRatio)}\`
- Cross-group retry: \`${String(report.channelBinding.crossGroupRetry)}\`
- Exact one-channel-per-alias binding: \`${String(report.channelBinding.exact)}\`
- Credential material: not persisted

| Alias | Protocol | Channel | Reviewed channel name | Enabled |
| --- | --- | --- | --- | --- |
${channelRows || "| unavailable | unavailable | unavailable | unavailable | false |"}

## Blockers and authorization gate

${report.blockers.length > 0 ? report.blockers.map((blocker) => `- \`${blocker}\``).join("\n") : "- None"}

${authorizationGate}

Report SHA-256: \`${report.reportSha256}\`
`;
}

export function preflightRequiredAliases(): readonly string[] {
  return Object.freeze(Object.keys(REQUIRED_GROUP_BY_ALIAS).sort());
}
