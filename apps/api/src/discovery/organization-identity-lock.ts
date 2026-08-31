import type { Prisma } from "@prisma/client";
import { types } from "node:util";
import {
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
  type SuppressionPolicyLockReceipt,
} from "./suppression-policy-lock";

const COMPOSITE_LOCK_RECEIPT = Symbol(
  "workspace-suppression-then-identity-lock",
);

export type SuppressionThenIdentityLockReceipt = Readonly<{
  workspaceId: string;
  suppressionPolicyLock: SuppressionPolicyLockReceipt;
  [COMPOSITE_LOCK_RECEIPT]: Prisma.TransactionClient;
}>;

function requireScalarReceipt(
  rows: unknown,
  key: string,
  expected: string,
  message: string,
): void {
  if (
    rows === null ||
    typeof rows !== "object" ||
    types.isProxy(rows) ||
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    Reflect.ownKeys(rows).some(
      (candidate) => !["0", "length"].includes(String(candidate)),
    )
  ) {
    throw new Error(message);
  }
  const item = Object.getOwnPropertyDescriptor(rows, "0");
  const row = item && "value" in item ? item.value : null;
  if (
    row === null ||
    typeof row !== "object" ||
    types.isProxy(row) ||
    Array.isArray(row) ||
    Object.getPrototypeOf(row) !== Object.prototype
  ) {
    throw new Error(message);
  }
  const keys = Reflect.ownKeys(row);
  const value = Object.getOwnPropertyDescriptor(row, key);
  if (
    keys.length !== 1 ||
    keys[0] !== key ||
    !value ||
    !value.enumerable ||
    !("value" in value) ||
    value.value !== expected
  ) {
    throw new Error(message);
  }
}

async function prearmOrganizationIdentityTimeouts(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const lockTimeout: unknown = await tx.$queryRaw`
    SELECT set_config('lock_timeout', '5s', true)::text AS "lock_timeout"`;
  requireScalarReceipt(
    lockTimeout,
    "lock_timeout",
    "5s",
    "organization identity timeout prearm failed",
  );
  const statementTimeout: unknown = await tx.$queryRaw`
    SELECT set_config('statement_timeout', '60s', true)::text AS "statement_timeout"`;
  requireScalarReceipt(
    statementTimeout,
    "statement_timeout",
    "1min",
    "organization identity timeout prearm failed",
  );
}

export async function lockWorkspaceSuppressionThenIdentity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<SuppressionThenIdentityLockReceipt> {
  await prearmOrganizationIdentityTimeouts(tx);
  const suppressionPolicyLock = await lockWorkspaceSuppressionPolicy(
    tx,
    workspaceId,
  );
  const identityLock: unknown = await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${
      "organization-identity:" + workspaceId
    }, 0))::text AS "locked"`;
  requireScalarReceipt(
    identityLock,
    "locked",
    "",
    "organization identity lock failed",
  );
  return Object.freeze({
    workspaceId,
    suppressionPolicyLock,
    [COMPOSITE_LOCK_RECEIPT]: tx,
  });
}

export function assertWorkspaceSuppressionThenIdentityLock(
  receipt: SuppressionThenIdentityLockReceipt,
  tx: Prisma.TransactionClient,
  workspaceId: string,
): void {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    types.isProxy(receipt)
  ) {
    throw new Error("organization identity lock receipt mismatch");
  }
  const workspace = Object.getOwnPropertyDescriptor(receipt, "workspaceId");
  const transaction = Object.getOwnPropertyDescriptor(
    receipt,
    COMPOSITE_LOCK_RECEIPT,
  );
  const suppression = Object.getOwnPropertyDescriptor(
    receipt,
    "suppressionPolicyLock",
  );
  if (
    !workspace ||
    !("value" in workspace) ||
    workspace.value !== workspaceId ||
    !transaction ||
    !("value" in transaction) ||
    transaction.value !== tx ||
    !suppression ||
    !("value" in suppression)
  ) {
    throw new Error("organization identity lock receipt mismatch");
  }
  assertWorkspaceSuppressionPolicyLock(
    suppression.value as SuppressionPolicyLockReceipt,
    tx,
    workspaceId,
  );
}
