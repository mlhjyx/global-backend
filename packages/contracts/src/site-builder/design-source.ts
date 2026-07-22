/**
 * Design-source provenance and authorization contract.
 *
 * This contract is intentionally usable from untyped JSON boundaries.  The
 * type union protects TypeScript consumers while the validator repeats every
 * privilege boundary so a serialized manifest cannot self-authorize.
 */
export const DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION =
  "site-builder-design-source-manifest/v1" as const;

export const DESIGN_SOURCE_CLASSES = [
  "platform_original",
  "permissive_licensed",
  "owned_export_authorized",
  "visual_research_only",
] as const;
export type DesignSourceClass = (typeof DESIGN_SOURCE_CLASSES)[number];

export const DESIGN_USES = [
  "visual_analysis",
  "token_abstraction",
  "structure_abstraction",
  "code_transformation",
] as const;
export type DesignUse = (typeof DESIGN_USES)[number];

export type DesignSourceRetentionPolicy =
  "manifest_only" | "ephemeral_source" | "licensed_archive";
export type DesignSourceTrainingPolicy =
  "platform_corpus" | "license_permits" | "prohibited";
export type ExternalDesignAssetKind =
  "image" | "font" | "icon" | "script" | "copy";
export type ExternalDesignAssetDisposition =
  "remove" | "replace" | "self_host" | "retain";

export interface OwnerAuthorization {
  evidencePath: string;
  covers: {
    aiSiteBuilder: boolean;
    derivativeComponents: boolean;
    commercialDistribution: boolean;
    training?: boolean;
  };
  territories: string[];
  validity: { kind: "perpetual" } | { kind: "expires"; expiresAt: string };
  revocationTerms: string;
  redistribution:
    | { kind: "allowed" }
    | { kind: "prohibited" }
    | { kind: "conditional"; conditions: string };
  recordedAt: string;
}

export interface DesignExternalAsset {
  kind: ExternalDesignAssetKind;
  source: string;
  disposition: ExternalDesignAssetDisposition;
}

interface DesignSourceManifestBase {
  schemaVersion: typeof DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION;
  id: string;
  title: string;
  sourceUrl?: string;
  capturedAt: string;
  licenseSpdx?: string;
  licenseEvidencePath?: string;
  allowedUses: DesignUse[];
  prohibitedUses: string[];
  retentionPolicy: DesignSourceRetentionPolicy;
  trainingPolicy: DesignSourceTrainingPolicy;
  sourceContributionGroup?: string;
  externalAssets: DesignExternalAsset[];
  reviewer: string;
}

export type DesignSourceManifest =
  | (DesignSourceManifestBase & {
      sourceClass: "owned_export_authorized";
      ownerAuthorization: OwnerAuthorization;
      approvedAt: string;
    })
  | (DesignSourceManifestBase & {
      sourceClass: "visual_research_only";
      allowedUses: Array<Exclude<DesignUse, "code_transformation">>;
      retentionPolicy: "manifest_only" | "ephemeral_source";
      trainingPolicy: "prohibited";
      externalAssets: Array<
        Omit<DesignExternalAsset, "disposition"> & {
          disposition: "remove" | "replace";
        }
      >;
      ownerAuthorization?: never;
      approvedAt?: never;
    })
  | (DesignSourceManifestBase & {
      sourceClass: "platform_original" | "permissive_licensed";
      ownerAuthorization?: never;
      approvedAt?: string;
    });

export type DesignSourceManifestContractErrorCode =
  | "DESIGN_SOURCE_INVALID"
  | "DESIGN_SOURCE_POLICY_CONFLICT"
  | "DESIGN_SOURCE_LICENSE_REQUIRED"
  | "DESIGN_SOURCE_AUTHORIZATION_INVALID"
  | "DESIGN_SOURCE_TRAINING_NOT_AUTHORIZED"
  | "DESIGN_SOURCE_RESEARCH_ONLY";

export class DesignSourceManifestContractError extends Error {
  constructor(
    readonly code: DesignSourceManifestContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesignSourceManifestContractError";
  }
}

function fail(
  code: DesignSourceManifestContractErrorCode,
  message: string,
): never {
  throw new DesignSourceManifestContractError(code, message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return nonBlank(value) && Number.isFinite(Date.parse(value));
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonBlank);
}

function stringSet(value: unknown): Set<string> | null {
  if (!stringList(value)) return null;
  return new Set(value);
}

function assertExternalAssets(
  value: unknown,
): asserts value is DesignExternalAsset[] {
  if (!Array.isArray(value)) {
    fail("DESIGN_SOURCE_INVALID", "externalAssets must be an array");
  }
  for (const item of value) {
    const asset = record(item);
    if (
      !asset ||
      !hasOnlyKeys(asset, ["kind", "source", "disposition"]) ||
      !["image", "font", "icon", "script", "copy"].includes(
        String(asset.kind),
      ) ||
      !nonBlank(asset.source) ||
      !["remove", "replace", "self_host", "retain"].includes(
        String(asset.disposition),
      )
    ) {
      fail("DESIGN_SOURCE_INVALID", "external asset is invalid");
    }
  }
}

function assertOwnedAuthorization(
  value: unknown,
  trainingRequired: boolean,
  now: Date,
): asserts value is OwnerAuthorization {
  const authorization = record(value);
  const covers = authorization && record(authorization.covers);
  if (
    !authorization ||
    !covers ||
    !hasOnlyKeys(authorization, [
      "evidencePath",
      "covers",
      "territories",
      "validity",
      "revocationTerms",
      "redistribution",
      "recordedAt",
    ]) ||
    !hasOnlyKeys(covers, [
      "aiSiteBuilder",
      "derivativeComponents",
      "commercialDistribution",
      "training",
    ]) ||
    !nonBlank(authorization.evidencePath) ||
    covers.aiSiteBuilder !== true ||
    covers.derivativeComponents !== true ||
    covers.commercialDistribution !== true ||
    (covers.training !== undefined && typeof covers.training !== "boolean") ||
    !stringList(authorization.territories) ||
    authorization.territories.length === 0 ||
    !nonBlank(authorization.revocationTerms) ||
    !validTimestamp(authorization.recordedAt)
  ) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "authorization coverage is incomplete",
    );
  }
  if (Date.parse(authorization.recordedAt) > now.getTime()) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "authorization record is not yet effective",
    );
  }

  const validity = record(authorization.validity);
  if (
    !validity ||
    (validity.kind !== "perpetual" && validity.kind !== "expires")
  ) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "authorization validity is invalid",
    );
  }
  if (
    !hasOnlyKeys(
      validity,
      validity.kind === "expires" ? ["kind", "expiresAt"] : ["kind"],
    )
  ) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "authorization validity has unknown fields",
    );
  }
  if (
    validity.kind === "expires" &&
    (!validTimestamp(validity.expiresAt) ||
      Date.parse(validity.expiresAt) <= now.getTime())
  ) {
    fail("DESIGN_SOURCE_AUTHORIZATION_INVALID", "authorization has expired");
  }

  const redistribution = record(authorization.redistribution);
  if (
    !redistribution ||
    !["allowed", "prohibited", "conditional"].includes(
      String(redistribution.kind),
    ) ||
    (redistribution.kind === "conditional" &&
      !nonBlank(redistribution.conditions))
  ) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "redistribution terms are incomplete",
    );
  }
  if (
    !hasOnlyKeys(
      redistribution,
      redistribution.kind === "conditional" ? ["kind", "conditions"] : ["kind"],
    )
  ) {
    fail(
      "DESIGN_SOURCE_AUTHORIZATION_INVALID",
      "redistribution terms have unknown fields",
    );
  }
  if (trainingRequired && covers.training !== true) {
    fail(
      "DESIGN_SOURCE_TRAINING_NOT_AUTHORIZED",
      "training requires explicit authorization coverage",
    );
  }
}

/**
 * Validates a manifest at every untyped boundary. The validator deliberately
 * never maps a rejected class or privilege to a weaker, permissive state.
 */
export function validateDesignSourceManifest(
  value: unknown,
  options: { now?: Date } = {},
): DesignSourceManifest {
  const manifest = record(value);
  if (!manifest) fail("DESIGN_SOURCE_INVALID", "manifest must be an object");
  if (
    !hasOnlyKeys(manifest, [
      "schemaVersion",
      "id",
      "title",
      "sourceUrl",
      "capturedAt",
      "licenseSpdx",
      "licenseEvidencePath",
      "allowedUses",
      "prohibitedUses",
      "retentionPolicy",
      "trainingPolicy",
      "sourceContributionGroup",
      "externalAssets",
      "reviewer",
      "sourceClass",
      "ownerAuthorization",
      "approvedAt",
    ])
  ) {
    fail("DESIGN_SOURCE_INVALID", "manifest contains unknown fields");
  }
  if (manifest.schemaVersion !== DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION) {
    fail("DESIGN_SOURCE_INVALID", "unsupported manifest schema version");
  }
  if (
    !nonBlank(manifest.id) ||
    !nonBlank(manifest.title) ||
    !validTimestamp(manifest.capturedAt) ||
    !nonBlank(manifest.reviewer) ||
    (manifest.sourceUrl !== undefined && !nonBlank(manifest.sourceUrl)) ||
    (manifest.sourceContributionGroup !== undefined &&
      !nonBlank(manifest.sourceContributionGroup))
  ) {
    fail("DESIGN_SOURCE_INVALID", "manifest identity is invalid");
  }
  if (
    !DESIGN_SOURCE_CLASSES.includes(manifest.sourceClass as DesignSourceClass)
  ) {
    fail("DESIGN_SOURCE_INVALID", "sourceClass is unsupported");
  }
  const allowedUsesRaw = manifest.allowedUses;
  const allowedUses = stringSet(allowedUsesRaw);
  if (
    !allowedUses ||
    allowedUses.size === 0 ||
    !Array.isArray(allowedUsesRaw) ||
    allowedUses.size !== allowedUsesRaw.length ||
    [...allowedUses].some((use) => !DESIGN_USES.includes(use as DesignUse)) ||
    !stringList(manifest.prohibitedUses) ||
    !["manifest_only", "ephemeral_source", "licensed_archive"].includes(
      String(manifest.retentionPolicy),
    ) ||
    !["platform_corpus", "license_permits", "prohibited"].includes(
      String(manifest.trainingPolicy),
    )
  ) {
    fail("DESIGN_SOURCE_INVALID", "manifest policy is invalid");
  }
  const prohibitedUses = new Set(manifest.prohibitedUses);
  assertExternalAssets(manifest.externalAssets);

  if (manifest.sourceClass === "visual_research_only") {
    const researchOnlyAssets = manifest.externalAssets.every(
      (asset) =>
        asset.disposition === "remove" || asset.disposition === "replace",
    );
    if (
      allowedUses.has("code_transformation") ||
      manifest.retentionPolicy === "licensed_archive" ||
      manifest.trainingPolicy !== "prohibited" ||
      !researchOnlyAssets ||
      manifest.ownerAuthorization !== undefined ||
      manifest.approvedAt !== undefined
    ) {
      fail(
        "DESIGN_SOURCE_RESEARCH_ONLY",
        "visual research cannot be transformed, archived, or used for training",
      );
    }
    if ([...allowedUses].some((use) => prohibitedUses.has(use))) {
      fail(
        "DESIGN_SOURCE_POLICY_CONFLICT",
        "a use cannot be both allowed and prohibited",
      );
    }
    return manifest as unknown as DesignSourceManifest;
  }

  if ([...allowedUses].some((use) => prohibitedUses.has(use))) {
    fail(
      "DESIGN_SOURCE_POLICY_CONFLICT",
      "a use cannot be both allowed and prohibited",
    );
  }

  const needsClearLicense =
    allowedUses.has("code_transformation") ||
    manifest.trainingPolicy !== "prohibited";
  if (
    needsClearLicense &&
    (!nonBlank(manifest.licenseSpdx) || !nonBlank(manifest.licenseEvidencePath))
  ) {
    fail(
      "DESIGN_SOURCE_LICENSE_REQUIRED",
      "code transformation and licensed training require SPDX and evidence",
    );
  }

  if (
    manifest.trainingPolicy === "platform_corpus" &&
    manifest.sourceClass !== "platform_original"
  ) {
    fail(
      "DESIGN_SOURCE_TRAINING_NOT_AUTHORIZED",
      "platform corpus training is limited to platform-original sources",
    );
  }

  if (manifest.sourceClass === "owned_export_authorized") {
    const now = options.now ?? new Date();
    if (
      !validTimestamp(manifest.approvedAt) ||
      Date.parse(manifest.approvedAt) > now.getTime()
    ) {
      fail(
        "DESIGN_SOURCE_AUTHORIZATION_INVALID",
        "authorized export needs an effective approvedAt",
      );
    }
    assertOwnedAuthorization(
      manifest.ownerAuthorization,
      manifest.trainingPolicy === "license_permits",
      now,
    );
    return manifest as unknown as DesignSourceManifest;
  }

  if (manifest.ownerAuthorization !== undefined) {
    fail(
      "DESIGN_SOURCE_INVALID",
      "owner authorization is only valid for authorized exports",
    );
  }
  if (
    manifest.approvedAt !== undefined &&
    !validTimestamp(manifest.approvedAt)
  ) {
    fail("DESIGN_SOURCE_INVALID", "approvedAt is invalid");
  }
  return manifest as unknown as DesignSourceManifest;
}
