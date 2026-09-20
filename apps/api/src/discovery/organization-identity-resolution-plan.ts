import { createHash } from "node:crypto";
import { types } from "node:util";
import { parseOrganizationIdentityAuthorityIdentifier } from "./organization-identity-authority";
import { GOVERNED_RAW_SOURCE_PROVIDER_KEYS } from "./raw-source-provider-schema";

const RESOLVER_VERSION = "organization-identity-resolver/v1" as const;
const MAX_CONTAINER_DEPTH = 6;
const MAX_CONTAINER_NODES = 256;
const MAX_OBJECT_FIELDS = 16;
const MAX_AUTHORITY_IDENTIFIERS = 32;
const MAX_BINDINGS = 64;
const MAX_ROOT_MAPPINGS = 64;
const MAX_ARRAY_PRECHECK_LENGTH = MAX_BINDINGS;

type GovernedRawSourceProviderKey =
  (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number];
type SafeJson = null | boolean | number | string | SafeJson[] | SafeJsonRecord;
interface SafeJsonRecord {
  [key: string]: SafeJson;
}

type PlanErrorCode =
  | "IDENTITY_RESOLUTION_INPUT_INVALID"
  | "IDENTITY_RESOLUTION_INPUT_CONTRADICTORY";

export class OrganizationIdentityResolutionPlanError extends Error {
  constructor(public readonly code: PlanErrorCode) {
    super("organization identity resolution plan rejected the supplied input");
    this.name = "OrganizationIdentityResolutionPlanError";
  }
}

export type OrganizationIdentityAuthorityIdentifierPlan = Readonly<{
  providerKey: GovernedRawSourceProviderKey;
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  validatorVersion: string;
  normalizerVersion: "organization-identity-authority/v1";
  key: string;
}>;

type BindExistingPlan = Readonly<{
  kind: "bind_existing";
  companyId: string;
  matchRule: "identity_v2";
  identifiers: readonly OrganizationIdentityAuthorityIdentifierPlan[];
  inputHash: string;
}>;

type LazyUpgradePlan = Readonly<{
  kind: "lazy_upgrade";
  companyId: string;
  matchRule: "identity_v2" | "domain_exact" | "name_country";
  identifiers: readonly OrganizationIdentityAuthorityIdentifierPlan[];
  inputHash: string;
}>;

type CreateNewPlan = Readonly<{
  kind: "create_new";
  matchRule: "identity_v2" | "domain_exact" | "name_country";
  identifiers: readonly OrganizationIdentityAuthorityIdentifierPlan[];
  inputHash: string;
}>;

type ConflictPlan = Readonly<{
  kind: "conflict";
  matchRule: "identity_conflict";
  conflictType: "identifier_split" | "blocking_key_disagreement";
  companyIds: readonly string[];
  identifierKeys: readonly string[];
  inputHash: string;
  conflictFingerprint: string;
}>;

export type OrganizationIdentityResolutionPlan =
  BindExistingPlan | LazyUpgradePlan | CreateNewPlan | ConflictPlan;

function reject(
  code: PlanErrorCode = "IDENTITY_RESOLUTION_INPUT_INVALID",
): never {
  throw new OrganizationIdentityResolutionPlanError(code);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function passiveJsonClone(value: unknown): SafeJson {
  const state = { ancestors: new Set<object>(), nodes: 0 };
  const clone = (input: unknown, depth: number): SafeJson => {
    state.nodes += 1;
    if (state.nodes > MAX_CONTAINER_NODES || depth > MAX_CONTAINER_DEPTH) {
      return reject();
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "string"
    ) {
      return input;
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? input : reject();
    }
    if (typeof input !== "object" || types.isProxy(input)) return reject();
    if (state.ancestors.has(input)) return reject();
    state.ancestors.add(input);
    try {
      const prototype = Object.getPrototypeOf(input);
      if (Array.isArray(input)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          input,
          "length",
        );
        if (
          prototype !== Array.prototype ||
          !lengthDescriptor ||
          lengthDescriptor.enumerable ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return reject();
        }
        const length = lengthDescriptor.value;
        if (length > MAX_ARRAY_PRECHECK_LENGTH) return reject();
        const keys = Reflect.ownKeys(input);
        if (
          keys.length !== length + 1 ||
          keys.some(
            (key) =>
              typeof key === "symbol" ||
              (key !== "length" &&
                (!/^\d+$/u.test(key) || Number(key) >= length)),
          )
        ) {
          return reject();
        }
        const result: SafeJson[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            return reject();
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      if (prototype !== Object.prototype && prototype !== null) return reject();
      const keys = Reflect.ownKeys(input);
      if (
        keys.length > MAX_OBJECT_FIELDS ||
        keys.some((key) => typeof key === "symbol")
      ) {
        return reject();
      }
      const result: SafeJsonRecord = Object.create(null) as SafeJsonRecord;
      for (const key of keys) {
        if (typeof key !== "string") return reject();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          return reject();
        }
        if (descriptor.value !== undefined)
          result[key] = clone(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      state.ancestors.delete(input);
    }
  };
  try {
    return clone(value, 0);
  } catch (error) {
    if (error instanceof OrganizationIdentityResolutionPlanError) throw error;
    return reject();
  }
}

function record(value: SafeJson): SafeJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject();
  }
  return value as SafeJsonRecord;
}

function array(value: SafeJson, maximum: number): SafeJson[] {
  if (!Array.isArray(value) || value.length > maximum) return reject();
  return value;
}

function exactKeys(value: SafeJsonRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(compareOrdinal);
  const expected = [...keys].sort(compareOrdinal);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return reject();
  }
}

function requiredString(
  value: SafeJsonRecord,
  key: string,
  maximum: number,
  expression?: RegExp,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    !candidate.length ||
    candidate.length > maximum ||
    candidate.normalize("NFC") !== candidate ||
    [...candidate].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    (expression !== undefined && !expression.test(candidate))
  ) {
    return reject();
  }
  return candidate;
}

function optionalUuid(value: SafeJsonRecord, key: string): string | null {
  const candidate = value[key];
  if (candidate === null) return null;
  if (candidate === undefined) return null;
  return uuid(candidate);
}

function uuid(value: SafeJson): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    return reject();
  }
  return value;
}

function providerKey(value: SafeJson): GovernedRawSourceProviderKey {
  if (
    typeof value !== "string" ||
    !GOVERNED_RAW_SOURCE_PROVIDER_KEYS.includes(value as never)
  ) {
    return reject();
  }
  return value as GovernedRawSourceProviderKey;
}

function stableJson(value: SafeJson): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareOrdinal)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: SafeJson): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function parseAuthorityIdentifiers(
  value: SafeJson,
  expectedProviderKey: GovernedRawSourceProviderKey,
): readonly OrganizationIdentityAuthorityIdentifierPlan[] {
  const byKey = new Map<string, OrganizationIdentityAuthorityIdentifierPlan>();
  for (const item of array(value, MAX_AUTHORITY_IDENTIFIERS)) {
    const source = record(item);
    exactKeys(source, [
      "providerKey",
      "scheme",
      "jurisdiction",
      "normalizedValue",
      "validatorVersion",
      "normalizerVersion",
      "key",
    ]);
    const parsed = parseOrganizationIdentityAuthorityIdentifier(source);
    if (!parsed || parsed.providerKey !== expectedProviderKey) {
      return reject();
    }
    const previous = byKey.get(parsed.key);
    if (
      previous &&
      stableJson(previous as unknown as SafeJson) !==
        stableJson(parsed as unknown as SafeJson)
    ) {
      return reject("IDENTITY_RESOLUTION_INPUT_CONTRADICTORY");
    }
    byKey.set(parsed.key, parsed);
  }
  return [...byKey.values()]
    .sort((left, right) => compareOrdinal(left.key, right.key))
    .map((item) => deepFreeze({ ...item }));
}

type Binding = Readonly<{ identifierKey: string; companyId: string }>;
type RootMapping = Readonly<{ sourceCompanyId: string; rootCompanyId: string }>;

function parseBindings(
  value: SafeJson,
  authorityIdentifierKeys: ReadonlySet<string>,
): readonly Binding[] {
  const byKey = new Map<string, Binding>();
  for (const item of array(value, MAX_BINDINGS)) {
    const source = record(item);
    exactKeys(source, ["identifierKey", "companyId"]);
    const parsed = {
      identifierKey: requiredString(source, "identifierKey", 512),
      companyId: uuid(source.companyId),
    };
    const previous = byKey.get(parsed.identifierKey);
    if (previous && previous.companyId !== parsed.companyId) {
      return reject("IDENTITY_RESOLUTION_INPUT_CONTRADICTORY");
    }
    byKey.set(parsed.identifierKey, deepFreeze(parsed));
  }
  for (const binding of byKey.values()) {
    if (!authorityIdentifierKeys.has(binding.identifierKey)) return reject();
  }
  return [...byKey.values()].sort((left, right) =>
    compareOrdinal(left.identifierKey, right.identifierKey),
  );
}

function parseRootMappings(value: SafeJson): readonly RootMapping[] {
  const bySource = new Map<string, RootMapping>();
  for (const item of array(value, MAX_ROOT_MAPPINGS)) {
    const source = record(item);
    exactKeys(source, ["sourceCompanyId", "rootCompanyId"]);
    const parsed = {
      sourceCompanyId: uuid(source.sourceCompanyId),
      rootCompanyId: uuid(source.rootCompanyId),
    };
    if (parsed.sourceCompanyId === parsed.rootCompanyId) return reject();
    const previous = bySource.get(parsed.sourceCompanyId);
    if (previous && previous.rootCompanyId !== parsed.rootCompanyId) {
      return reject("IDENTITY_RESOLUTION_INPUT_CONTRADICTORY");
    }
    bySource.set(parsed.sourceCompanyId, deepFreeze(parsed));
  }
  for (const mapping of bySource.values()) {
    if (bySource.has(mapping.rootCompanyId)) return reject();
  }
  return [...bySource.values()].sort((left, right) =>
    compareOrdinal(left.sourceCompanyId, right.sourceCompanyId),
  );
}

function parseInput(value: unknown) {
  const source = record(passiveJsonClone(value));
  exactKeys(source, [
    "raw",
    "resolverVersion",
    "blocker",
    "authorityIdentifiers",
    "existingBindings",
    "rootMappings",
  ]);
  const raw = record(source.raw);
  exactKeys(raw, [
    "rawRecordId",
    "providerKey",
    "payloadHash",
    "ingestVersion",
  ]);
  const parsedRaw = {
    rawRecordId: uuid(raw.rawRecordId),
    providerKey: providerKey(raw.providerKey),
    payloadHash: requiredString(raw, "payloadHash", 64, /^[a-f0-9]{64}$/u),
    ingestVersion: requiredString(
      raw,
      "ingestVersion",
      128,
      /^[a-z0-9][a-z0-9._/-]*$/u,
    ),
  };
  if (requiredString(source, "resolverVersion", 128) !== RESOLVER_VERSION) {
    return reject();
  }
  const blocker = record(source.blocker);
  const blockerKeys = Object.keys(blocker).sort(compareOrdinal);
  const allowsAbsentCandidate =
    blockerKeys.join(",") === "blockerKey,matchRule" ||
    blockerKeys.join(",") === "blockerKey,legacyCandidateCompanyId,matchRule";
  if (!allowsAbsentCandidate) return reject();
  const parsedBlocker: {
    blockerKey: string;
    matchRule: "domain_exact" | "name_country";
    legacyCandidateCompanyId: string | null;
  } = {
    blockerKey: requiredString(blocker, "blockerKey", 512),
    matchRule: requiredString(blocker, "matchRule", 32) as
      "domain_exact" | "name_country",
    legacyCandidateCompanyId: optionalUuid(blocker, "legacyCandidateCompanyId"),
  };
  if (
    parsedBlocker.matchRule !== "domain_exact" &&
    parsedBlocker.matchRule !== "name_country"
  ) {
    return reject();
  }
  const identifiers = parseAuthorityIdentifiers(
    source.authorityIdentifiers,
    parsedRaw.providerKey,
  );
  return {
    raw: deepFreeze(parsedRaw),
    resolverVersion: RESOLVER_VERSION,
    blocker: deepFreeze(parsedBlocker),
    identifiers,
    bindings: parseBindings(
      source.existingBindings,
      new Set(identifiers.map((identifier) => identifier.key)),
    ),
    rootMappings: parseRootMappings(source.rootMappings),
  };
}

function resolutionMatchRule(
  identifierCount: number,
  blockerRule: "domain_exact" | "name_country",
): "identity_v2" | "domain_exact" | "name_country" {
  return identifierCount > 0 ? "identity_v2" : blockerRule;
}

/**
 * A pure, passive planner. It only chooses a deterministic persistence intent;
 * it performs no database, lock, provider, workflow, or API operation.
 */
export function planOrganizationIdentityResolution(
  input: unknown,
): OrganizationIdentityResolutionPlan {
  const parsed = parseInput(input);
  const rootBySource = new Map(
    parsed.rootMappings.map((mapping) => [
      mapping.sourceCompanyId,
      mapping.rootCompanyId,
    ]),
  );
  const bindingByKey = new Map(
    parsed.bindings.map((binding) => [
      binding.identifierKey,
      binding.companyId,
    ]),
  );
  const rootFor = (companyId: string): string =>
    rootBySource.get(companyId) ?? companyId;
  const boundRoots = [
    ...new Set(
      parsed.identifiers
        .map((identifier) => bindingByKey.get(identifier.key))
        .filter((companyId): companyId is string => companyId !== undefined)
        .map(rootFor),
    ),
  ].sort(compareOrdinal);
  const legacyRoot = parsed.blocker.legacyCandidateCompanyId
    ? rootFor(parsed.blocker.legacyCandidateCompanyId)
    : null;
  const inputHash = sha256({
    raw: parsed.raw,
    resolverVersion: parsed.resolverVersion,
    blocker: parsed.blocker,
    authorityIdentifiers: parsed.identifiers,
    bindings: parsed.bindings,
    rootMappings: parsed.rootMappings,
  } as unknown as SafeJson);
  const identifiers = deepFreeze(
    parsed.identifiers.map((identifier) => ({ ...identifier })),
  );
  const conflict = (
    conflictType: "identifier_split" | "blocking_key_disagreement",
    companyIds: readonly string[],
  ): ConflictPlan => {
    const sortedCompanyIds = [...new Set(companyIds)].sort(compareOrdinal);
    const identifierKeys = parsed.identifiers.map(
      (identifier) => identifier.key,
    );
    return deepFreeze({
      kind: "conflict" as const,
      matchRule: "identity_conflict" as const,
      conflictType,
      companyIds: deepFreeze(sortedCompanyIds),
      identifierKeys: deepFreeze([...identifierKeys]),
      inputHash,
      conflictFingerprint: sha256({
        resolverVersion: parsed.resolverVersion,
        blocker: {
          blockerKey: parsed.blocker.blockerKey,
          matchRule: parsed.blocker.matchRule,
        },
        conflictType,
        companyIds: sortedCompanyIds,
        identifierKeys,
      } as unknown as SafeJson),
    });
  };

  if (boundRoots.length > 1) return conflict("identifier_split", boundRoots);
  if (boundRoots.length === 1 && legacyRoot && boundRoots[0] !== legacyRoot) {
    return conflict("blocking_key_disagreement", [boundRoots[0], legacyRoot]);
  }
  if (boundRoots.length === 1) {
    return deepFreeze({
      kind: "bind_existing" as const,
      companyId: boundRoots[0],
      matchRule: "identity_v2" as const,
      identifiers,
      inputHash,
    });
  }
  const matchRule = resolutionMatchRule(
    identifiers.length,
    parsed.blocker.matchRule,
  );
  if (legacyRoot) {
    return deepFreeze({
      kind: "lazy_upgrade" as const,
      companyId: legacyRoot,
      matchRule,
      identifiers,
      inputHash,
    });
  }
  return deepFreeze({
    kind: "create_new" as const,
    matchRule,
    identifiers,
    inputHash,
  });
}
