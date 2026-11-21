import { types } from "node:util";
import type { ModelResult } from "../model-gateway/types";
export type JsonSchema = Readonly<Record<string, unknown>>;
export type UnknownRecord = Record<string, unknown>;
const MODEL_RESULT_KEYS = [
  "data",
  "provider",
  "model",
  "reportedModel",
  "modelResolutionSource",
  "usage",
  "callCount",
] as const;

export function projectionInvalid(): never {
  throw new Error("MODEL_RESULT_PROJECTION_INVALID");
}
export function ownDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): UnknownRecord {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value)
    ) {
      projectionInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      projectionInvalid();
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor))
        projectionInvalid();
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key)))
      projectionInvalid();
    return value as UnknownRecord;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "MODEL_RESULT_PROJECTION_INVALID"
    )
      throw error;
    projectionInvalid();
  }
}
export function denseArray(value: unknown): unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      projectionInvalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) projectionInvalid();
    for (const key of keys as string[]) {
      if (key === "length") continue;
      const descriptor = descriptors[key];
      if (
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        projectionInvalid();
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) projectionInvalid();
    }
    if (keys.length !== value.length + 1) projectionInvalid();
    return value;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "MODEL_RESULT_PROJECTION_INVALID"
    )
      throw error;
    projectionInvalid();
  }
}
export function field(record: UnknownRecord, name: string): unknown {
  return Object.getOwnPropertyDescriptor(record, name)?.value;
}
export function hasField(record: UnknownRecord, name: string): boolean {
  return Object.hasOwn(record, name);
}
export function readModelResult(
  raw: unknown,
  allowedDataKeys: readonly string[],
  requiredDataKeys: readonly string[],
): UnknownRecord & {
  readonly data: UnknownRecord;
  readonly provider: unknown;
  readonly model: unknown;
} {
  const result = ownDataRecord(raw, MODEL_RESULT_KEYS, [
    "data",
    "provider",
    "model",
  ]);
  return {
    data: ownDataRecord(
      field(result, "data"),
      allowedDataKeys,
      requiredDataKeys,
    ),
    provider: field(result, "provider"),
    model: field(result, "model"),
    ...(hasField(result, "reportedModel")
      ? { reportedModel: field(result, "reportedModel") }
      : {}),
    ...(hasField(result, "modelResolutionSource")
      ? { modelResolutionSource: field(result, "modelResolutionSource") }
      : {}),
    ...(hasField(result, "usage")
      ? { usage: readModelUsage(field(result, "usage")) }
      : {}),
    ...(hasField(result, "callCount")
      ? { callCount: field(result, "callCount") }
      : {}),
  };
}

export function readModelUsage(value: unknown): UnknownRecord {
  return ownDataRecord(
    value,
    ["inputTokens", "outputTokens", "costUsd", "gatewaySettlements"],
    [],
  );
}

export const stringSchema = (maxLength: number, extra?: JsonSchema): JsonSchema => ({
  type: "string",
  maxLength,
  ...extra,
});
export const numberSchema = (
  minimum: number,
  maximum: number,
  integer = false,
): JsonSchema => ({ type: integer ? "integer" : "number", minimum, maximum });
export const arraySchema = (maxItems: number, items: JsonSchema): JsonSchema => ({
  type: "array",
  maxItems,
  items,
});
export function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", additionalProperties: false, required, properties };
}
export function optionalObjectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: "object", additionalProperties: false, required, properties };
}

const readbackProbeSchema = objectSchema(
  {
    sequence: numberSchema(1, 2, true),
    phase: stringSchema(64, {
      enum: [
        "gateway_log_observed",
        "gateway_log_pending",
        "gateway_log_missing",
        "gateway_log_unavailable",
        "gateway_log_invalid",
        "gateway_log_ambiguous",
      ],
    }),
    httpStatusClass: {
      oneOf: [
        { type: "integer", minimum: 2, maximum: 5, enum: [2, 4, 5] },
        { type: "null" },
      ],
    },
  },
  ["sequence", "phase", "httpStatusClass"],
);
const transportObservationSchema = objectSchema(
  {
    schemaVersion: stringSchema(64, {
      const: "site-build-provider-transport-observation/v1",
    }),
    physicalWireAttempt: numberSchema(1, 2, true),
    finalPhase: stringSchema(64, {
      enum: [
        "gateway_unavailable",
        "gateway_request_id_observed",
        "upstream_ack_unknown",
        "payload_unavailable",
        "gateway_log_missing",
        "gateway_log_unavailable",
        "gateway_log_invalid",
        "database_ack_unknown",
      ],
    }),
    gatewayIdState: stringSchema(32, {
      enum: ["observed", "missing", "not_observable"],
    }),
    upstreamIdState: stringSchema(32, {
      enum: ["observed", "absent", "not_exposed", "unknown"],
    }),
    payloadState: stringSchema(32, {
      enum: ["not_read", "available", "unavailable"],
    }),
    readbackProbes: arraySchema(2, readbackProbeSchema),
  },
  [
    "schemaVersion",
    "physicalWireAttempt",
    "finalPhase",
    "gatewayIdState",
    "upstreamIdState",
    "payloadState",
    "readbackProbes",
  ],
);
const gatewaySettlementSchema: JsonSchema = {
  oneOf: [
    objectSchema(
      {
        status: stringSchema(16, { const: "settled" }),
        physicalWireAttempt: numberSchema(1, 2, true),
        resolverId: stringSchema(120),
        alias: stringSchema(120),
        protocol: stringSchema(40, {
          enum: [
            "openai-chat-completions",
            "openai-responses",
            "anthropic-messages",
          ],
        }),
        channelId: numberSchema(0, 1_000_000_000, true),
        basis: stringSchema(40, { const: "openox_catalog_token_pricing" }),
        quota: numberSchema(0, 1_000_000_000, true),
        costMicrousd: numberSchema(0, 1_000_000_000_000_000, true),
        inputTokens: numberSchema(0, 1_000_000_000, true),
        outputTokens: numberSchema(0, 1_000_000_000, true),
        upstreamIdState: stringSchema(16, { enum: ["observed", "absent"] }),
        transportObservation: transportObservationSchema,
      },
      [
        "status",
        "physicalWireAttempt",
        "resolverId",
        "alias",
        "protocol",
        "channelId",
        "basis",
        "quota",
        "costMicrousd",
        "inputTokens",
        "outputTokens",
        "upstreamIdState",
        "transportObservation",
      ],
    ),
    objectSchema(
      {
        status: stringSchema(16, { const: "unknown" }),
        physicalWireAttempt: numberSchema(1, 2, true),
        resolverId: stringSchema(120),
        reason: stringSchema(40, {
          enum: [
            "request_id_missing",
            "nonce_missing",
            "gateway_unavailable",
            "upstream_ack_unknown",
            "payload_unavailable",
            "gateway_log_missing",
            "gateway_log_unavailable",
            "log_ambiguous",
            "log_invalid",
            "model_mismatch",
            "channel_mismatch",
            "database_ack_unknown",
          ],
        }),
        transportObservation: transportObservationSchema,
      },
      [
        "status",
        "physicalWireAttempt",
        "resolverId",
        "reason",
        "transportObservation",
      ],
    ),
  ],
};

export function modelResultSchema(data: JsonSchema): JsonSchema {
  return objectSchema(
    {
      data,
      provider: stringSchema(120),
      model: stringSchema(120),
      reportedModel: stringSchema(120),
      modelResolutionSource: stringSchema(40, {
        enum: ["upstream_response", "requested_fallback"],
      }),
      usage: optionalObjectSchema({
        inputTokens: numberSchema(0, 1_000_000_000, true),
        outputTokens: numberSchema(0, 1_000_000_000, true),
        costUsd: numberSchema(0, 1_000_000_000),
        gatewaySettlements: arraySchema(2, gatewaySettlementSchema),
      }),
      callCount: numberSchema(0, 100, true),
    },
    ["data", "provider", "model"],
  );
}
export function restoreModelResult(
  projected: UnknownRecord & {
    readonly provider: string;
    readonly model: string;
  },
  data: unknown,
): ModelResult<unknown> {
  return {
    data,
    provider: projected.provider,
    model: projected.model,
    ...(hasField(projected, "reportedModel")
      ? { reportedModel: projected.reportedModel as string }
      : {}),
    ...(hasField(projected, "modelResolutionSource")
      ? {
          modelResolutionSource:
            projected.modelResolutionSource as ModelResult<unknown>["modelResolutionSource"],
        }
      : {}),
    ...(hasField(projected, "usage")
      ? { usage: projected.usage as ModelResult<unknown>["usage"] }
      : {}),
    ...(hasField(projected, "callCount")
      ? { callCount: projected.callCount as number }
      : {}),
  };
}

export function projectModelResultEnvelope(
  result: UnknownRecord & {
    readonly provider: unknown;
    readonly model: unknown;
  },
  data: unknown,
): UnknownRecord {
  return {
    data,
    provider: result.provider,
    model: result.model,
    ...(hasField(result, "reportedModel")
      ? { reportedModel: result.reportedModel }
      : {}),
    ...(hasField(result, "modelResolutionSource")
      ? { modelResolutionSource: result.modelResolutionSource }
      : {}),
    ...(hasField(result, "usage") ? { usage: result.usage } : {}),
    ...(hasField(result, "callCount") ? { callCount: result.callCount } : {}),
  };
}
