import type { Prisma } from "@prisma/client";
import { types } from "node:util";

const POLICY_LOCK_RECEIPT = Symbol("workspace-suppression-policy-lock");

export type SuppressionPolicyLockReceipt = Readonly<{
  workspaceId: string;
  [POLICY_LOCK_RECEIPT]: Prisma.TransactionClient;
}>;

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
  await tx.$queryRaw<readonly { locked: string }[]>`
    SELECT pg_advisory_xact_lock(hashtextextended(${"acquisition-suppression-policy:" + workspaceId}, 0))::text AS "locked"`;
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
