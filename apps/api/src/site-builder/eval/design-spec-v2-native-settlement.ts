import { createHash } from "node:crypto";

import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  isTrustedNativeModelEvaluationCostSafetyAttestation,
  nativePicoUnitsForModelEvaluationUsage,
  type NativeModelEvaluationCostSafetyAttestation,
  type NativeModelEvaluationCostSettlement,
} from "./model-evaluation-native-cost-safety";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/;
const MAX_LOG_RESPONSE_BYTES = 1_048_576;

type NativeTargetProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

export interface DesignSpecV2NativeSettlementRoute {
  alias: string;
  protocol: NativeTargetProtocol;
  channelId: number;
}

export interface DesignSpecV2NativeWireObservation {
  wireAttempt: "initial" | "repair";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DesignSpecV2NativeSettlementResolver {
  readonly resolverId: "new-api-token-log-native-openox/v1";
  resolve(input: {
    executionId: string;
    alias: string;
    protocol: NativeTargetProtocol;
    wires: readonly DesignSpecV2NativeWireObservation[];
  }): Promise<NativeModelEvaluationCostSettlement>;
}

export interface CapturedDesignSpecV2NativeRequestIds {
  readonly fetch: typeof fetch;
}

interface CapturedNativeWireRequest {
  requestId: string;
  alias: string;
  protocol: NativeTargetProtocol;
}

interface NativeRequestIdCaptureState {
  attestation: NativeModelEvaluationCostSafetyAttestation;
  requestIdsByExecution: Map<string, CapturedNativeWireRequest[]>;
}

const REQUEST_ID_CAPTURE_STATES = new WeakMap<
  object,
  NativeRequestIdCaptureState
>();

interface NewApiLogRow {
  request_id?: unknown;
  type?: unknown;
  model_name?: unknown;
  channel?: unknown;
  group?: unknown;
  quota?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

function dispatchKey(value: {
  alias: string;
  protocol: NativeTargetProtocol;
}): string {
  return `${value.alias}:${value.protocol}`;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function unknownSettlement(): Extract<
  NativeModelEvaluationCostSettlement,
  { state: "unknown" }
> {
  return { state: "unknown", reason: "invalid_settlement" };
}

function requestExecutionId(request: Request): string | null {
  const value = request.headers.get("x-site-builder-evaluation-execution-id");
  return value && EXECUTION_ID.test(value) ? value : null;
}

async function verifiedWireRequest(
  request: Request,
  attestation: NativeModelEvaluationCostSafetyAttestation,
  bearerToken: string,
): Promise<
  | {
      executionId: string;
      alias: string;
      protocol: NativeTargetProtocol;
    }
  | null
> {
  const executionId = requestExecutionId(request);
  if (
    !executionId ||
    request.method !== "POST" ||
    request.headers.get("authorization") !== `Bearer ${bearerToken}`
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin !== attestation.credential.gatewayOrigin || url.search) {
    return null;
  }
  let payload: { model?: unknown };
  try {
    payload = JSON.parse(await request.clone().text()) as { model?: unknown };
  } catch {
    return null;
  }
  if (!payload || typeof payload.model !== "string") return null;
  const dispatch = attestation.credential.allowedDispatches.find(
    (entry) => entry.alias === payload.model,
  );
  if (
    !dispatch ||
    (dispatch.protocol !== "openai-responses" &&
      dispatch.protocol !== "anthropic-messages") ||
    url.pathname !==
      (dispatch.protocol === "openai-responses" ? "/v1/responses" : "/v1/messages")
  ) {
    return null;
  }
  return {
    executionId,
    alias: dispatch.alias,
    protocol: dispatch.protocol,
  };
}

/**
 * Captures only the gateway request id that binds a future wire response to a
 * token-scoped settlement row. It does not inspect or buffer model content.
 */
export function createDesignSpecV2NativeRequestIdCapturingFetch(
  options: {
    attestation: NativeModelEvaluationCostSafetyAttestation;
    gatewayOrigin: string;
    bearerToken: string;
    fetch: typeof fetch;
  },
): CapturedDesignSpecV2NativeRequestIds {
  const attestation = requireCredential(options);
  const bearerToken = options.bearerToken;
  const captured = new Map<string, CapturedNativeWireRequest[]>();
  const boundFetch = options.fetch.bind(globalThis);
  const wrapped = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let verified: Awaited<ReturnType<typeof verifiedWireRequest>> = null;
    try {
      verified = await verifiedWireRequest(
        new Request(input, init),
        attestation,
        bearerToken,
      );
    } catch {
      // An unparseable outgoing request is never eligible for later settlement.
    }
    const response = await boundFetch(input, init);
    if (verified) {
      const requestId = response.headers.get("x-oneapi-request-id")?.trim();
      if (requestId && REQUEST_ID.test(requestId)) {
        const existing = captured.get(verified.executionId) ?? [];
        captured.set(verified.executionId, [
          ...existing,
          {
            requestId,
            alias: verified.alias,
            protocol: verified.protocol,
          },
        ]);
      }
    }
    return response;
  };
  const capture = Object.freeze({
    fetch: wrapped as typeof fetch,
  });
  REQUEST_ID_CAPTURE_STATES.set(capture, {
    attestation,
    requestIdsByExecution: captured,
  });
  return capture;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`new-api token log request failed: HTTP ${response.status}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_LOG_RESPONSE_BYTES
    ) {
      throw new Error("new-api token log response exceeds byte limit");
    }
  }
  if (!response.body) {
    throw new Error("new-api token log response body is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOG_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("new-api token log response exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function logRows(value: unknown): readonly NewApiLogRow[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as { success?: unknown; data?: unknown };
  return envelope.success === true && Array.isArray(envelope.data)
    ? (envelope.data as readonly NewApiLogRow[])
    : null;
}

function exactWireSequence(
  value: unknown,
): value is readonly DesignSpecV2NativeWireObservation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    return false;
  }
  return value.every((wire, index) => {
    if (!wire || typeof wire !== "object" || Array.isArray(wire)) {
      return false;
    }
    const record = wire as Record<string, unknown>;
    const usage = record.usage;
    return (
      Object.keys(record).sort().join(",") === "usage,wireAttempt" &&
      record.wireAttempt === (index === 0 ? "initial" : "repair") &&
      usage !== null &&
      typeof usage === "object" &&
      !Array.isArray(usage) &&
      Object.keys(usage).sort().join(",") === "inputTokens,outputTokens" &&
      nonNegativeSafeInteger(
        (usage as { inputTokens?: unknown }).inputTokens,
      ) &&
      nonNegativeSafeInteger(
        (usage as { outputTokens?: unknown }).outputTokens,
      )
    );
  });
}

function matchingRow(
  rows: readonly NewApiLogRow[],
  requestId: string,
): NewApiLogRow | null {
  const matches = rows.filter((row) => row.request_id === requestId);
  return matches.length === 1 ? matches[0]! : null;
}

function attestedRoutes(
  attestation: NativeModelEvaluationCostSafetyAttestation,
): ReadonlyMap<string, Readonly<DesignSpecV2NativeSettlementRoute>> | null {
  const routes = attestation.credential.gatewaySettlement.routes;
  const byKey = new Map<
    string,
    Readonly<DesignSpecV2NativeSettlementRoute>
  >();
  for (const route of routes) {
    if (
      !route ||
      typeof route !== "object" ||
      !positiveSafeInteger(route.channelId) ||
      typeof route.alias !== "string" ||
      (route.protocol !== "openai-responses" &&
        route.protocol !== "anthropic-messages")
    ) {
      return null;
    }
    const key = dispatchKey(route);
    if (byKey.has(key)) return null;
    byKey.set(key, Object.freeze({ ...route }));
  }
  return byKey;
}

function requireCredential(input: {
  attestation: unknown;
  gatewayOrigin?: string;
  bearerToken: string;
  fetch: typeof fetch;
}): NativeModelEvaluationCostSafetyAttestation {
  if (!isTrustedNativeModelEvaluationCostSafetyAttestation(input.attestation)) {
    throw new Error("trusted native model evaluation cost safety is required");
  }
  if (
    (input.gatewayOrigin !== undefined &&
      (typeof input.gatewayOrigin !== "string" ||
        input.gatewayOrigin !== input.attestation.credential.gatewayOrigin ||
        new URL(input.gatewayOrigin).origin !== input.gatewayOrigin)) ||
    typeof input.bearerToken !== "string" ||
    input.bearerToken.length < 8 ||
    createHash("sha256").update(input.bearerToken).digest("hex") !==
      input.attestation.credential.bearerTokenSha256 ||
    typeof input.fetch !== "function"
  ) {
    throw new Error("native evaluation credential does not match attestation");
  }
  if (!attestedRoutes(input.attestation)) {
    throw new Error("native evaluation receipt binding is required");
  }
  return input.attestation;
}

/**
 * Resolves a dispatched execution only when every physical wire has one exact
 * token-log row on the attested purpose/channel. Costs are recomputed from the
 * frozen OpenOx native rates; gateway quota is provenance, never an amount.
 */
export function createDesignSpecV2NativeSettlementResolver(options: {
  attestation: NativeModelEvaluationCostSafetyAttestation;
  bearerToken: string;
  requestIdCapture: CapturedDesignSpecV2NativeRequestIds;
  fetch: typeof fetch;
  attempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): DesignSpecV2NativeSettlementResolver {
  const attestation = requireCredential({
    attestation: options.attestation,
    bearerToken: options.bearerToken,
    fetch: options.fetch,
  });
  const captureState = REQUEST_ID_CAPTURE_STATES.get(options.requestIdCapture);
  if (!captureState || captureState.attestation !== attestation) {
    throw new Error("trusted native evaluation request-id capture is required");
  }
  const routes = attestedRoutes(attestation);
  if (!routes) throw new Error("native evaluation receipt binding is required");
  const gatewayOrigin = attestation.credential.gatewayOrigin;
  const bearerToken = options.bearerToken;
  const requestIdsByExecution = captureState.requestIdsByExecution;
  const fetchImpl = options.fetch.bind(globalThis);
  const attempts = options.attempts ?? 5;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("native settlement attempts must be within 1..5");
  }

  const resolve = async (input: {
    executionId: string;
    alias: string;
    protocol: NativeTargetProtocol;
    wires: readonly DesignSpecV2NativeWireObservation[];
  }): Promise<NativeModelEvaluationCostSettlement> => {
    if (
      !input ||
      typeof input.executionId !== "string" ||
      !EXECUTION_ID.test(input.executionId) ||
      typeof input.alias !== "string" ||
      (input.protocol !== "openai-responses" &&
        input.protocol !== "anthropic-messages") ||
      !exactWireSequence(input.wires)
    ) {
      return unknownSettlement();
    }
    const route = routes.get(dispatchKey(input));
    const capturedWires = requestIdsByExecution.get(input.executionId);
    if (
      !route ||
      !capturedWires ||
      capturedWires.length !== input.wires.length ||
      new Set(capturedWires.map((wire) => wire.requestId)).size !==
        capturedWires.length ||
      capturedWires.some(
        (wire) =>
          !REQUEST_ID.test(wire.requestId) ||
          wire.alias !== input.alias ||
          wire.protocol !== input.protocol,
      )
    ) {
      return unknownSettlement();
    }
    const requestIds = capturedWires.map((wire) => wire.requestId);

    let rows: readonly NewApiLogRow[] | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${gatewayOrigin}${attestation.credential.gatewaySettlement.tokenLogPath}`, {
          method: "GET",
          headers: { authorization: `Bearer ${bearerToken}` },
        });
        const parsed = logRows(await boundedJson(response));
        if (
          parsed &&
          requestIds.every((requestId) => matchingRow(parsed, requestId))
        ) {
          rows = parsed;
          break;
        }
      } catch {
        // Retrying a read-only receipt lookup cannot create an extra model call.
      }
      if (attempt < attempts) await wait(200 * attempt);
    }
    if (!rows) return unknownSettlement();

    let currency: "CNY" | "USD" | null = null;
    let nativePicoUnits = 0n;
    for (let index = 0; index < requestIds.length; index += 1) {
      const requestId = requestIds[index]!;
      const row = matchingRow(rows, requestId);
      const wire = input.wires[index]!;
      if (
        !row ||
        row.type !== 2 ||
        row.model_name !== input.alias ||
        row.channel !== route.channelId ||
        row.group !== attestation.credential.gatewaySettlement.purposeGroup ||
        !nonNegativeSafeInteger(row.quota) ||
        !positiveSafeInteger(row.prompt_tokens) ||
        !nonNegativeSafeInteger(row.completion_tokens) ||
        row.completion_tokens > attestation.limits.maxOutputTokensPerWire ||
        row.prompt_tokens !== wire.usage.inputTokens ||
        row.completion_tokens !== wire.usage.outputTokens
      ) {
        return unknownSettlement();
      }
      let settled: Extract<
        NativeModelEvaluationCostSettlement,
        { state: "settled" }
      >;
      try {
        settled = nativePicoUnitsForModelEvaluationUsage(attestation, {
          executionId: input.executionId,
          alias: input.alias,
          protocol: input.protocol,
          wireAttempt: wire.wireAttempt,
          inputTokens: wire.usage.inputTokens,
          outputTokens: wire.usage.outputTokens,
        });
      } catch {
        return unknownSettlement();
      }
      if (currency !== null && currency !== settled.currency) {
        return unknownSettlement();
      }
      currency = settled.currency;
      nativePicoUnits += BigInt(settled.nativePicoUnits);
    }
    if (currency === null || nativePicoUnits <= 0n) return unknownSettlement();
    return Object.freeze({
      state: "settled" as const,
      executionId: input.executionId,
      currency,
      nativePicoUnits: nativePicoUnits.toString(),
      basis:
        `frozen_openox_native_pricing@${attestation.pricing.capturedAt}` as const,
    });
  };

  return Object.freeze({
    resolverId: "new-api-token-log-native-openox/v1" as const,
    resolve,
  });
}
