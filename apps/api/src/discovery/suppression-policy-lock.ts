import type { Prisma } from '@prisma/client';

const POLICY_LOCK_RECEIPT = Symbol('workspace-suppression-policy-lock');

export type SuppressionPolicyLockReceipt = Readonly<{
  workspaceId: string;
  [POLICY_LOCK_RECEIPT]: true;
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
  // pg_advisory_xact_lock returns PostgreSQL void, which Prisma 6 cannot
  // deserialize directly. Cast it to text while preserving the existing
  // query contract used by suppression transaction fakes and callers.
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${'acquisition-suppression-policy:' + workspaceId}, 0))::text AS locked`;
  return Object.freeze({ workspaceId, [POLICY_LOCK_RECEIPT]: true as const });
}

export function assertWorkspaceSuppressionPolicyLock(
  receipt: SuppressionPolicyLockReceipt,
  workspaceId: string,
): void {
  if (receipt?.[POLICY_LOCK_RECEIPT] !== true || receipt.workspaceId !== workspaceId) {
    throw new Error('workspace suppression policy lock receipt mismatch');
  }
}
