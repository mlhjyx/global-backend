import { canonicalDigest } from "../../model-runtime/context-engine";
import { OPENOX_PRICING_AUTHORITY } from "../site-builder-model-settlement";
import {
  COPY_SONNET_RECOVERY_EXECUTION,
  COPY_SONNET_RECOVERY_PLAN,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
} from "./copy-sonnet-recovery-contract";

export const COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-zero-call-preflight-v19.json" as const;
export const COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION =
  "site-builder-copy-sonnet-recovery-zero-call-preflight/2026-08-10-v19-v1" as const;
export const COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID =
  "site-builder-copy-sonnet-recovery-zero-call-preflight/2026-08-10-v19-v1" as const;
export const COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE =
  "site_builder_copy_sonnet_recovery" as const;
export const COPY_SONNET_RECOVERY_OPENOX_GROUP = "special" as const;
export const COPY_SONNET_RECOVERY_OPENOX_BASE_URL =
  "https://openox.tech" as const;
export const COPY_SONNET_RECOVERY_NEW_API_CHANNEL_TYPE = 14 as const;
export const COPY_SONNET_RECOVERY_TRANSPORT_PROTOCOL =
  "anthropic-messages" as const;
export const COPY_SONNET_RECOVERY_MAXIMUM_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const COPY_SONNET_RECOVERY_MAXIMUM_INPUT_TOKENS_PER_WIRE =
  65_536 + 4_096;
export const COPY_SONNET_RECOVERY_MAXIMUM_OUTPUT_TOKENS_PER_WIRE = 1_200;
export const COPY_SONNET_RECOVERY_QUOTA_PER_NATIVE_UNIT = 500_000;
export const COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_FILE_SHA256 =
  "a0b04862b538ae601b352a37d42eb8999ab67011d712d7d4dd765e6fa27ff6af";
export const COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_ARTIFACT_DIGEST =
  "8a0b7c678026986d15cb4a4c953a50f100cbd48649671d8dbba64f9a87951cd0";
export const COPY_SONNET_RECOVERY_EXPECTED_COMPILED_ARTIFACT_TREE_DIGEST =
  "44e10f98e18a52d420e753b6be737acc1f5297908820f8809b00356bb2cd5afe";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;

export interface CopySonnetRecoveryObservedRequest {
  method: string;
  authority: "new_api_admin" | "new_api_bearer" | "tool_broker";
  path: string;
}

export interface CopySonnetRecoveryZeroCallPreflightArtifact {
  schemaVersion: typeof COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION;
  artifactId: typeof COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID;
  classification: "CONTROL_PLANE_ATTESTATION_ONLY";
  executionHeadCommit: string;
  capturedAt: string;
  preflightOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedModelWireCalls: 0;
  observedModelCost: { CNY: 0; USD: 0 };
  runtimeBinding: {
    path: typeof COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH;
    fileSha256: string;
    artifactDigest: string;
    compiledArtifactTreeDigest: string;
  };
  credential: {
    purpose: typeof COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE;
    tokenId: number;
    bearerTokenSha256: string;
    createdAt: string;
    expiresAt: string;
    quotaMode: "limited";
    quotaCapPoints: number;
    remainingQuotaPoints: number;
    maximumQuotaPointsPerWire: number;
  };
  executionScope: {
    taskId: typeof COPY_SONNET_RECOVERY_PLAN.taskId;
    alias: typeof COPY_SONNET_RECOVERY_EXECUTION.alias;
    protocol: typeof COPY_SONNET_RECOVERY_EXECUTION.protocol;
    transportProtocol: typeof COPY_SONNET_RECOVERY_TRANSPORT_PROTOCOL;
    reasoning: typeof COPY_SONNET_RECOVERY_EXECUTION.reasoning;
    maximumExecutions: 1;
    maximumWireCalls: 2;
    maximumRepairCallsPerExecution: 1;
  };
  route: {
    channelId: number;
    channelName: string;
    channelType: typeof COPY_SONNET_RECOVERY_NEW_API_CHANNEL_TYPE;
    baseUrl: typeof COPY_SONNET_RECOVERY_OPENOX_BASE_URL;
    modelMapping: "IDENTITY";
    upstreamModelId: typeof COPY_SONNET_RECOVERY_EXECUTION.alias;
    group: typeof COPY_SONNET_RECOVERY_OPENOX_GROUP;
  };
  pricing: {
    authority: typeof OPENOX_PRICING_AUTHORITY.provider;
    origin: typeof OPENOX_PRICING_AUTHORITY.origin;
    catalogEndpoint: typeof OPENOX_PRICING_AUTHORITY.catalogEndpoint;
    catalogResponseSha256: string;
    snapshotSha256: string;
    pricingVersion: string;
    currency: "USD";
    inputPriceMicrounitsPerMillionTokens: number;
    outputPriceMicrounitsPerMillionTokens: number;
    cacheReadPriceMicrounitsPerMillionTokens: number;
    cacheWritePriceMicrounitsPerMillionTokens: number;
    maximumInputTokensPerWire: number;
    maximumOutputTokensPerWire: number;
    maximumNativeCostMicrounitsPerWire: number;
    maximumNativeCostMicrounits: number;
    quotaPerNativeUnit: number;
  };
  settlement: {
    status: "READY_FOR_REQUEST_BOUND_OBSERVATION";
    logEndpoint: "/api/log/token";
    requestIdentityHeader: "x-oneapi-request-id";
    zeroCallLogShapeObserved: true;
    futurePhysicalCallSettlement: "UNPROVEN_UNTIL_SEPARATELY_AUTHORIZED_DISPATCH";
  };
  controlPlaneObservation: {
    observedNetworkCalls: number;
    requests: CopySonnetRecoveryObservedRequest[];
    prohibitedModelEndpointCalls: 0;
  };
  requiredFollowup: readonly [
    "SEPARATE_V19_DISPATCH_AUTHORIZATION",
    "REQUEST_BOUND_SETTLEMENT_PER_PHYSICAL_WIRE",
    "GIT_REVIEWED_CAPABILITY_EVIDENCE",
  ];
  artifactDigest: string;
}

function fail(): never {
  throw new Error("COPY_SONNET_RECOVERY_ZERO_CALL_ARTIFACT_INVALID");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

export function copySonnetRecoveryMaximumNativeCostPerWire(
  inputPriceMicrounitsPerMillionTokens: number,
  outputPriceMicrounitsPerMillionTokens: number,
  cacheReadPriceMicrounitsPerMillionTokens: number,
  cacheWritePriceMicrounitsPerMillionTokens: number,
): number {
  const maximumInputSidePrice = Math.max(
    inputPriceMicrounitsPerMillionTokens,
    cacheReadPriceMicrounitsPerMillionTokens,
    cacheWritePriceMicrounitsPerMillionTokens,
  );
  const numerator =
    COPY_SONNET_RECOVERY_MAXIMUM_INPUT_TOKENS_PER_WIRE * maximumInputSidePrice +
    COPY_SONNET_RECOVERY_MAXIMUM_OUTPUT_TOKENS_PER_WIRE *
      outputPriceMicrounitsPerMillionTokens;
  const result = Math.ceil(numerator / 1_000_000);
  if (!Number.isSafeInteger(result) || result <= 0) fail();
  return result;
}

export function copySonnetRecoveryQuotaPoints(
  nativeCostMicrounits: number,
): number {
  const result = Math.ceil(
    (nativeCostMicrounits * COPY_SONNET_RECOVERY_QUOTA_PER_NATIVE_UNIT) /
      1_000_000,
  );
  if (!Number.isSafeInteger(result) || result <= 0) fail();
  return result;
}

function containsForbiddenSecret(value: unknown, key = ""): boolean {
  const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
  if (
    ["apikey", "adminaccesstoken", "bearertoken", "secret"].includes(
      normalizedKey,
    )
  ) {
    return true;
  }
  if (typeof value === "string") return /^sk-/u.test(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenSecret(entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([entryKey, entry]) => containsForbiddenSecret(entry, entryKey),
    );
  }
  return false;
}

function exactArtifactKeys(
  artifact: CopySonnetRecoveryZeroCallPreflightArtifact,
): boolean {
  return (
    exactKeys(artifact, [
      "schemaVersion",
      "artifactId",
      "classification",
      "executionHeadCommit",
      "capturedAt",
      "preflightOnly",
      "dispatchAuthorization",
      "dispatchCapable",
      "observedModelWireCalls",
      "observedModelCost",
      "runtimeBinding",
      "credential",
      "executionScope",
      "route",
      "pricing",
      "settlement",
      "controlPlaneObservation",
      "requiredFollowup",
      "artifactDigest",
    ]) &&
    exactKeys(artifact.observedModelCost, ["CNY", "USD"]) &&
    exactKeys(artifact.runtimeBinding, [
      "path",
      "fileSha256",
      "artifactDigest",
      "compiledArtifactTreeDigest",
    ]) &&
    exactKeys(artifact.credential, [
      "purpose",
      "tokenId",
      "bearerTokenSha256",
      "createdAt",
      "expiresAt",
      "quotaMode",
      "quotaCapPoints",
      "remainingQuotaPoints",
      "maximumQuotaPointsPerWire",
    ]) &&
    exactKeys(artifact.executionScope, [
      "taskId",
      "alias",
      "protocol",
      "transportProtocol",
      "reasoning",
      "maximumExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
    ]) &&
    exactKeys(artifact.route, [
      "channelId",
      "channelName",
      "channelType",
      "baseUrl",
      "modelMapping",
      "upstreamModelId",
      "group",
    ]) &&
    exactKeys(artifact.pricing, [
      "authority",
      "origin",
      "catalogEndpoint",
      "catalogResponseSha256",
      "snapshotSha256",
      "pricingVersion",
      "currency",
      "inputPriceMicrounitsPerMillionTokens",
      "outputPriceMicrounitsPerMillionTokens",
      "cacheReadPriceMicrounitsPerMillionTokens",
      "cacheWritePriceMicrounitsPerMillionTokens",
      "maximumInputTokensPerWire",
      "maximumOutputTokensPerWire",
      "maximumNativeCostMicrounitsPerWire",
      "maximumNativeCostMicrounits",
      "quotaPerNativeUnit",
    ]) &&
    exactKeys(artifact.settlement, [
      "status",
      "logEndpoint",
      "requestIdentityHeader",
      "zeroCallLogShapeObserved",
      "futurePhysicalCallSettlement",
    ]) &&
    exactKeys(artifact.controlPlaneObservation, [
      "observedNetworkCalls",
      "requests",
      "prohibitedModelEndpointCalls",
    ])
  );
}

export function validateCopySonnetRecoveryZeroCallPreflightArtifact(
  value: unknown,
): asserts value is CopySonnetRecoveryZeroCallPreflightArtifact {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      containsForbiddenSecret(value)
    ) {
      fail();
    }
    const artifact = value as CopySonnetRecoveryZeroCallPreflightArtifact;
    if (!exactArtifactKeys(artifact)) fail();
    const { artifactDigest, ...withoutDigest } = artifact;
    const captured = Date.parse(artifact.capturedAt);
    const expires = Date.parse(artifact.credential.expiresAt);
    const created = Date.parse(artifact.credential.createdAt);
    const expectedPerWire = copySonnetRecoveryMaximumNativeCostPerWire(
      artifact.pricing.inputPriceMicrounitsPerMillionTokens,
      artifact.pricing.outputPriceMicrounitsPerMillionTokens,
      artifact.pricing.cacheReadPriceMicrounitsPerMillionTokens,
      artifact.pricing.cacheWritePriceMicrounitsPerMillionTokens,
    );
    const expectedQuotaPerWire = copySonnetRecoveryQuotaPoints(expectedPerWire);
    const observationsValid = artifact.controlPlaneObservation.requests.every(
      (request) => {
        const { authority, method, path } = request;
        return (
          exactKeys(request, ["method", "authority", "path"]) &&
          ["new_api_admin", "new_api_bearer", "tool_broker"].includes(
            authority,
          ) &&
          ["GET", "POST"].includes(method) &&
          (authority !== "tool_broker" ||
            path === OPENOX_PRICING_AUTHORITY.catalogEndpoint) &&
          (authority !== "new_api_bearer" ||
            ["/api/usage/token/", "/v1/models", "/api/log/token"].includes(
              path,
            )) &&
          (authority !== "new_api_admin" ||
            ["/api/channel/", "/api/token/"].includes(path) ||
            /^\/api\/token\/[1-9][0-9]*\/key$/u.test(path))
        );
      },
    );
    const countObservation = (
      authority: CopySonnetRecoveryObservedRequest["authority"],
      method: string,
      path: string | RegExp,
    ): number =>
      artifact.controlPlaneObservation.requests.filter(
        (request) =>
          request.authority === authority &&
          request.method === method &&
          (typeof path === "string"
            ? request.path === path
            : path.test(request.path)),
      ).length;
    const observationsComplete =
      countObservation("new_api_admin", "GET", "/api/channel/") >= 2 &&
      countObservation("new_api_admin", "GET", "/api/token/") >= 3 &&
      countObservation("new_api_admin", "POST", "/api/token/") === 1 &&
      countObservation(
        "new_api_admin",
        "POST",
        /^\/api\/token\/[1-9][0-9]*\/key$/u,
      ) === 1 &&
      countObservation("new_api_bearer", "GET", "/api/usage/token/") === 1 &&
      countObservation("new_api_bearer", "GET", "/v1/models") === 1 &&
      countObservation("new_api_bearer", "GET", "/api/log/token") === 1 &&
      countObservation(
        "tool_broker",
        "GET",
        OPENOX_PRICING_AUTHORITY.catalogEndpoint,
      ) === 2;
    if (
      artifact.schemaVersion !==
        COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION ||
      artifact.artifactId !==
        COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID ||
      artifact.classification !== "CONTROL_PLANE_ATTESTATION_ONLY" ||
      !GIT_COMMIT.test(artifact.executionHeadCommit) ||
      !Number.isFinite(captured) ||
      new Date(captured).toISOString() !== artifact.capturedAt ||
      artifact.preflightOnly !== true ||
      artifact.dispatchAuthorization !== "NOT_AUTHORIZED" ||
      artifact.dispatchCapable !== false ||
      artifact.observedModelWireCalls !== 0 ||
      artifact.observedModelCost.CNY !== 0 ||
      artifact.observedModelCost.USD !== 0 ||
      artifact.runtimeBinding.path !==
        COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH ||
      artifact.runtimeBinding.fileSha256 !==
        COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_FILE_SHA256 ||
      artifact.runtimeBinding.artifactDigest !==
        COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_ARTIFACT_DIGEST ||
      artifact.runtimeBinding.compiledArtifactTreeDigest !==
        COPY_SONNET_RECOVERY_EXPECTED_COMPILED_ARTIFACT_TREE_DIGEST ||
      artifact.credential.purpose !== COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE ||
      !Number.isSafeInteger(artifact.credential.tokenId) ||
      artifact.credential.tokenId <= 0 ||
      !SHA256.test(artifact.credential.bearerTokenSha256) ||
      !Number.isFinite(created) ||
      !Number.isFinite(expires) ||
      new Date(created).toISOString() !== artifact.credential.createdAt ||
      new Date(expires).toISOString() !== artifact.credential.expiresAt ||
      created !== captured ||
      expires <= created ||
      expires - created > COPY_SONNET_RECOVERY_MAXIMUM_LIFETIME_MS ||
      artifact.credential.quotaMode !== "limited" ||
      artifact.executionScope.taskId !== COPY_SONNET_RECOVERY_PLAN.taskId ||
      artifact.executionScope.alias !== COPY_SONNET_RECOVERY_EXECUTION.alias ||
      artifact.executionScope.protocol !==
        COPY_SONNET_RECOVERY_EXECUTION.protocol ||
      artifact.executionScope.transportProtocol !==
        COPY_SONNET_RECOVERY_TRANSPORT_PROTOCOL ||
      artifact.executionScope.reasoning !==
        COPY_SONNET_RECOVERY_EXECUTION.reasoning ||
      artifact.executionScope.maximumExecutions !== 1 ||
      artifact.executionScope.maximumWireCalls !== 2 ||
      artifact.executionScope.maximumRepairCallsPerExecution !== 1 ||
      !Number.isSafeInteger(artifact.route.channelId) ||
      artifact.route.channelId <= 0 ||
      !artifact.route.channelName ||
      artifact.route.channelType !==
        COPY_SONNET_RECOVERY_NEW_API_CHANNEL_TYPE ||
      artifact.route.baseUrl !== COPY_SONNET_RECOVERY_OPENOX_BASE_URL ||
      artifact.route.modelMapping !== "IDENTITY" ||
      artifact.route.upstreamModelId !== COPY_SONNET_RECOVERY_EXECUTION.alias ||
      artifact.route.group !== COPY_SONNET_RECOVERY_OPENOX_GROUP ||
      artifact.pricing.authority !== OPENOX_PRICING_AUTHORITY.provider ||
      artifact.pricing.origin !== OPENOX_PRICING_AUTHORITY.origin ||
      artifact.pricing.catalogEndpoint !==
        OPENOX_PRICING_AUTHORITY.catalogEndpoint ||
      artifact.pricing.currency !== "USD" ||
      !SHA256.test(artifact.pricing.catalogResponseSha256) ||
      !SHA256.test(artifact.pricing.snapshotSha256) ||
      !SHA256.test(artifact.pricing.pricingVersion) ||
      !Number.isSafeInteger(
        artifact.pricing.inputPriceMicrounitsPerMillionTokens,
      ) ||
      artifact.pricing.inputPriceMicrounitsPerMillionTokens <= 0 ||
      !Number.isSafeInteger(
        artifact.pricing.outputPriceMicrounitsPerMillionTokens,
      ) ||
      artifact.pricing.outputPriceMicrounitsPerMillionTokens <= 0 ||
      !Number.isSafeInteger(
        artifact.pricing.cacheReadPriceMicrounitsPerMillionTokens,
      ) ||
      artifact.pricing.cacheReadPriceMicrounitsPerMillionTokens < 0 ||
      !Number.isSafeInteger(
        artifact.pricing.cacheWritePriceMicrounitsPerMillionTokens,
      ) ||
      artifact.pricing.cacheWritePriceMicrounitsPerMillionTokens < 0 ||
      artifact.pricing.maximumInputTokensPerWire !==
        COPY_SONNET_RECOVERY_MAXIMUM_INPUT_TOKENS_PER_WIRE ||
      artifact.pricing.maximumOutputTokensPerWire !==
        COPY_SONNET_RECOVERY_MAXIMUM_OUTPUT_TOKENS_PER_WIRE ||
      artifact.pricing.maximumNativeCostMicrounitsPerWire !== expectedPerWire ||
      artifact.pricing.maximumNativeCostMicrounits !== expectedPerWire * 2 ||
      artifact.pricing.quotaPerNativeUnit !==
        COPY_SONNET_RECOVERY_QUOTA_PER_NATIVE_UNIT ||
      artifact.credential.maximumQuotaPointsPerWire !== expectedQuotaPerWire ||
      artifact.credential.quotaCapPoints !== expectedQuotaPerWire * 2 ||
      artifact.credential.remainingQuotaPoints !==
        artifact.credential.quotaCapPoints ||
      artifact.settlement.status !== "READY_FOR_REQUEST_BOUND_OBSERVATION" ||
      artifact.settlement.logEndpoint !== "/api/log/token" ||
      artifact.settlement.requestIdentityHeader !== "x-oneapi-request-id" ||
      artifact.settlement.zeroCallLogShapeObserved !== true ||
      artifact.settlement.futurePhysicalCallSettlement !==
        "UNPROVEN_UNTIL_SEPARATELY_AUTHORIZED_DISPATCH" ||
      artifact.controlPlaneObservation.prohibitedModelEndpointCalls !== 0 ||
      artifact.controlPlaneObservation.observedNetworkCalls !==
        artifact.controlPlaneObservation.requests.length ||
      !observationsValid ||
      !observationsComplete ||
      JSON.stringify(artifact.requiredFollowup) !==
        JSON.stringify([
          "SEPARATE_V19_DISPATCH_AUTHORIZATION",
          "REQUEST_BOUND_SETTLEMENT_PER_PHYSICAL_WIRE",
          "GIT_REVIEWED_CAPABILITY_EVIDENCE",
        ]) ||
      !SHA256.test(artifactDigest) ||
      artifactDigest !== canonicalDigest(withoutDigest)
    ) {
      fail();
    }
  } catch {
    fail();
  }
}
