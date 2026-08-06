import { createHash } from "node:crypto";

import { AiSdkAnthropicMessagesAdapter } from "../../model-runtime/adapters/ai-sdk-anthropic-messages.adapter";
import { AiSdkOpenAiResponsesAdapter } from "../../model-runtime/adapters/ai-sdk-openai-responses.adapter";
import { NewApiRequestBoundSettlementResolver } from "../../model-gateway/new-api-request-bound-settlement";
import type {
  NewApiRequestBoundSettlement,
  NewApiRequestBoundSettlementInput,
} from "../../model-gateway/new-api-request-bound-settlement";
import { canonicalDigest } from "../../model-runtime/context-engine";
import type {
  NativeModelAdapterRequest,
  NativeModelAdapterResult,
} from "../../model-runtime/adapters/ai-sdk-native-adapter.contract";
import type { ModelProtocol } from "../../model-runtime/types";
import {
  validateCopyRealCapabilityAdmissionEnvelope,
  type CopyPilotCredentialAttestation,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";

const MAXIMUM_CONTROL_PLANE_BYTES = 1024 * 1024;

interface TrustedGatewayState {
  admission: CopyRealCapabilityAdmissionInput;
  bearerToken: string;
  settlements: WeakMap<object, CopyPilotTrustedSettlementProof>;
}

export interface CopyPilotTrustedGateway {
  readonly __opaque?: never;
}

export interface CopyPilotTrustedGatewayBindings {
  execute<Output>(
    protocol: "openai_responses" | "anthropic_messages",
    request: NativeModelAdapterRequest,
  ): Promise<NativeModelAdapterResult<Output>>;
  resolve(
    input: NewApiRequestBoundSettlementInput,
  ): Promise<NewApiRequestBoundSettlement>;
  trustedSettlementProof(
    value: unknown,
  ): CopyPilotTrustedSettlementProof | undefined;
  channelIdFor(alias: string, protocol: ModelProtocol): number;
}

export interface CopyPilotTrustedSettlementProof {
  requestId: string;
  alias: string;
  protocol: string;
  channelId: number;
  quota: number;
  inputTokens: number;
  outputTokens: number;
  receiptDigest: string;
  resolverId: string;
  gatewayOrigin: string;
  bearerTokenSha256: string;
  credentialAttestationDigest: string;
  globalAuthorizationDigest: string;
  childAuthorizationDigest: string;
  executionKey: string;
}

export interface CopyPilotTrustedAdmissionBinding {
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  globalAuthorizationDigest: string;
  childAuthorizationDigest: string;
  executionKey: string;
  childCampaignId: string;
  childAuthorizationId: string;
  childReservationId: string;
  gatewayOrigin: string;
}

const TRUSTED_GATEWAYS = new WeakMap<object, TrustedGatewayState>();

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function canonicalOrigin(value: string): string {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    fail("COPY_PILOT_GATEWAY_ORIGIN_INVALID");
  }
  return parsed.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared != null) {
    const size = Number(declared);
    if (!safeInteger(size, 0) || size > MAXIMUM_CONTROL_PLANE_BYTES) {
      fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
    }
  }
  if (!response.body) fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAXIMUM_CONTROL_PLANE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
  }
}

async function getJson(
  origin: string,
  path: string,
  bearerToken: string,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal,
    });
  } catch {
    return fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
  }
  if (!response.ok) fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
  return boundedJson(response);
}

function stateFor(handle: CopyPilotTrustedGateway): TrustedGatewayState {
  const state = TRUSTED_GATEWAYS.get(handle);
  if (!state) fail("COPY_PILOT_TRUSTED_GATEWAY_REQUIRED");
  return state;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

async function verifyLiveScopeAndQuota(
  state: TrustedGatewayState,
  initial: boolean,
): Promise<void> {
  const origin = canonicalOrigin(state.admission.credential.gatewayOrigin);
  const signal = AbortSignal.timeout(10_000);
  const usageBody = await getJson(
    origin,
    "/api/usage/token",
    state.bearerToken,
    signal,
  );
  const usage = ((usageBody as { data?: unknown })?.data ??
    usageBody) as Record<string, unknown>;
  const expectedAliases = state.admission.credential.executions
    .map(({ alias }) => alias)
    .sort();
  const liveAliases =
    usage.model_limits &&
    typeof usage.model_limits === "object" &&
    !Array.isArray(usage.model_limits)
      ? Object.keys(usage.model_limits as Record<string, unknown>).sort()
      : [];
  const liveModelLimits = usage.model_limits as
    Record<string, unknown> | undefined;
  if (
    usage.unlimited_quota !== false ||
    usage.model_limits_enabled !== true ||
    JSON.stringify(liveAliases) !== JSON.stringify(expectedAliases) ||
    expectedAliases.some((alias) => liveModelLimits?.[alias] !== true) ||
    usage.total_granted !== state.admission.credential.quotaCapPoints ||
    !safeInteger(usage.total_available, 1) ||
    (initial &&
      Number(usage.total_available) !==
        state.admission.credential.remainingQuotaPoints) ||
    Number(usage.total_available) >
      state.admission.credential.remainingQuotaPoints ||
    Number(usage.total_available) <
      state.admission.credential.remainingQuotaPoints -
        state.admission.credential.reservedQuotaPoints
  ) {
    fail("COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH");
  }

  const modelCatalog = (await getJson(
    origin,
    "/v1/models",
    state.bearerToken,
    signal,
  )) as { data?: unknown };
  const modelEntries = Array.isArray(modelCatalog.data)
    ? modelCatalog.data
    : [];
  const modelIds = modelEntries
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string")
    .sort();
  if (
    modelIds.length !== modelEntries.length ||
    JSON.stringify(modelIds) !== JSON.stringify(expectedAliases)
  ) {
    fail("COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH");
  }
  if (
    signal.aborted ||
    Date.parse(state.admission.credential.expiresAt) <= Date.now()
  ) {
    fail("COPY_PILOT_LIVE_PREFLIGHT_UNAVAILABLE");
  }
}

export async function createCopyPilotTrustedGateway(input: {
  admission: CopyRealCapabilityAdmissionInput;
  bearerToken: string;
}): Promise<CopyPilotTrustedGateway> {
  validateCopyRealCapabilityAdmissionEnvelope(input.admission);
  if (
    input.bearerToken.length < 16 ||
    sha256(input.bearerToken) !== input.admission.credential.bearerTokenSha256
  ) {
    fail("COPY_PILOT_CREDENTIAL_TOKEN_MISMATCH");
  }
  canonicalOrigin(input.admission.credential.gatewayOrigin);
  const state: TrustedGatewayState = {
    admission: deepFreeze(structuredClone(input.admission)),
    bearerToken: input.bearerToken,
    settlements: new WeakMap(),
  };
  await verifyLiveScopeAndQuota(state, true);

  const handle = Object.freeze({}) as CopyPilotTrustedGateway;
  TRUSTED_GATEWAYS.set(handle, state);
  return handle;
}

export function getCopyPilotTrustedCredentialAttestation(
  handle: CopyPilotTrustedGateway,
): CopyPilotCredentialAttestation | undefined {
  return TRUSTED_GATEWAYS.get(handle)?.admission.credential;
}

export function getCopyPilotTrustedAdmissionBinding(
  handle: CopyPilotTrustedGateway,
): CopyPilotTrustedAdmissionBinding | undefined {
  const state = TRUSTED_GATEWAYS.get(handle);
  if (!state) return undefined;
  return Object.freeze({
    manifestDigest: canonicalDigest(state.admission.manifest),
    credentialAttestationDigest: canonicalDigest(state.admission.credential),
    settlementObserverDigest: canonicalDigest(state.admission.settlement),
    globalAuthorizationDigest: canonicalDigest(state.admission.authorization),
    childAuthorizationDigest: canonicalDigest(
      state.admission.childAuthorization,
    ),
    executionKey: state.admission.selectedExecutionKey,
    childCampaignId: state.admission.childAuthorization.campaignId,
    childAuthorizationId: state.admission.childAuthorization.authorizationId,
    childReservationId: state.admission.childAuthorization.reservationId,
    gatewayOrigin: state.admission.credential.gatewayOrigin,
  });
}

export async function assertCopyPilotTrustedGatewayCurrent(
  handle: CopyPilotTrustedGateway,
): Promise<void> {
  const state = stateFor(handle);
  validateCopyRealCapabilityAdmissionEnvelope(state.admission);
  if (
    sha256(state.bearerToken) !== state.admission.credential.bearerTokenSha256
  ) {
    fail("COPY_PILOT_CREDENTIAL_TOKEN_MISMATCH");
  }
  await verifyLiveScopeAndQuota(state, false);
}

export function createCopyPilotTrustedGatewayBindings(
  handle: CopyPilotTrustedGateway,
): CopyPilotTrustedGatewayBindings {
  const state = stateFor(handle);
  const origin = canonicalOrigin(state.admission.credential.gatewayOrigin);
  const adapterSettings = Object.freeze({
    baseUrl: `${origin}/v1`,
    canonicalGatewayBaseUrl: `${origin}/v1`,
    apiKey: state.bearerToken,
  });
  const channels = new Map(
    state.admission.credential.channels.map((entry) => [
      `${entry.alias}:${entry.protocol}`,
      entry.channelId,
    ]),
  );
  const adapters = Object.freeze({
    openai_responses: new AiSdkOpenAiResponsesAdapter(adapterSettings),
    anthropic_messages: new AiSdkAnthropicMessagesAdapter(adapterSettings),
  });
  const resolver = new NewApiRequestBoundSettlementResolver({
    gatewayOrigin: origin,
    apiKey: state.bearerToken,
    resolverId: state.admission.settlement.resolverId,
    maximumPollDurationMs: state.admission.settlement.maximumPollDurationMs,
  });
  const selected = state.admission.authorization.children.find(
    ({ executionKey }) => executionKey === state.admission.selectedExecutionKey,
  );
  if (!selected) fail("COPY_PILOT_CHILD_SCOPE_MISMATCH");
  return Object.freeze({
    execute: <Output>(
      protocol: "openai_responses" | "anthropic_messages",
      request: NativeModelAdapterRequest,
    ) => {
      if (protocol !== selected.protocol || request.alias !== selected.alias) {
        return fail("COPY_PILOT_CHILD_SCOPE_MISMATCH");
      }
      return adapters[protocol].execute<Output>(request);
    },
    resolve: async (input: NewApiRequestBoundSettlementInput) => {
      const settlement = await resolver.resolve(input);
      if (settlement.status === "settled") {
        state.settlements.set(
          settlement,
          Object.freeze({
            requestId: settlement.requestId,
            alias: settlement.alias,
            protocol: settlement.protocol,
            channelId: settlement.channelId,
            quota: settlement.quota,
            inputTokens: settlement.inputTokens,
            outputTokens: settlement.outputTokens,
            receiptDigest: settlement.receiptDigest,
            resolverId: settlement.resolverId,
            gatewayOrigin: state.admission.credential.gatewayOrigin,
            bearerTokenSha256: state.admission.credential.bearerTokenSha256,
            credentialAttestationDigest: canonicalDigest(
              state.admission.credential,
            ),
            globalAuthorizationDigest: canonicalDigest(
              state.admission.authorization,
            ),
            childAuthorizationDigest: canonicalDigest(
              state.admission.childAuthorization,
            ),
            executionKey: state.admission.selectedExecutionKey,
          }),
        );
      }
      return settlement;
    },
    trustedSettlementProof: (value: unknown) =>
      typeof value === "object" && value !== null
        ? state.settlements.get(value)
        : undefined,
    channelIdFor: (alias: string, protocol: ModelProtocol) => {
      if (alias !== selected.alias || protocol !== selected.protocol) {
        fail("COPY_PILOT_CHILD_SCOPE_MISMATCH");
      }
      const channelId = channels.get(`${alias}:${protocol}`);
      if (channelId == null) fail("COPY_PILOT_CHANNEL_BINDING_MISSING");
      return channelId;
    },
  });
}
