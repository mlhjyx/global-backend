import { Prisma } from "@prisma/client";
import { types } from "node:util";
import { companyIdentity } from "./identity";
import { extractOrganizationIdentityAuthority } from "./organization-identity-authority";
import {
  planOrganizationIdentityResolution,
  type OrganizationIdentityResolutionPlan,
} from "./organization-identity-resolution-plan";
import { lockWorkspaceSuppressionThenIdentity } from "./organization-identity-lock";
import { validateRawSourceProviderPayload } from "./raw-source-provider-schema";
import { RAW_SOURCE_RESTRICT_PROCESSING_EFFECT } from "./raw-source-governance";
import { RAW_SOURCE_INGEST_VERSION } from "./raw-source-ingestion";
import { companyMatchesSuppression } from "./suppression-value";

const RECEIPT_VERSION = "organization-identity-resolution-receipt/v1" as const;
const COMMAND_VERSION = "organization-identity-resolution-command/v1" as const;
const RESOLVER_VERSION = "organization-identity-resolver/v1" as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type OrganizationIdentityResolverErrorCode =
  | "IDENTITY_RESOLUTION_INPUT_INVALID"
  | "IDENTITY_RAW_NOT_RESOLVABLE"
  | "IDENTITY_RAW_PROCESSING_RESTRICTED"
  | "IDENTITY_RESOLUTION_SUPPRESSED"
  | "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED"
  | "IDENTITY_INPUT_DRIFT"
  | "IDENTITY_RESOLUTION_STATE_INVALID"
  | "IDENTITY_RESOLUTION_PLAN_STALE"
  | "IDENTITY_RESOLUTION_LOCK_TIMEOUT"
  | "IDENTITY_RESOLUTION_COMMAND_DENIED"
  | "IDENTITY_RESOLUTION_RECEIPT_INVALID";

export class OrganizationIdentityResolverError extends Error {
  constructor(public readonly code: OrganizationIdentityResolverErrorCode) {
    super("organization identity resolution failed");
    this.name = "OrganizationIdentityResolverError";
  }
}

export type ResolveOrganizationIdentityForRawInput = Readonly<{
  workspaceId: string;
  rawRecordId: string;
}>;

export type OrganizationIdentityResolutionReceipt =
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "bound";
      rawRecordId: string;
      companyId: string;
      matchRule: "identity_v2" | "domain_exact" | "name_country";
      inputHash: string;
      replayed: boolean;
      identifierCount: number;
    }>
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "conflict";
      rawRecordId: string;
      conflictId: string;
      matchRule: "identity_conflict";
      inputHash: string;
      conflictFingerprint: string;
      replayed: boolean;
      partyCount: number;
    }>;

type RawRow = Readonly<{
  id: string;
  workspace_id: string;
  provider_key: string;
  payload: unknown;
  payload_hash: string;
  ingest_version: string;
  ingest_status: string;
  is_current: boolean;
}>;

type DbReceiptRow = Readonly<{
  outcome_kind: unknown;
  raw_record_id: unknown;
  company_id: unknown;
  conflict_id: unknown;
  match_rule: unknown;
  input_hash: unknown;
  conflict_fingerprint: unknown;
  replayed: unknown;
  identifier_count: unknown;
  party_count: unknown;
}>;

type TransactionClient = Prisma.TransactionClient;

function fail(code: OrganizationIdentityResolverErrorCode): never {
  throw new OrganizationIdentityResolverError(code);
}

function exactInput(value: unknown): ResolveOrganizationIdentityForRawInput {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("IDENTITY_RESOLUTION_INPUT_INVALID");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key !== "string") ||
    !keys.includes("workspaceId") ||
    !keys.includes("rawRecordId")
  ) {
    return fail("IDENTITY_RESOLUTION_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ["workspaceId", "rawRecordId"] as const) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return fail("IDENTITY_RESOLUTION_INPUT_INVALID");
    }
  }
  const workspaceId = descriptors.workspaceId?.value;
  const rawRecordId = descriptors.rawRecordId?.value;
  if (
    typeof workspaceId !== "string" ||
    typeof rawRecordId !== "string" ||
    !UUID.test(workspaceId) ||
    !UUID.test(rawRecordId)
  ) {
    return fail("IDENTITY_RESOLUTION_INPUT_INVALID");
  }
  return Object.freeze({ workspaceId, rawRecordId });
}

function one<T>(
  rows: readonly T[],
  code: OrganizationIdentityResolverErrorCode,
): T {
  if (rows.length !== 1) return fail(code);
  return rows[0] as T;
}

function integer(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
    ? Number(value)
    : null;
}

function parseReceipt(
  rows: readonly DbReceiptRow[],
): OrganizationIdentityResolutionReceipt {
  const row = one(rows, "IDENTITY_RESOLUTION_RECEIPT_INVALID");
  if (
    typeof row.raw_record_id !== "string" ||
    !UUID.test(row.raw_record_id) ||
    typeof row.input_hash !== "string" ||
    !SHA256.test(row.input_hash) ||
    typeof row.replayed !== "boolean"
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  if (row.outcome_kind === "bound") {
    const identifierCount = integer(row.identifier_count, 32);
    if (
      typeof row.company_id !== "string" ||
      !UUID.test(row.company_id) ||
      row.conflict_id !== null ||
      row.conflict_fingerprint !== null ||
      !["identity_v2", "domain_exact", "name_country"].includes(
        String(row.match_rule),
      ) ||
      identifierCount === null ||
      row.party_count !== 0
    ) {
      return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
    }
    return Object.freeze({
      schemaVersion: RECEIPT_VERSION,
      kind: "bound",
      rawRecordId: row.raw_record_id,
      companyId: row.company_id,
      matchRule: row.match_rule as
        "identity_v2" | "domain_exact" | "name_country",
      inputHash: row.input_hash,
      replayed: row.replayed,
      identifierCount,
    });
  }
  const partyCount = integer(row.party_count, 64);
  if (
    row.outcome_kind !== "conflict" ||
    row.company_id !== null ||
    typeof row.conflict_id !== "string" ||
    !UUID.test(row.conflict_id) ||
    row.match_rule !== "identity_conflict" ||
    typeof row.conflict_fingerprint !== "string" ||
    !SHA256.test(row.conflict_fingerprint) ||
    row.identifier_count !== 0 ||
    partyCount === null ||
    partyCount < 2
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: RECEIPT_VERSION,
    kind: "conflict",
    rawRecordId: row.raw_record_id,
    conflictId: row.conflict_id,
    matchRule: "identity_conflict",
    inputHash: row.input_hash,
    conflictFingerprint: row.conflict_fingerprint,
    replayed: row.replayed,
    partyCount,
  });
}

function postgresCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || types.isProxy(error)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function postgresMessage(error: unknown): string | null {
  if (error === null || typeof error !== "object" || types.isProxy(error)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof OrganizationIdentityResolverError) throw error;
  const code = postgresCode(error);
  const message = postgresMessage(error) ?? "";
  if (code === "42501") return fail("IDENTITY_RESOLUTION_COMMAND_DENIED");
  if (code === "55P03" || code === "57014") {
    return fail("IDENTITY_RESOLUTION_LOCK_TIMEOUT");
  }
  if (code === "40001" || message.includes("IDENTITY_RESOLUTION_PLAN_STALE")) {
    return fail("IDENTITY_RESOLUTION_PLAN_STALE");
  }
  for (const known of [
    "IDENTITY_INPUT_DRIFT",
    "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
    "IDENTITY_RESOLUTION_SUPPRESSED",
  ] as const) {
    if (message.includes(known)) return fail(known);
  }
  return fail("IDENTITY_RESOLUTION_STATE_INVALID");
}

function keyForIdentifier(identifier: {
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
}): string {
  return `${identifier.scheme}:${identifier.jurisdiction}:${identifier.normalizedValue}`;
}

function targetCompanyId(
  plan: OrganizationIdentityResolutionPlan,
): string | null {
  return plan.kind === "bind_existing" || plan.kind === "lazy_upgrade"
    ? plan.companyId
    : null;
}

/**
 * Internal source contract only. The caller owns the tenant transaction and
 * must have already set app.current_workspace_id on the same app_user session.
 */
export async function resolveOrganizationIdentityForRaw(
  tx: TransactionClient,
  unsafeInput: ResolveOrganizationIdentityForRawInput,
): Promise<OrganizationIdentityResolutionReceipt> {
  const input = exactInput(unsafeInput);
  await lockWorkspaceSuppressionThenIdentity(tx, input.workspaceId);

  const raw = one(
    await tx.$queryRaw<RawRow[]>`
      SELECT
        "id",
        "workspace_id",
        "provider_key",
        "payload",
        "payload_hash",
        "ingest_version",
        "ingest_status",
        ("expires_at" IS NULL OR "expires_at" > statement_timestamp()) AS "is_current"
      FROM "raw_source_record"
      WHERE "workspace_id" = ${input.workspaceId}::uuid
        AND "id" = ${input.rawRecordId}::uuid
      FOR KEY SHARE`,
    "IDENTITY_RAW_NOT_RESOLVABLE",
  );
  if (
    raw.id !== input.rawRecordId ||
    raw.workspace_id !== input.workspaceId ||
    raw.ingest_version !== RAW_SOURCE_INGEST_VERSION ||
    raw.ingest_status !== "ACCEPTED" ||
    raw.is_current !== true ||
    typeof raw.payload_hash !== "string" ||
    !SHA256.test(raw.payload_hash)
  ) {
    return fail("IDENTITY_RAW_NOT_RESOLVABLE");
  }

  const restricted = await tx.rawSourceGovernanceDisposition.findFirst({
    where: {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      effect: RAW_SOURCE_RESTRICT_PROCESSING_EFFECT,
    },
    select: { id: true },
  });
  if (restricted) return fail("IDENTITY_RAW_PROCESSING_RESTRICTED");

  let authorityIdentifiers;
  const admitted = validateRawSourceProviderPayload(
    raw.provider_key,
    raw.payload,
  );
  if (!admitted.ok) return fail("IDENTITY_RAW_NOT_RESOLVABLE");
  try {
    authorityIdentifiers = extractOrganizationIdentityAuthority(
      raw.provider_key,
      admitted.value,
    );
  } catch {
    return fail("IDENTITY_RAW_NOT_RESOLVABLE");
  }
  const name = admitted.value.name;
  if (typeof name !== "string") return fail("IDENTITY_RAW_NOT_RESOLVABLE");
  const domain =
    typeof admitted.value.domain === "string" ? admitted.value.domain : null;
  const country =
    typeof admitted.value.country === "string" ? admitted.value.country : null;
  const blocker = companyIdentity({ name, domain, country });
  if (blocker.matchRule === "identifier_exact") {
    return fail("IDENTITY_RESOLUTION_STATE_INVALID");
  }

  const legacyCompany = await tx.canonicalCompany.findUnique({
    where: {
      workspaceId_dedupeKey: {
        workspaceId: input.workspaceId,
        dedupeKey: blocker.dedupeKey,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      domain: true,
      status: true,
      dedupeKey: true,
    },
  });
  const activeIdentifiers = authorityIdentifiers.length
    ? await tx.organizationIdentifier.findMany({
        where: {
          workspaceId: input.workspaceId,
          status: "ACTIVE",
          OR: authorityIdentifiers.map((identifier) => ({
            scheme: identifier.scheme,
            jurisdiction: identifier.jurisdiction,
            normalizedValue: identifier.normalizedValue,
          })),
        },
        select: {
          scheme: true,
          jurisdiction: true,
          normalizedValue: true,
          companyId: true,
        },
      })
    : [];
  const bindings = activeIdentifiers.map((identifier) => ({
    identifierKey: keyForIdentifier(identifier),
    companyId: identifier.companyId,
  }));
  const involvedCompanyIds = [
    ...new Set([
      ...bindings.map((binding) => binding.companyId),
      ...(legacyCompany ? [legacyCompany.id] : []),
    ]),
  ].sort();
  const mappings = involvedCompanyIds.length
    ? await tx.organizationCanonicalMapping.findMany({
        where: {
          workspaceId: input.workspaceId,
          status: "ACTIVE",
          sourceCompanyId: { in: involvedCompanyIds },
        },
        select: { sourceCompanyId: true, canonicalCompanyId: true },
      })
    : [];
  const rootMappings = mappings.map((mapping) => ({
    sourceCompanyId: mapping.sourceCompanyId,
    rootCompanyId: mapping.canonicalCompanyId,
  }));
  const candidateIds = [
    ...new Set([
      ...involvedCompanyIds,
      ...rootMappings.map((mapping) => mapping.rootCompanyId),
    ]),
  ].sort();
  const companies = candidateIds.length
    ? await tx.canonicalCompany.findMany({
        where: { workspaceId: input.workspaceId, id: { in: candidateIds } },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          domain: true,
          status: true,
          dedupeKey: true,
        },
      })
    : [];
  if (
    companies.length !== candidateIds.length ||
    companies.some(
      (company) =>
        company.workspaceId !== input.workspaceId ||
        !candidateIds.includes(company.id),
    )
  ) {
    return fail("IDENTITY_RESOLUTION_STATE_INVALID");
  }
  const suppressions = await tx.suppressionRecord.findMany({
    where: {
      workspaceId: input.workspaceId,
      type: { in: ["domain", "company_name"] },
    },
    select: { type: true, value: true },
  });
  if (
    companyMatchesSuppression(suppressions, { name, domain }) ||
    companies.some(
      (company) =>
        company.status === "SUPPRESSED" ||
        companyMatchesSuppression(suppressions, company),
    )
  ) {
    return fail("IDENTITY_RESOLUTION_SUPPRESSED");
  }

  let plan: OrganizationIdentityResolutionPlan;
  try {
    plan = planOrganizationIdentityResolution({
      raw: {
        rawRecordId: raw.id,
        providerKey: raw.provider_key,
        payloadHash: raw.payload_hash,
        ingestVersion: raw.ingest_version,
      },
      resolverVersion: RESOLVER_VERSION,
      blocker: {
        blockerKey: blocker.dedupeKey,
        matchRule: blocker.matchRule,
        legacyCandidateCompanyId: legacyCompany?.id ?? null,
      },
      authorityIdentifiers,
      existingBindings: bindings,
      rootMappings,
    });
  } catch {
    return fail("IDENTITY_RESOLUTION_STATE_INVALID");
  }

  let companyId = targetCompanyId(plan);
  if (plan.kind === "create_new") {
    const created = await tx.canonicalCompany.create({
      data: {
        workspaceId: input.workspaceId,
        name,
        domain,
        country,
        status: "NEW",
        dedupeKey: blocker.dedupeKey,
        attributes: Prisma.DbNull,
      },
      select: { id: true },
    });
    companyId = created.id;
  }

  const command = {
    schemaVersion: COMMAND_VERSION,
    workspaceId: input.workspaceId,
    raw: {
      rawRecordId: raw.id,
      providerKey: raw.provider_key,
      payloadHash: raw.payload_hash,
      ingestVersion: raw.ingest_version,
    },
    blocker: {
      blockerKey: blocker.dedupeKey,
      matchRule: blocker.matchRule,
      legacyCandidateCompanyId: legacyCompany?.id ?? null,
    },
    authorityIdentifiers,
    existingBindings: bindings,
    rootMappings,
    plan,
    targetCompanyId: companyId,
  } as const;

  try {
    const rows = await tx.$queryRaw<DbReceiptRow[]>`
      SELECT *
      FROM public.apply_organization_identity_resolution_v1(${JSON.stringify(
        command,
      )}::jsonb)`;
    const receipt = parseReceipt(rows);
    if (
      receipt.rawRecordId !== input.rawRecordId ||
      receipt.inputHash !== plan.inputHash ||
      receipt.matchRule !== plan.matchRule ||
      (receipt.kind === "bound" && receipt.companyId !== companyId) ||
      (receipt.kind === "conflict" &&
        (plan.kind !== "conflict" ||
          receipt.conflictFingerprint !== plan.conflictFingerprint))
    ) {
      return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
    }
    return receipt;
  } catch (error) {
    return mapDatabaseError(error);
  }
}
