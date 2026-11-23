import { types } from "node:util";
import {
  EMAIL_VERIFICATION_STATES,
  CATCH_ALL_CLASSES,
  type EmailVerificationState,
  type CatchAllClass,
} from "../discovery/contact-point-verification-state";
import { observedToolMicrousd } from "../tools/tool-cost-microusd";
import type { TypedProjectionSchema } from "./durable-result-strategy";
import type { TypedProjectionDefinition } from "./typed-projection.types";
import type { TypedProjectionRegistry } from "./typed-projection.registry";

export const CONTACT_EMAIL_VERIFICATION_PROVIDERS = Object.freeze([
  "millionverifier",
  "emailable",
  "zerobounce",
] as const);
export type ContactEmailVerificationProvider =
  (typeof CONTACT_EMAIL_VERIFICATION_PROVIDERS)[number];
export const CONTACT_EMAIL_VERIFICATION_SCHEMAS = Object.freeze({
  millionverifier: "contact-email-verify-millionverifier/v1",
  emailable: "contact-email-verify-emailable/v1",
  zerobounce: "contact-email-verify-zerobounce/v1",
} as const satisfies Readonly<
  Record<ContactEmailVerificationProvider, TypedProjectionSchema>
>);
/** Static producer→schema registration for the governance scanner; values are the closed runtime schemas. */
export const CONTACT_EMAIL_VERIFICATION_SCHEMA_BINDINGS = Object.freeze({
  "contact_email.verify.millionverifier": "contact-email-verify-millionverifier/v1",
  "contact_email.verify.emailable": "contact-email-verify-emailable/v1",
  "contact_email.verify.zerobounce": "contact-email-verify-zerobounce/v1",
});
export interface ControlledVerificationVote {
  readonly providerKey: ContactEmailVerificationProvider;
  readonly state: EmailVerificationState;
  readonly catchAll: "catch_all" | "not_catch_all" | "inconclusive" | "unknown";
  readonly catchAllClass: CatchAllClass;
  readonly score: number;
  readonly acceptAll: boolean | null;
  readonly disposable: boolean | null;
  readonly role: boolean | null;
  readonly reason: "provider_verdict";
  readonly costBasis: "estimated_upper_bound";
}
export interface ControlledVerificationResult {
  readonly data: ControlledVerificationVote;
  readonly costCents: number;
  readonly costMicrousd: string;
}
const DATA_KEYS = [
  "providerKey",
  "state",
  "catchAll",
  "catchAllClass",
  "score",
  "acceptAll",
  "disposable",
  "role",
  "reason",
  "costBasis",
] as const;
function invalid(): never {
  throw new Error("CONTACT_EMAIL_VERIFICATION_PROJECTION_INVALID");
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  for (const key of keys) {
    const d = descriptors[key];
    if (!d?.enumerable || !Object.hasOwn(d, "value")) return invalid();
  }
  return value as Record<string, unknown>;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.some((entry) => entry === value))
    return invalid();
  return value as T;
}
function flag(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  return invalid();
}
/** Finite single-provider evidence only. This does not adjudicate reliability or certify an invoice. */
export function parseContactEmailVerificationResult(
  provider: ContactEmailVerificationProvider,
  value: unknown,
): ControlledVerificationResult {
  if (!CONTACT_EMAIL_VERIFICATION_PROVIDERS.includes(provider))
    return invalid();
  const raw = record(value, ["data", "costCents", "costMicrousd"]);
  const data = record(raw.data, DATA_KEYS);
  if (
    data.providerKey !== provider ||
    data.reason !== "provider_verdict" ||
    data.costBasis !== "estimated_upper_bound"
  )
    return invalid();
  if (
    typeof raw.costCents !== "number" ||
    !Number.isFinite(raw.costCents) ||
    Object.is(raw.costCents, -0) ||
    typeof raw.costMicrousd !== "string"
  )
    return invalid();
  let micro: bigint;
  try {
    micro = observedToolMicrousd({
      costCents: raw.costCents,
      costMicrousd: raw.costMicrousd,
    });
  } catch {
    return invalid();
  }
  if (micro > 150000n || raw.costCents !== Number(micro) / 10000)
    return invalid();
  if (
    typeof data.score !== "number" ||
    !Number.isFinite(data.score) ||
    Object.is(data.score, -0) ||
    data.score < 0 ||
    data.score > 100
  )
    return invalid();
  const vote: ControlledVerificationVote = Object.freeze({
    providerKey: provider,
    state: enumValue(data.state, EMAIL_VERIFICATION_STATES),
    catchAll: enumValue(data.catchAll, [
      "catch_all",
      "not_catch_all",
      "inconclusive",
      "unknown",
    ] as const),
    catchAllClass: enumValue(data.catchAllClass, CATCH_ALL_CLASSES),
    score: data.score,
    acceptAll: flag(data.acceptAll),
    disposable: flag(data.disposable),
    role: flag(data.role),
    reason: "provider_verdict",
    costBasis: "estimated_upper_bound",
  });
  return Object.freeze({
    data: vote,
    costCents: raw.costCents,
    costMicrousd: micro.toString(),
  });
}
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
function definition(
  provider: ContactEmailVerificationProvider,
): TypedProjectionDefinition<unknown, unknown> {
  const nullableBoolean = { type: ["boolean", "null"] };
  const properties = {
    providerKey: { type: "string", maxLength: 32, const: provider },
    state: {
      type: "string",
      maxLength: 32,
      enum: [...EMAIL_VERIFICATION_STATES],
    },
    catchAll: {
      type: "string",
      maxLength: 32,
      enum: ["catch_all", "not_catch_all", "inconclusive", "unknown"],
    },
    catchAllClass: {
      type: "string",
      maxLength: 32,
      enum: [...CATCH_ALL_CLASSES],
    },
    score: { type: "number", minimum: 0, maximum: 100 },
    acceptAll: nullableBoolean,
    disposable: nullableBoolean,
    role: nullableBoolean,
    reason: { type: "string", maxLength: 32, const: "provider_verdict" },
    costBasis: {
      type: "string",
      maxLength: 32,
      const: "estimated_upper_bound",
    },
  };
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["data", "costCents", "costMicrousd"],
    properties: {
      data: {
        type: "object",
        additionalProperties: false,
        required: [...DATA_KEYS],
        properties,
      },
      costCents: { type: "number", minimum: 0, maximum: 15 },
      costMicrousd: { type: "string", minLength: 1, maxLength: 6 },
    },
  };
  freeze(jsonSchema);
  return Object.freeze({
    schema: CONTACT_EMAIL_VERIFICATION_SCHEMAS[provider],
    jsonSchema,
    project: (raw: unknown) =>
      parseContactEmailVerificationResult(provider, raw),
    restore: (projected: unknown) =>
      parseContactEmailVerificationResult(provider, projected),
  });
}
export const CONTACT_EMAIL_VERIFICATION_PROJECTION_DEFINITIONS = Object.freeze(
  CONTACT_EMAIL_VERIFICATION_PROVIDERS.map(definition),
);
export function registerContactEmailVerificationProjections(
  registry: TypedProjectionRegistry,
): TypedProjectionRegistry {
  for (const item of CONTACT_EMAIL_VERIFICATION_PROJECTION_DEFINITIONS)
    registry.register(item);
  return registry;
}
