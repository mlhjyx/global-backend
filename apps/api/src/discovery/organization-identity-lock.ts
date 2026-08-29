import type { Prisma } from "@prisma/client";
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
  [COMPOSITE_LOCK_RECEIPT]: true;
}>;

export async function lockWorkspaceSuppressionThenIdentity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<SuppressionThenIdentityLockReceipt> {
  const suppressionPolicyLock = await lockWorkspaceSuppressionPolicy(
    tx,
    workspaceId,
  );
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${
      "organization-identity:" + workspaceId
    }, 0))::text AS "locked"`;
  return Object.freeze({
    workspaceId,
    suppressionPolicyLock,
    [COMPOSITE_LOCK_RECEIPT]: true as const,
  });
}

export function assertWorkspaceSuppressionThenIdentityLock(
  receipt: SuppressionThenIdentityLockReceipt,
  workspaceId: string,
): void {
  if (
    receipt?.[COMPOSITE_LOCK_RECEIPT] !== true ||
    receipt.workspaceId !== workspaceId
  ) {
    throw new Error("organization identity lock receipt mismatch");
  }
  assertWorkspaceSuppressionPolicyLock(
    receipt.suppressionPolicyLock,
    workspaceId,
  );
}
