// Intent source-mined from tugjvnh@70885cdb; this Raw-only boundary is not a
// compatibility or runtime-availability claim.
import {
  isContactFreeText,
  isSecretFreeText,
} from "./raw-source-provider-normalizer";
import {
  GOVERNED_RAW_SOURCE_PROVIDER_KEYS,
  validateRawSourceProviderPayload,
} from "./raw-source-provider-schema";
import { types } from "node:util";

const NORMALIZER_VERSION = "organization-identity-authority/v1" as const;
const GLOBAL_JURISDICTION = "GLOBAL" as const;
const DOMAIN_SCHEME = "domain" as const;
const MAX_CONTAINER_DEPTH = 6;
const MAX_CONTAINER_NODES = 256;
const MAX_OBJECT_FIELDS = 32;
const MAX_ARRAY_ITEMS = 20;

type IdentityAuthorityErrorCode =
  | "IDENTITY_RAW_PAYLOAD_NOT_GOVERNED"
  | "IDENTITY_AUTHORITY_PROFILE_MISSING"
  | "IDENTITY_IDENTIFIER_NOT_AUTHORIZED"
  | "IDENTITY_IDENTIFIER_INVALID";

type IdentifierRule = Readonly<{
  scheme: string;
  validatorVersion: string;
}>;

export type OrganizationIdentityAuthorityProfile = Readonly<{
  providerKey: (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number];
  identifierRules: readonly IdentifierRule[];
}>;

export type OrganizationIdentityAuthorityIdentifier = Readonly<{
  providerKey: (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number];
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  validatorVersion: string;
  normalizerVersion: typeof NORMALIZER_VERSION;
  key: string;
}>;

export class OrganizationIdentityAuthorityError extends Error {
  constructor(public readonly code: IdentityAuthorityErrorCode) {
    super("organization identity authority rejected the supplied payload");
    this.name = "OrganizationIdentityAuthorityError";
  }
}

function frozenRule(scheme: string, validatorVersion: string): IdentifierRule {
  return Object.freeze({ scheme, validatorVersion });
}

function frozenProfile(
  providerKey: (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number],
  identifierRules: readonly IdentifierRule[] = [],
): OrganizationIdentityAuthorityProfile {
  return Object.freeze({
    providerKey,
    identifierRules: Object.freeze([...identifierRules]),
  });
}

/**
 * Raw-only identity authority. This list intentionally mirrors exactly the
 * current Raw schema export; future provider profiles belong to their own task.
 */
export const ORGANIZATION_IDENTITY_AUTHORITY_PROFILES: Readonly<
  Record<
    (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number],
    OrganizationIdentityAuthorityProfile
  >
> = Object.freeze({
  registry: frozenProfile("registry", [
    frozenRule("registry-id", "registry-id-v1"),
    frozenRule("lei", "lei-v1"),
  ]),
  directory: frozenProfile("directory"),
  wikidata: frozenProfile("wikidata"),
  openstreetmap: frozenProfile("openstreetmap"),
  trade_fair: frozenProfile("trade_fair"),
  ted: frozenProfile("ted", [frozenRule("ted-natid", "ted-natid-v1")]),
  openfda: frozenProfile("openfda", [frozenRule("fda-reg", "fda-reg-v1")]),
  public_web: frozenProfile("public_web"),
});

function error(code: IdentityAuthorityErrorCode): never {
  throw new OrganizationIdentityAuthorityError(code);
}

type SafeJson = null | boolean | number | string | SafeJson[] | SafeJsonRecord;
interface SafeJsonRecord {
  [key: string]: SafeJson;
}

class UnsafeAuthorityContainerError extends Error {}

function unsafeContainer(): never {
  throw new UnsafeAuthorityContainerError();
}

/**
 * This is a bounded passive container preflight, not another Raw schema.
 * It reads only descriptors and never invokes an input getter while cloning.
 */
function passivePlainJsonClone(value: unknown): SafeJson {
  const state = { nodes: 0, ancestors: new Set<object>() };
  const clone = (input: unknown, depth: number): SafeJson => {
    state.nodes += 1;
    if (state.nodes > MAX_CONTAINER_NODES || depth > MAX_CONTAINER_DEPTH) {
      return unsafeContainer();
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "string"
    ) {
      return input;
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? input : unsafeContainer();
    }
    if (typeof input !== "object") return unsafeContainer();
    if (types.isProxy(input)) return unsafeContainer();
    if (state.ancestors.has(input)) return unsafeContainer();
    state.ancestors.add(input);
    try {
      const prototype = Object.getPrototypeOf(input);
      if (Array.isArray(input)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          input,
          "length",
        );
        if (
          !lengthDescriptor ||
          lengthDescriptor.enumerable ||
          !("value" in lengthDescriptor)
        ) {
          return unsafeContainer();
        }
        const length = lengthDescriptor.value;
        if (
          prototype !== Array.prototype ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_ARRAY_ITEMS
        ) {
          return unsafeContainer();
        }
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
          return unsafeContainer();
        }
        const copy: SafeJson[] = [];
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
            return unsafeContainer();
          }
          copy.push(clone(descriptor.value, depth + 1));
        }
        return copy;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        return unsafeContainer();
      }
      const keys = Reflect.ownKeys(input);
      if (
        keys.length > MAX_OBJECT_FIELDS ||
        keys.some((key) => typeof key === "symbol")
      ) {
        return unsafeContainer();
      }
      const copy: SafeJsonRecord = Object.create(null) as SafeJsonRecord;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          return unsafeContainer();
        }
        if (descriptor.value === undefined) continue;
        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, depth + 1),
          writable: true,
        });
      }
      return copy;
    } finally {
      state.ancestors.delete(input);
    }
  };
  return clone(value, 0);
}

function safeRecord(value: SafeJson | undefined): SafeJsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SafeJsonRecord)
    : null;
}

function isAuthorizedIdentifierScheme(
  providerKey: string,
  scheme: string,
  profile: OrganizationIdentityAuthorityProfile,
): boolean {
  if (providerKey === "ted") return /^ted-natid(?::[a-z]{2})?$/u.test(scheme);
  return profile.identifierRules.some((rule) => rule.scheme === scheme);
}

function rejectionCodeForSafePayload(
  providerKey: string,
  payload: SafeJson,
): IdentityAuthorityErrorCode {
  if (!GOVERNED_RAW_SOURCE_PROVIDER_KEYS.includes(providerKey as never)) {
    return "IDENTITY_RAW_PAYLOAD_NOT_GOVERNED";
  }
  const profile = (
    ORGANIZATION_IDENTITY_AUTHORITY_PROFILES as Readonly<
      Record<string, OrganizationIdentityAuthorityProfile>
    >
  )[providerKey];
  if (!profile) return "IDENTITY_AUTHORITY_PROFILE_MISSING";
  const record = safeRecord(payload);
  const identifier = record?.identifier;
  const identifierRecord =
    identifier === undefined ? null : safeRecord(identifier);
  if (!identifierRecord) return "IDENTITY_IDENTIFIER_INVALID";
  const scheme = identifierRecord.scheme;
  const value = identifierRecord.value;
  if (typeof scheme !== "string" || typeof value !== "string") {
    return "IDENTITY_IDENTIFIER_INVALID";
  }
  if (
    Object.keys(identifierRecord).length !== 2 ||
    !Object.hasOwn(identifierRecord, "scheme") ||
    !Object.hasOwn(identifierRecord, "value")
  ) {
    return "IDENTITY_IDENTIFIER_INVALID";
  }
  if (profile.identifierRules.length === 0) {
    return "IDENTITY_IDENTIFIER_NOT_AUTHORIZED";
  }
  return isAuthorizedIdentifierScheme(providerKey, scheme, profile)
    ? "IDENTITY_IDENTIFIER_INVALID"
    : "IDENTITY_IDENTIFIER_NOT_AUTHORIZED";
}

function profileFor(providerKey: string): OrganizationIdentityAuthorityProfile {
  const profile = (
    ORGANIZATION_IDENTITY_AUTHORITY_PROFILES as Readonly<
      Record<string, OrganizationIdentityAuthorityProfile>
    >
  )[providerKey];
  return profile ?? error("IDENTITY_AUTHORITY_PROFILE_MISSING");
}

function validLei(value: string): boolean {
  if (!/^[A-Z0-9]{20}$/u.test(value)) return false;
  const expanded = [...value]
    .map((character) =>
      /[A-Z]/u.test(character)
        ? String(character.charCodeAt(0) - 55)
        : character,
    )
    .join("");
  let remainder = 0;
  for (const digit of expanded)
    remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

function normalizedDomain(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  return normalized || error("IDENTITY_IDENTIFIER_INVALID");
}

function normalizedStructuredValue(value: string): string {
  if (!isContactFreeText(value) || !isSecretFreeText(value)) {
    return error("IDENTITY_IDENTIFIER_INVALID");
  }
  const normalized = value
    .normalize("NFC")
    .toLocaleUpperCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return normalized || error("IDENTITY_IDENTIFIER_INVALID");
}

function frozenIdentifier(input: {
  providerKey: (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number];
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  validatorVersion: string;
}): OrganizationIdentityAuthorityIdentifier {
  const key = `${input.scheme}:${input.jurisdiction}:${input.normalizedValue}`;
  return Object.freeze({
    ...input,
    normalizerVersion: NORMALIZER_VERSION,
    key,
  });
}

function extractPayloadIdentifier(
  providerKey: (typeof GOVERNED_RAW_SOURCE_PROVIDER_KEYS)[number],
  payload: Record<string, unknown>,
  profile: OrganizationIdentityAuthorityProfile,
): OrganizationIdentityAuthorityIdentifier | null {
  const rawIdentifier = payload.identifier;
  if (rawIdentifier === undefined) return null;
  if (
    rawIdentifier === null ||
    typeof rawIdentifier !== "object" ||
    Array.isArray(rawIdentifier)
  ) {
    return error("IDENTITY_IDENTIFIER_INVALID");
  }
  const identifier = rawIdentifier as Record<string, unknown>;
  const scheme = identifier.scheme;
  const value = identifier.value;
  if (typeof scheme !== "string" || typeof value !== "string") {
    return error("IDENTITY_IDENTIFIER_INVALID");
  }
  const rule = profile.identifierRules.find((candidate) =>
    providerKey === "ted"
      ? /^ted-natid(?::[a-z]{2})?$/u.test(scheme) &&
        candidate.scheme === "ted-natid"
      : candidate.scheme === scheme,
  );
  if (!rule) return error("IDENTITY_IDENTIFIER_NOT_AUTHORIZED");

  switch (rule.scheme) {
    case "registry-id": {
      const jurisdiction =
        typeof payload.country === "string" &&
        /^[A-Z]{2}$/u.test(payload.country)
          ? payload.country
          : GLOBAL_JURISDICTION;
      return frozenIdentifier({
        providerKey,
        scheme: rule.scheme,
        jurisdiction,
        normalizedValue: normalizedStructuredValue(value),
        validatorVersion: rule.validatorVersion,
      });
    }
    case "lei": {
      const normalizedValue = normalizedStructuredValue(value);
      if (!validLei(normalizedValue))
        return error("IDENTITY_IDENTIFIER_INVALID");
      return frozenIdentifier({
        providerKey,
        scheme: rule.scheme,
        jurisdiction: GLOBAL_JURISDICTION,
        normalizedValue,
        validatorVersion: rule.validatorVersion,
      });
    }
    case "ted-natid": {
      const suffix = /^ted-natid:([a-z]{2})$/u.exec(scheme)?.[1];
      const country =
        typeof payload.country === "string" &&
        /^[A-Z]{2}$/u.test(payload.country)
          ? payload.country
          : null;
      const suffixJurisdiction = suffix?.toLocaleUpperCase("en-US");
      if (suffixJurisdiction && country && suffixJurisdiction !== country) {
        return error("IDENTITY_IDENTIFIER_INVALID");
      }
      const jurisdiction = suffixJurisdiction ?? country ?? "";
      if (!jurisdiction) return error("IDENTITY_IDENTIFIER_INVALID");
      return frozenIdentifier({
        providerKey,
        scheme: rule.scheme,
        jurisdiction,
        normalizedValue: normalizedStructuredValue(value),
        validatorVersion: rule.validatorVersion,
      });
    }
    case "fda-reg":
      if (!/^\d+$/u.test(value)) {
        return error("IDENTITY_IDENTIFIER_INVALID");
      }
      return frozenIdentifier({
        providerKey,
        scheme: rule.scheme,
        jurisdiction: "US",
        normalizedValue: value,
        validatorVersion: rule.validatorVersion,
      });
    default:
      return error("IDENTITY_IDENTIFIER_NOT_AUTHORIZED");
  }
}

/**
 * Validates with the current Raw contract before deriving any authority record.
 * It does not create persistence, resolver, provider-quality, or runtime state.
 */
export function extractOrganizationIdentityAuthority(
  providerKey: string,
  payloadValue: unknown,
): readonly OrganizationIdentityAuthorityIdentifier[] {
  if (!GOVERNED_RAW_SOURCE_PROVIDER_KEYS.includes(providerKey as never)) {
    return error("IDENTITY_RAW_PAYLOAD_NOT_GOVERNED");
  }
  let safePayload: SafeJson;
  try {
    safePayload = passivePlainJsonClone(payloadValue);
  } catch {
    return error("IDENTITY_IDENTIFIER_INVALID");
  }
  let admitted;
  try {
    admitted = validateRawSourceProviderPayload(providerKey, safePayload);
  } catch {
    return error("IDENTITY_IDENTIFIER_INVALID");
  }
  if (!admitted.ok) {
    return error(rejectionCodeForSafePayload(providerKey, safePayload));
  }
  const profile = profileFor(providerKey);
  const governedProviderKey = profile.providerKey;
  const byKey = new Map<string, OrganizationIdentityAuthorityIdentifier>();
  if (typeof admitted.value.domain === "string") {
    const normalizedValue = normalizedDomain(admitted.value.domain);
    const domain = frozenIdentifier({
      providerKey: governedProviderKey,
      scheme: DOMAIN_SCHEME,
      jurisdiction: GLOBAL_JURISDICTION,
      normalizedValue,
      validatorVersion: "domain-v1",
    });
    byKey.set(domain.key, domain);
  }
  const identifier = extractPayloadIdentifier(
    governedProviderKey,
    admitted.value,
    profile,
  );
  if (identifier) byKey.set(identifier.key, identifier);
  return Object.freeze(
    [...byKey.values()].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    ),
  );
}
