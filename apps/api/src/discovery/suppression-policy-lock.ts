import type { Prisma } from "@prisma/client";
import { types } from "node:util";

const POLICY_LOCK_RECEIPT = Symbol("workspace-suppression-policy-lock");
const GENERIC_ERROR_MESSAGE = "organization identity resolution failed";
const MAX_ERROR_GRAPH_NODES = 1024;
const MAX_ERROR_GRAPH_DEPTH = 1023;
const MAX_ERROR_GRAPH_QUEUE = 1024;
const MAX_ERROR_PROPERTIES_PER_NODE = 2048;
const ERROR_PROXY_KEYS = [
  "code",
  "sqlState",
  "sqlstate",
  "sql_state",
  "message",
  "meta",
  "cause",
  "error",
  "errors",
  "original",
  "originalError",
  "driverError",
] as const;
const DOMAIN_ERROR_CODES = [
  "IDENTITY_RESOLUTION_INPUT_INVALID",
  "IDENTITY_RAW_NOT_RESOLVABLE",
  "IDENTITY_RAW_PROCESSING_RESTRICTED",
  "IDENTITY_RESOLUTION_SUPPRESSED",
  "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
  "IDENTITY_INPUT_DRIFT",
  "IDENTITY_RESOLUTION_STATE_INVALID",
  "IDENTITY_RESOLUTION_PLAN_STALE",
  "IDENTITY_RESOLUTION_LOCK_TIMEOUT",
  "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
  "IDENTITY_RESOLUTION_COMMAND_DENIED",
  "IDENTITY_RESOLUTION_RECEIPT_INVALID",
] as const;
const REVIEWED_P0001_CODES = [
  "IDENTITY_RESOLUTION_INPUT_INVALID",
  "IDENTITY_RAW_NOT_RESOLVABLE",
  "IDENTITY_RAW_PROCESSING_RESTRICTED",
  "IDENTITY_INPUT_DRIFT",
  "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
  "IDENTITY_RESOLUTION_SUPPRESSED",
  "IDENTITY_RESOLUTION_STATE_INVALID",
] as const;

export type OrganizationIdentityResolverErrorCode =
  (typeof DOMAIN_ERROR_CODES)[number];

export class OrganizationIdentityResolverError extends Error {
  declare public readonly code: OrganizationIdentityResolverErrorCode;

  constructor(code: OrganizationIdentityResolverErrorCode) {
    super(GENERIC_ERROR_MESSAGE);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    delete this.stack;
    Object.freeze(this);
  }

  override get name(): string {
    return "OrganizationIdentityResolverError";
  }
}

export type SuppressionPolicyLockReceipt = Readonly<{
  workspaceId: string;
  [POLICY_LOCK_RECEIPT]: Prisma.TransactionClient;
}>;

type ErrorEnvelope = Readonly<{
  ordinary: boolean;
  codes: readonly string[];
  messages: readonly string[];
}>;

type ErrorGraph = Readonly<{
  codes: ReadonlySet<string>;
  envelopes: readonly ErrorEnvelope[];
  truncated: boolean;
}>;

type DescriptorScan = Readonly<{
  entries: readonly (readonly [PropertyKey, unknown])[];
  truncated: boolean;
}>;

function dataDescriptors(value: object): DescriptorScan {
  if (!types.isProxy(value)) {
    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      return Object.freeze({ entries: Object.freeze([]), truncated: true });
    }
    let truncated = keys.length > MAX_ERROR_PROPERTIES_PER_NODE;
    const entries = keys
      .slice(0, MAX_ERROR_PROPERTIES_PER_NODE)
      .flatMap((key) => {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor && "value" in descriptor
            ? ([[key, descriptor.value]] as const)
            : [];
        } catch {
          truncated = true;
          return [];
        }
      });
    return Object.freeze({
      entries: Object.freeze(entries),
      truncated,
    });
  }
  let truncated = false;
  const entries = ERROR_PROXY_KEYS.flatMap((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor
        ? ([[key, descriptor.value]] as const)
        : [];
    } catch {
      truncated = true;
      return [];
    }
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    truncated,
  });
}

function isOrdinaryErrorEnvelope(value: object): boolean {
  if (types.isProxy(value)) return false;
  try {
    return (
      types.isNativeError(value) ||
      Object.getPrototypeOf(value) === Object.prototype
    );
  } catch {
    return false;
  }
}

function inspectErrorGraph(error: unknown): ErrorGraph {
  const codes = new Set<string>();
  const envelopes: ErrorEnvelope[] = [];
  const scheduled = new WeakSet<object>();
  const pending: Array<Readonly<{ value: object; depth: number }>> = [];
  if (error !== null && typeof error === "object") {
    scheduled.add(error);
    pending.push(Object.freeze({ value: error, depth: 0 }));
  }
  let cursor = 0;
  let inspectedNodes = 0;
  let truncated = false;
  while (cursor < pending.length) {
    if (inspectedNodes >= MAX_ERROR_GRAPH_NODES) {
      truncated = true;
      break;
    }
    const currentNode = pending[cursor];
    cursor += 1;
    if (!currentNode) {
      truncated = true;
      break;
    }
    inspectedNodes += 1;
    const current = currentNode.value;
    const nodeCodes: string[] = [];
    const nodeMessages: string[] = [];
    const descriptorScan = dataDescriptors(current);
    if (descriptorScan.truncated) truncated = true;
    for (const [key, value] of descriptorScan.entries) {
      if (typeof key === "string" && typeof value === "string") {
        const normalized = key.toLowerCase().replaceAll("_", "");
        if (normalized === "code" || normalized === "sqlstate") {
          codes.add(value);
          nodeCodes.push(value);
        }
        if (normalized === "message") nodeMessages.push(value);
      }
      if (value === null || typeof value !== "object" || scheduled.has(value)) {
        continue;
      }
      if (currentNode.depth >= MAX_ERROR_GRAPH_DEPTH) {
        truncated = true;
        continue;
      }
      if (pending.length >= MAX_ERROR_GRAPH_QUEUE) {
        truncated = true;
        continue;
      }
      scheduled.add(value);
      pending.push(Object.freeze({ value, depth: currentNode.depth + 1 }));
    }
    envelopes.push(
      Object.freeze({
        ordinary: isOrdinaryErrorEnvelope(current),
        codes: Object.freeze([...nodeCodes]),
        messages: Object.freeze([...nodeMessages]),
      }),
    );
  }
  return Object.freeze({
    codes,
    envelopes: Object.freeze([...envelopes]),
    truncated,
  });
}

function hasExactMessageToken(message: string, token: string): boolean {
  return new RegExp(`(?:^|[^A-Z0-9_])${token}(?:$|[^A-Z0-9_])`, "u").test(
    message,
  );
}

function directDomainCode(
  error: unknown,
): OrganizationIdentityResolverErrorCode | null {
  if (error === null || typeof error !== "object" || types.isProxy(error)) {
    return null;
  }
  try {
    if (!(error instanceof OrganizationIdentityResolverError)) return null;
  } catch {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !DOMAIN_ERROR_CODES.includes(
      descriptor.value as OrganizationIdentityResolverErrorCode,
    )
  ) {
    return null;
  }
  return descriptor.value as OrganizationIdentityResolverErrorCode;
}

export function throwOrganizationIdentityError(
  code: OrganizationIdentityResolverErrorCode,
): never {
  throw new OrganizationIdentityResolverError(code);
}

export function mapOrganizationIdentitySourceError(error: unknown): never {
  const graph = inspectErrorGraph(error);
  if (graph.codes.has("57014")) {
    return throwOrganizationIdentityError(
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  }
  if (graph.truncated) {
    return throwOrganizationIdentityError(
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  }
  if (graph.codes.has("55P03")) {
    return throwOrganizationIdentityError("IDENTITY_RESOLUTION_LOCK_TIMEOUT");
  }
  if (graph.codes.has("42501")) {
    return throwOrganizationIdentityError("IDENTITY_RESOLUTION_COMMAND_DENIED");
  }
  if (graph.codes.has("40001")) {
    return throwOrganizationIdentityError("IDENTITY_RESOLUTION_PLAN_STALE");
  }
  const domainCode = directDomainCode(error);
  if (domainCode !== null) return throwOrganizationIdentityError(domainCode);
  for (const token of REVIEWED_P0001_CODES) {
    if (
      graph.envelopes.some(
        (envelope) =>
          envelope.ordinary &&
          envelope.codes.includes("P0001") &&
          envelope.messages.some((message) =>
            hasExactMessageToken(message, token),
          ),
      )
    ) {
      return throwOrganizationIdentityError(token);
    }
  }
  return throwOrganizationIdentityError("IDENTITY_RESOLUTION_STATE_INVALID");
}

export function assertExactDatabaseScalarReceipt(
  rows: unknown,
  key: string,
  expected: string,
): void {
  if (
    rows === null ||
    typeof rows !== "object" ||
    types.isProxy(rows) ||
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype
  ) {
    throw new Error("database scalar receipt invalid");
  }
  const keys = Reflect.ownKeys(rows);
  const length = Object.getOwnPropertyDescriptor(rows, "length");
  const item = Object.getOwnPropertyDescriptor(rows, "0");
  if (
    keys.length !== 2 ||
    !keys.includes("0") ||
    !keys.includes("length") ||
    !length ||
    length.enumerable ||
    !("value" in length) ||
    length.value !== 1 ||
    !item ||
    !item.enumerable ||
    !("value" in item)
  ) {
    throw new Error("database scalar receipt invalid");
  }
  const row = item.value;
  if (
    row === null ||
    typeof row !== "object" ||
    types.isProxy(row) ||
    Array.isArray(row) ||
    Object.getPrototypeOf(row) !== Object.prototype
  ) {
    throw new Error("database scalar receipt invalid");
  }
  const rowKeys = Reflect.ownKeys(row);
  const scalar = Object.getOwnPropertyDescriptor(row, key);
  if (
    rowKeys.length !== 1 ||
    rowKeys[0] !== key ||
    !scalar ||
    !scalar.enumerable ||
    !("value" in scalar) ||
    scalar.value !== expected
  ) {
    throw new Error("database scalar receipt invalid");
  }
}

/**
 * Linearization point shared by suppression creation and commit-side acquisition actions.
 *
 * The lock is transaction-scoped, tenant-scoped, and contains no PII. If an action acquires it
 * first, its write is ordered before the later suppression. If suppression creation acquires it
 * first, every later action rereads the committed append-only fact and fails closed.
 */
export async function lockWorkspaceSuppressionPolicy(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<SuppressionPolicyLockReceipt> {
  const rows: unknown = await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${"acquisition-suppression-policy:" + workspaceId}, 0))::text AS "locked"`;
  assertExactDatabaseScalarReceipt(rows, "locked", "");
  return Object.freeze({ workspaceId, [POLICY_LOCK_RECEIPT]: tx });
}

export function assertWorkspaceSuppressionPolicyLock(
  receipt: SuppressionPolicyLockReceipt,
  workspaceId: string,
): void;
export function assertWorkspaceSuppressionPolicyLock(
  receipt: SuppressionPolicyLockReceipt,
  tx: Prisma.TransactionClient,
  workspaceId: string,
): void;
export function assertWorkspaceSuppressionPolicyLock(
  receipt: SuppressionPolicyLockReceipt,
  txOrWorkspaceId: Prisma.TransactionClient | string,
  requestedWorkspaceId?: string,
): void {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    types.isProxy(receipt)
  ) {
    throw new Error("workspace suppression policy lock receipt mismatch");
  }
  const workspace = Object.getOwnPropertyDescriptor(receipt, "workspaceId");
  const transaction = Object.getOwnPropertyDescriptor(
    receipt,
    POLICY_LOCK_RECEIPT,
  );
  const workspaceId =
    typeof txOrWorkspaceId === "string"
      ? txOrWorkspaceId
      : requestedWorkspaceId;
  const expectedTransaction =
    typeof txOrWorkspaceId === "string" ? undefined : txOrWorkspaceId;
  if (
    workspaceId === undefined ||
    !workspace ||
    !("value" in workspace) ||
    workspace.value !== workspaceId ||
    !transaction ||
    !("value" in transaction) ||
    (expectedTransaction !== undefined &&
      transaction.value !== expectedTransaction)
  ) {
    throw new Error("workspace suppression policy lock receipt mismatch");
  }
}
