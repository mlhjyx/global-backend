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

const NORMALIZER_VERSION = "organization-identity-authority/v1" as const;
const GLOBAL_JURISDICTION = "GLOBAL" as const;
const DOMAIN_SCHEME = "domain" as const;

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
      const jurisdiction =
        suffix?.toLocaleUpperCase("en-US") ??
        (typeof payload.country === "string" &&
        /^[A-Z]{2}$/u.test(payload.country)
          ? payload.country
          : "");
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
  const admitted = validateRawSourceProviderPayload(providerKey, payloadValue);
  if (!admitted.ok) {
    return error(
      admitted.reason === "UNGOVERNED_PROVIDER_PAYLOAD"
        ? "IDENTITY_RAW_PAYLOAD_NOT_GOVERNED"
        : "IDENTITY_IDENTIFIER_INVALID",
    );
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
