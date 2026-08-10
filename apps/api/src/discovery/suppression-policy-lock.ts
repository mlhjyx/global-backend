import type { Prisma } from '@prisma/client';

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
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${'acquisition-suppression-policy:' + workspaceId}, 0))`;
}
