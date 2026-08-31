import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
} from "./suppression-policy-lock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function transaction(rows: unknown = [{ locked: "" }]) {
  return {
    $queryRaw: vi.fn(async () => rows),
    $executeRaw: vi.fn(async () => {
      throw new Error("advisory locks use one typed queryRaw path");
    }),
  } as unknown as Prisma.TransactionClient;
}

describe("workspace suppression policy lock", () => {
  it("uses one typed transaction-scoped advisory-lock read and binds the receipt to the transaction", async () => {
    const tx = transaction();
    const receipt = await lockWorkspaceSuppressionPolicy(tx, WORKSPACE_ID);
    const queryRaw = tx.$queryRaw as ReturnType<typeof vi.fn>;
    const executeRaw = tx.$executeRaw as ReturnType<typeof vi.fn>;

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() =>
      assertWorkspaceSuppressionPolicyLock(receipt, tx, WORKSPACE_ID),
    ).not.toThrow();

    const otherTx = transaction();
    expect(() =>
      assertWorkspaceSuppressionPolicyLock(receipt, otherTx, WORKSPACE_ID),
    ).toThrow("workspace suppression policy lock receipt mismatch");
  });
});
