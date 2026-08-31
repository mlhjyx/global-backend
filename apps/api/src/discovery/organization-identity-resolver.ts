import type { Prisma } from "@prisma/client";
import { types } from "node:util";
import {
  assertWorkspaceSuppressionThenIdentityLock,
  lockWorkspaceSuppressionThenIdentity,
  type SuppressionThenIdentityLockReceipt,
} from "./organization-identity-lock";

const RECEIPT_VERSION = "organization-identity-resolution-receipt/v1" as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS = [
  "outcome_kind",
  "raw_record_id",
  "company_id",
  "conflict_id",
  "match_rule",
  "input_hash",
  "conflict_fingerprint",
  "replayed",
  "company_created",
  "identifier_count",
  "party_count",
] as const;
const ERROR_PROXY_KEYS = [
  "code",
  "sqlState",
  "sqlstate",
  "sql_state",
  "message",
  "meta",
  "cause",
  "error",
  "original",
  "originalError",
  "driverError",
] as const;

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
  | "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT"
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

type V2MatchRule = "identity_v2" | "domain_exact" | "name_country";
type LegacyMatchRule = "identifier_exact" | "domain_exact" | "name_country";

export type OrganizationIdentityResolutionReceipt =
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "bound";
      rawRecordId: string;
      companyId: string;
      matchRule: V2MatchRule;
      inputHash: string;
      replayed: boolean;
      identifierCount: number;
    }>
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "created";
      rawRecordId: string;
      companyId: string;
      matchRule: V2MatchRule;
      inputHash: string;
      replayed: false;
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
    }>
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "legacy_bound";
      rawRecordId: string;
      companyId: string;
      matchRule: LegacyMatchRule;
      inputHash: "legacy";
      replayed: true;
    }>
  | Readonly<{
      schemaVersion: typeof RECEIPT_VERSION;
      kind: "suppressed";
      rawRecordId: string;
      replayed: false;
    }>;

type DbReceiptRow = Readonly<Record<(typeof RECEIPT_KEYS)[number], unknown>>;
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
  const workspace = descriptors.workspaceId;
  const rawRecord = descriptors.rawRecordId;
  if (
    !workspace ||
    !workspace.enumerable ||
    !("value" in workspace) ||
    typeof workspace.value !== "string" ||
    !UUID.test(workspace.value) ||
    !rawRecord ||
    !rawRecord.enumerable ||
    !("value" in rawRecord) ||
    typeof rawRecord.value !== "string" ||
    !UUID.test(rawRecord.value)
  ) {
    return fail("IDENTITY_RESOLUTION_INPUT_INVALID");
  }
  return Object.freeze({
    workspaceId: workspace.value,
    rawRecordId: rawRecord.value,
  });
}

function exactReceiptRow(rows: unknown): DbReceiptRow {
  if (
    rows === null ||
    typeof rows !== "object" ||
    types.isProxy(rows) ||
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  const arrayKeys = Reflect.ownKeys(rows);
  const length = Object.getOwnPropertyDescriptor(rows, "length");
  const item = Object.getOwnPropertyDescriptor(rows, "0");
  if (
    arrayKeys.length !== 2 ||
    !arrayKeys.includes("0") ||
    !arrayKeys.includes("length") ||
    !length ||
    !("value" in length) ||
    length.value !== 1 ||
    !item ||
    !item.enumerable ||
    !("value" in item)
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  const row = item.value;
  if (
    row === null ||
    typeof row !== "object" ||
    types.isProxy(row) ||
    Array.isArray(row) ||
    Object.getPrototypeOf(row) !== Object.prototype
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== RECEIPT_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !RECEIPT_KEYS.includes(key as (typeof RECEIPT_KEYS)[number]),
    )
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (
    RECEIPT_KEYS.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  return Object.freeze(
    Object.fromEntries(
      RECEIPT_KEYS.map((key) => [key, descriptors[key]?.value]),
    ),
  ) as DbReceiptRow;
}

function integer(value: unknown, maximum: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

function v2MatchRule(value: unknown): V2MatchRule | null {
  return value === "identity_v2" ||
    value === "domain_exact" ||
    value === "name_country"
    ? value
    : null;
}

function legacyMatchRule(value: unknown): LegacyMatchRule | null {
  return value === "identifier_exact" ||
    value === "domain_exact" ||
    value === "name_country"
    ? value
    : null;
}

function parseReceipt(
  rows: unknown,
  expectedRawRecordId: string,
): OrganizationIdentityResolutionReceipt {
  const row = exactReceiptRow(rows);
  if (
    typeof row.raw_record_id !== "string" ||
    !UUID.test(row.raw_record_id) ||
    row.raw_record_id !== expectedRawRecordId ||
    typeof row.replayed !== "boolean" ||
    typeof row.company_created !== "boolean"
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }

  if (row.outcome_kind === "bound" || row.outcome_kind === "created") {
    const matchRule = v2MatchRule(row.match_rule);
    const identifierCount = integer(row.identifier_count, 32);
    const created = row.outcome_kind === "created";
    if (
      typeof row.company_id !== "string" ||
      !UUID.test(row.company_id) ||
      row.conflict_id !== null ||
      matchRule === null ||
      typeof row.input_hash !== "string" ||
      !SHA256.test(row.input_hash) ||
      row.conflict_fingerprint !== null ||
      row.company_created !== created ||
      (created && row.replayed !== false) ||
      identifierCount === null ||
      row.party_count !== 0
    ) {
      return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
    }
    if (created) {
      return Object.freeze({
        schemaVersion: RECEIPT_VERSION,
        kind: "created",
        rawRecordId: row.raw_record_id,
        companyId: row.company_id,
        matchRule,
        inputHash: row.input_hash,
        replayed: false,
        identifierCount,
      });
    }
    return Object.freeze({
      schemaVersion: RECEIPT_VERSION,
      kind: "bound",
      rawRecordId: row.raw_record_id,
      companyId: row.company_id,
      matchRule,
      inputHash: row.input_hash,
      replayed: row.replayed,
      identifierCount,
    });
  }

  if (row.outcome_kind === "conflict") {
    const partyCount = integer(row.party_count, 64);
    if (
      row.company_id !== null ||
      typeof row.conflict_id !== "string" ||
      !UUID.test(row.conflict_id) ||
      row.match_rule !== "identity_conflict" ||
      typeof row.input_hash !== "string" ||
      !SHA256.test(row.input_hash) ||
      typeof row.conflict_fingerprint !== "string" ||
      !SHA256.test(row.conflict_fingerprint) ||
      row.company_created !== false ||
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

  if (row.outcome_kind === "legacy_bound") {
    const matchRule = legacyMatchRule(row.match_rule);
    if (
      typeof row.company_id !== "string" ||
      !UUID.test(row.company_id) ||
      row.conflict_id !== null ||
      matchRule === null ||
      row.input_hash !== "legacy" ||
      row.conflict_fingerprint !== null ||
      row.replayed !== true ||
      row.company_created !== false ||
      row.identifier_count !== 0 ||
      row.party_count !== 0
    ) {
      return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
    }
    return Object.freeze({
      schemaVersion: RECEIPT_VERSION,
      kind: "legacy_bound",
      rawRecordId: row.raw_record_id,
      companyId: row.company_id,
      matchRule,
      inputHash: "legacy",
      replayed: true,
    });
  }

  if (
    row.outcome_kind !== "suppressed" ||
    row.company_id !== null ||
    row.conflict_id !== null ||
    row.match_rule !== null ||
    row.input_hash !== null ||
    row.conflict_fingerprint !== null ||
    row.replayed !== false ||
    row.company_created !== false ||
    row.identifier_count !== 0 ||
    row.party_count !== 0
  ) {
    return fail("IDENTITY_RESOLUTION_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: RECEIPT_VERSION,
    kind: "suppressed",
    rawRecordId: row.raw_record_id,
    replayed: false,
  });
}

type DatabaseErrorFacts = Readonly<{
  codes: ReadonlySet<string>;
  messages: readonly string[];
}>;

function dataDescriptors(value: object): readonly [PropertyKey, unknown][] {
  if (!types.isProxy(value)) {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Reflect.ownKeys(descriptors).flatMap((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return descriptor && "value" in descriptor
          ? ([[key, descriptor.value]] as const)
          : [];
      });
    } catch {
      return [];
    }
  }
  return ERROR_PROXY_KEYS.flatMap((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor
        ? ([[key, descriptor.value]] as const)
        : [];
    } catch {
      return [];
    }
  });
}

function databaseErrorFacts(error: unknown): DatabaseErrorFacts {
  const codes = new Set<string>();
  const messages: string[] = [];
  const seen = new WeakSet<object>();
  const pending: unknown[] = [error];
  let cursor = 0;
  while (cursor < pending.length) {
    const current = pending[cursor];
    cursor += 1;
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const [key, value] of dataDescriptors(current)) {
      if (typeof key === "string" && typeof value === "string") {
        const normalized = key.toLowerCase().replaceAll("_", "");
        if (normalized === "code" || normalized === "sqlstate") {
          codes.add(value);
        }
        if (normalized === "message") messages.push(value);
      }
      if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  return Object.freeze({
    codes,
    messages: Object.freeze([...messages]),
  });
}

function hasMessageToken(
  facts: DatabaseErrorFacts,
  token: OrganizationIdentityResolverErrorCode,
): boolean {
  const exactToken = new RegExp(
    `(?:^|[^A-Z0-9_])${token}(?:$|[^A-Z0-9_])`,
    "u",
  );
  return facts.messages.some((message) => exactToken.test(message));
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof OrganizationIdentityResolverError) throw error;
  const facts = databaseErrorFacts(error);
  if (facts.codes.has("57014")) {
    return fail("IDENTITY_RESOLUTION_STATEMENT_TIMEOUT");
  }
  if (facts.codes.has("55P03")) {
    return fail("IDENTITY_RESOLUTION_LOCK_TIMEOUT");
  }
  if (facts.codes.has("42501")) {
    return fail("IDENTITY_RESOLUTION_COMMAND_DENIED");
  }
  if (facts.codes.has("40001")) {
    return fail("IDENTITY_RESOLUTION_PLAN_STALE");
  }
  for (const token of [
    "IDENTITY_RESOLUTION_INPUT_INVALID",
    "IDENTITY_RAW_NOT_RESOLVABLE",
    "IDENTITY_RAW_PROCESSING_RESTRICTED",
    "IDENTITY_INPUT_DRIFT",
    "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
    "IDENTITY_RESOLUTION_SUPPRESSED",
    "IDENTITY_RESOLUTION_STATE_INVALID",
  ] as const) {
    if (facts.codes.has("P0001") && hasMessageToken(facts, token)) {
      return fail(token);
    }
  }
  return fail("IDENTITY_RESOLUTION_STATE_INVALID");
}

/**
 * Official source contract. The caller owns one app_user tenant transaction.
 * A supplied lock receipt must have been created by the same transaction and
 * workspace; otherwise this function fails without silently reacquiring.
 */
export async function resolveOrganizationIdentityForRaw(
  tx: TransactionClient,
  unsafeInput: ResolveOrganizationIdentityForRawInput,
  lockReceipt?: SuppressionThenIdentityLockReceipt,
): Promise<OrganizationIdentityResolutionReceipt> {
  try {
    const input = exactInput(unsafeInput);
    if (lockReceipt === undefined) {
      await lockWorkspaceSuppressionThenIdentity(tx, input.workspaceId);
    } else {
      assertWorkspaceSuppressionThenIdentityLock(
        lockReceipt,
        tx,
        input.workspaceId,
      );
    }
    const rows: unknown = await tx.$queryRaw`
      SELECT
        outcome_kind,
        raw_record_id,
        company_id,
        conflict_id,
        match_rule,
        input_hash,
        conflict_fingerprint,
        replayed,
        company_created,
        identifier_count,
        party_count
      FROM public.resolve_organization_identity_for_raw_v1(
        ${input.workspaceId}::text,
        ${input.rawRecordId}::text
      )`;
    return parseReceipt(rows, input.rawRecordId);
  } catch (error) {
    return mapDatabaseError(error);
  }
}
