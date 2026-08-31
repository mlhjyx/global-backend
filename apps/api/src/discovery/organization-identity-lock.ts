import type { Prisma } from "@prisma/client";
import { types } from "node:util";
import {
  assertExactDatabaseScalarReceipt,
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
  mapOrganizationIdentitySourceError,
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

async function prearmOrganizationIdentityTimeouts(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const lockTimeout: unknown = await tx.$queryRaw`
    SELECT set_config('lock_timeout', '5s', true)::text AS "lock_timeout"`;
  assertExactDatabaseScalarReceipt(lockTimeout, "lock_timeout", "5s");
  const statementTimeout: unknown = await tx.$queryRaw`
    SELECT set_config('statement_timeout', '60s', true)::text AS "statement_timeout"`;
  assertExactDatabaseScalarReceipt(
    statementTimeout,
    "statement_timeout",
    "1min",
  );
}

export async function lockWorkspaceSuppressionThenIdentity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<SuppressionThenIdentityLockReceipt> {
  try {
    await prearmOrganizationIdentityTimeouts(tx);
    const suppressionPolicyLock = await lockWorkspaceSuppressionPolicy(
      tx,
      workspaceId,
    );
    const identityLock: unknown = await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${
        "organization-identity:" + workspaceId
      }, 0))::text AS "locked"`;
    assertExactDatabaseScalarReceipt(identityLock, "locked", "");
    return Object.freeze({
      workspaceId,
      suppressionPolicyLock,
      [COMPOSITE_LOCK_RECEIPT]: tx,
    });
  } catch (error) {
    return mapOrganizationIdentitySourceError(error);
  }
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
