import { createHash } from "node:crypto";

import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import type { ModelEvaluationRun } from "./model-evaluation-harness";
import type {
  ModelEvaluationSettlementContext,
  ModelEvaluationSettlementResolver,
} from "./model-evaluation-executor";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_LOG_RESPONSE_BYTES = 1_048_576;

export interface DesignSpecEvaluationRouteBinding {
  alias: string;
  protocol: ModelCandidateProtocol;
  channelId: number;
}

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

export interface CapturedEvaluationRequestIds {
  readonly fetch: typeof fetch;
  readonly requestIdsByExecution: ReadonlyMap<string, readonly string[]>;
}

function requestExecutionId(init?: RequestInit): string | null {
  const value = new Headers(init?.headers).get(
    "x-site-builder-evaluation-execution-id",
  );
  return value && value.length <= 512 ? value : null;
}

export function createRequestIdCapturingFetch(
  fetchImpl: typeof fetch,
): CapturedEvaluationRequestIds {
  const captured = new Map<string, string[]>();
  const boundFetch = fetchImpl.bind(globalThis);
  const wrapped = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const executionId = requestExecutionId(init);
    const response = await boundFetch(input, init);
    if (executionId) {
      const requestId = response.headers.get("x-oneapi-request-id")?.trim();
      if (requestId && REQUEST_ID.test(requestId)) {
        const existing = captured.get(executionId) ?? [];
        captured.set(executionId, [...existing, requestId]);
      }
    }
    return response;
  };
  return {
    fetch: wrapped as typeof fetch,
    requestIdsByExecution: captured,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) ||
      Number(declared) < 0 ||
      Number(declared) > MAX_LOG_RESPONSE_BYTES)
  ) {
    throw new Error("new-api log response exceeds byte limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LOG_RESPONSE_BYTES) {
    throw new Error("new-api log response exceeds byte limit");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function logRows(value: unknown): NewApiLogRow[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as { success?: unknown; data?: unknown };
  return envelope.success === true && Array.isArray(envelope.data)
    ? (envelope.data as NewApiLogRow[])
    : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function priceCents(
  context: ModelEvaluationSettlementContext,
  prices: ReadonlyMap<
    string,
    Readonly<{
      inputCentsPerMillionTokens: number;
      outputCentsPerMillionTokens: number;
    }>
  >,
): number | null {
  const price = prices.get(`${context.alias}:${context.protocol}`);
  if (!price || !context.usage.complete) return null;
  return (
    (context.usage.inputTokens * price.inputCentsPerMillionTokens +
      context.usage.outputTokens * price.outputCentsPerMillionTokens) /
    1_000_000
  );
}

export function createNewApiEvaluationSettlementResolver(options: {
  gatewayOrigin: string;
  bearerToken: string;
  requestIdsByExecution: ReadonlyMap<string, readonly string[]>;
  routes: readonly DesignSpecEvaluationRouteBinding[];
  prices: readonly {
    alias: string;
    protocol: ModelCandidateProtocol;
    inputCentsPerMillionTokens: number;
    outputCentsPerMillionTokens: number;
  }[];
  fetch: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}): ModelEvaluationSettlementResolver {
  const origin = new URL(options.gatewayOrigin).origin;
  const routes = new Map(
    options.routes.map((route) => [
      `${route.alias}:${route.protocol}`,
      Object.freeze({ ...route }),
    ]),
  );
  const prices = new Map(
    options.prices.map((price) => [
      `${price.alias}:${price.protocol}`,
      Object.freeze({
        inputCentsPerMillionTokens: price.inputCentsPerMillionTokens,
        outputCentsPerMillionTokens: price.outputCentsPerMillionTokens,
      }),
    ]),
  );
  if (
    routes.size !== options.routes.length ||
    prices.size !== options.prices.length ||
    routes.size !== prices.size ||
    [...routes.keys()].some((key) => !prices.has(key))
  ) {
    throw new Error("settlement routes and prices must be exact and unique");
  }
  const fetchImpl = options.fetch.bind(globalThis);
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts ?? 5;

  return {
    resolverId: "new-api-request-log-openox/v1",
    async resolve(context) {
      const route = routes.get(`${context.alias}:${context.protocol}`);
      const requestIds = options.requestIdsByExecution.get(context.executionId);
      if (
        !route ||
        !requestIds ||
        requestIds.length !== context.callCount ||
        new Set(requestIds).size !== requestIds.length ||
        requestIds.some((requestId) => !REQUEST_ID.test(requestId))
      ) {
        return { state: "unknown", reason: "invalid_settlement" } as const;
      }

      let rows: NewApiLogRow[] | null = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${origin}/api/log/token`, {
            method: "GET",
            headers: { authorization: `Bearer ${options.bearerToken}` },
          });
          if (!response.ok) throw new Error("new-api log query failed");
          rows = logRows(await boundedJson(response));
          if (
            rows &&
            requestIds.every(
              (requestId) =>
                rows!.filter((row) => row.request_id === requestId).length ===
                1,
            )
          )
            break;
        } catch {
          rows = null;
        }
        if (attempt < attempts) await wait(200 * attempt);
      }
      if (!rows)
        return { state: "unknown", reason: "invalid_settlement" } as const;
      const matched = requestIds.flatMap((requestId) =>
        rows!.filter((row) => row.request_id === requestId),
      );
      if (
        matched.length !== requestIds.length ||
        matched.some(
          (row) =>
            row.type !== 2 ||
            row.model_name !== context.alias ||
            row.channel !== route.channelId ||
            row.group !== "design-spec-eval" ||
            !nonNegativeInteger(row.quota) ||
            !positiveInteger(row.prompt_tokens) ||
            !nonNegativeInteger(row.completion_tokens),
        )
      ) {
        return { state: "unknown", reason: "invalid_settlement" } as const;
      }
      const inputTokens = matched.reduce(
        (sum, row) => sum + (row.prompt_tokens as number),
        0,
      );
      const outputTokens = matched.reduce(
        (sum, row) => sum + (row.completion_tokens as number),
        0,
      );
      if (
        !context.usage.complete ||
        context.usage.callCount !== context.callCount ||
        context.usage.inputTokens !== inputTokens ||
        context.usage.outputTokens !== outputTokens
      ) {
        return { state: "unknown", reason: "invalid_settlement" } as const;
      }
      const amountCents = priceCents(context, prices);
      return amountCents === null
        ? ({ state: "unknown", reason: "invalid_settlement" } as const)
        : ({
            state: "settled",
            amountCents,
            basis: "frozen_pricing_snapshot",
            executionId: context.executionId,
          } as const);
    },
  };
}

export function redactModelEvaluationRun(run: ModelEvaluationRun): unknown {
  const {
    artifact: _artifact,
    capabilityProbeAttestation,
    assessment,
    ...safe
  } = run;
  return {
    ...safe,
    artifactRetention: run.artifactSha256 ? "digest_only" : "none",
    capabilityProbeAttestationSha256:
      capabilityProbeAttestation?.attestationSha256 ?? null,
    assessment: assessment
      ? {
          qualityPassed: assessment.qualityPassed,
          structurePassed: assessment.structurePassed,
          factualityPassed: assessment.factualityPassed,
          stabilityKeySha256: createHash("sha256")
            .update(assessment.stabilityKey)
            .digest("hex"),
          findingCodes: [...assessment.findingCodes],
        }
      : null,
  };
}
